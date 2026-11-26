/**
 * Read-modify-write of the task ledger file (`hive/tasks.json`) for more than one writer process.
 *
 * Several processes may edit the ledger: the app, and services that run beside it. A plain read, edit and
 * write from two of them at once loses whichever write lands first, and a file written in place can be read
 * half-written. So every update here:
 *
 *  - takes an exclusive lock file next to the ledger (`tasks.json.lock`, holding the holder's pid, host,
 *    process start time, acquisition time and a random token), waiting a bounded time for a holder to
 *    finish. The record is written to a temporary file first and hard-linked to the lock's name, which
 *    fails if the lock exists, so a lock never exists without its record. On a volume that cannot make hard
 *    links, nothing is written and the error says so;
 *  - re-reads the ledger UNDER the lock, applies the caller's edit to that, and folds the result over the
 *    on-disk cards with mergeTaskLedger, so fields the caller does not model survive;
 *  - writes a temporary file in the same folder, fsyncs it and renames it over the ledger, so a reader sees
 *    the old file or the new one, never a partial one. Just before the rename it checks that the lock is
 *    still its own (same token, same file); if it was broken meanwhile, it writes nothing and throws
 *    TaskLedgerLockLost;
 *  - releases the lock, if it is still its own, whatever happened.
 *
 * Holding the lock, it also removes files that a writer which died part-way left beside the ledger: its
 * temporary ledger (`.tasks.json.tmp-*`), its temporary lock (`.tasks.json.lock.tmp-*`) and a lock it had
 * set aside to break (`tasks.json.lock.stale-*`), once they are a minute old. Each of these exists for
 * milliseconds while its writer is alive, except a temporary lock, which a writer keeps while it waits for
 * the lock, so one is kept while the pid in its name is running.
 *
 * A lock is stale, and is broken, when its holder on this host has exited. A holder on this host that is
 * still running is never broken, however old its lock: it may be slow (stopped in a debugger, a sleeping
 * laptop, a stalled disk) and would go on to write after its lock was broken. Its ownership check and its
 * rename are two separate steps, so a holder paused between them would rename its ledger over the one
 * written by whoever broke its lock, and that writer's card would be lost although both reported success.
 * "Still running" means that exact process: the record carries the holder's start time (see processStart),
 * and a running process with the recorded pid but a different start time is a later process that reused
 * the pid, so the lock is broken. A live holder that never finishes keeps the lock; every waiter then times
 * out with an error naming it (pid, host, how long it has held the lock), and stopping that process frees it.
 *
 * A holder on this host whose pid is running but whose start time cannot be compared is also taken to be
 * alive, however old its lock: the start time is used only to prove that a pid was reused, which needs a
 * start time in the record and one read now, by the same method. A process in a sandbox (macOS Seatbelt,
 * for one) usually has neither: kill(pid, 0) fails with EPERM, so the pid exists, but ps cannot be run or
 * does not show the process, and the records such a process writes carry no start time. Judging those
 * locks by age would let a sandboxed writer break the lock of a live writer outside the sandbox, or the
 * other way round, and both would write. The cost is that a pid reused by an unrelated process keeps the
 * lock held; the timeout error then says that deleting the lock file by hand frees it.
 *
 * Only a lock whose holder cannot be identified is judged by age: a lock from another host, or one with no
 * readable record or no pid in it, is stale after `staleMs`.
 *
 * The lock is advisory. A writer that edits tasks.json without this function, such as an agent with a
 * file-edit tool, is not serialized with the others; the rename only means no reader sees a torn file.
 *
 * Writing never commits: committing the hive repository stays with the app.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { acquireFileLock, alive, confirmFileLock, defaultStartTime, releaseFileLock, type FileLockHooks } from './fileLock';
import { mergeTaskLedger } from './taskLedger';

export interface TaskLedgerFileOptions {
  /** Clock for the `updatedAt` stamp mergeTaskLedger puts on changed cards. */
  now?: () => Date;
  /** How long to wait for another holder before giving up. Default 5 s. */
  waitMs?: number;
  /** A lock from another host, or with no readable record, is stale after this. Default 30 s. */
  staleMs?: number;
  /** Pause between attempts to take the lock. Default 20 ms. */
  retryMs?: number;
  /**
   * A ledger that is not valid JSON: refuse ('throw', the default), or treat it as empty ('empty'). Valid
   * JSON that is not an object whose `tasks`, if present, is a list is always refused: it may hold cards
   * in a shape this code cannot read, which an empty ledger would replace.
   */
  unreadable?: 'throw' | 'empty';
  /**
   * When process `pid` started, or null when that cannot be read within `timeoutMs`. Used for this writer's
   * own record and to check a holder's. Default: processStart, from /proc or ps. A test can make it fail or
   * hang. Not for production use.
   */
  startTime?: (pid: number, timeoutMs: number) => string | null;
  /** Makes the hard link that takes the lock. Default fs.linkSync; a test can refuse it. Not for production use. */
  link?: (existingPath: string, newPath: string) => void;
  /** Called between the steps of taking the lock, so a test can interleave writers. Not for production use. */
  hooks?: TaskLedgerLockHooks;
}

/** Points inside lock acquisition where a test can pause one writer while another runs. */
export interface TaskLedgerLockHooks extends FileLockHooks {
  /** The writer found the lock still its own and is about to rename its new ledger into place. */
  afterOwnershipCheck?: () => void;
}

/** The lock stayed held by a live, fresh holder for the whole wait. */
export class TaskLedgerLockTimeout extends Error {
  constructor(lock: string, waitedMs: number, holder: string) {
    super(`could not lock ${lock} within ${waitedMs} ms: held by ${holder}`);
    this.name = 'TaskLedgerLockTimeout';
  }
}

/** The lock was broken and taken by another writer while this one held it, so nothing was written. */
export class TaskLedgerLockLost extends Error {
  constructor(lock: string, holder: string) {
    super(`${lock} no longer holds this writer's record (now ${holder}), so tasks.json was not written`);
    this.name = 'TaskLedgerLockLost';
  }
}

const LEFTOVER_MS = 60_000;

function sweepLeftovers(path: string): void {
  const dir = dirname(path);
  const name = basename(path);
  const prefixes = [`.${name}.tmp-`, `.${name}.lock.tmp-`, `${name}.lock.stale-`];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - LEFTOVER_MS;
  for (const entry of entries) {
    if (!prefixes.some((prefix) => entry.startsWith(prefix))) continue;
    // A writer waiting for the lock keeps its record in `.tasks.json.lock.tmp-<pid>-*` for as long as it
    // waits, which can be longer than a minute: spare it while that pid is running.
    const waiter = entry.startsWith(`.${name}.lock.tmp-`) ? Number(entry.slice(`.${name}.lock.tmp-`.length).split('-')[0]) : NaN;
    if (Number.isInteger(waiter) && waiter > 0 && alive(waiter)) continue;
    const file = join(dir, entry);
    try {
      const stat = lstatSync(file);
      if (stat.isFile() && stat.mtimeMs < cutoff) unlinkSync(file);
    } catch { /* gone already, or not ours to remove */ }
  }
}

function readLedger(path: string, unreadable: 'throw' | 'empty'): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) {
    if (unreadable === 'empty') return {};
    throw new Error(`${path} is not valid JSON, so it was left as it is: ${(e as Error).message}`);
  }
  // Valid JSON that is not { tasks: [...] } holds cards this code cannot see (a bare list of cards, say).
  // Edited as if empty, it would be replaced by a ledger holding only the edit.
  const isObject = !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  const ledger = parsed as Record<string, unknown>;
  if (isObject && (!('tasks' in ledger) || Array.isArray(ledger.tasks))) return ledger;
  const shape = isObject ? '"tasks" is not a list' : 'it is not an object';
  throw new Error(`${path} is not a task ledger (${shape}), so it was left as it is`);
}

/**
 * Writes all of `bytes` to `fd` at its current position. A write to a regular file may complete only part of
 * what it was given and report how much; the rest is written by further calls. A call that writes nothing
 * would loop for ever, so it is an error, naming how far the write got. `write` is fs.writeSync unless a test
 * gives another.
 */
export function writeAllSync(fd: number, path: string, bytes: Buffer, write: typeof writeSync = writeSync): void {
  let done = 0;
  while (done < bytes.length) {
    const wrote = write(fd, bytes, done, bytes.length - done);
    if (!(wrote > 0)) throw new Error(`writing ${path} stopped after ${done} of ${bytes.length} bytes, so it was left as it was`);
    done += wrote;
  }
}

/**
 * Writes all of `text` to `fd` (writeAllSync). The file's size is then checked against what was meant to be
 * written.
 */
function writeFully(fd: number, path: string, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  writeAllSync(fd, path, bytes);
  const size = fstatSync(fd).size;
  if (size !== bytes.length) throw new Error(`${path} would be ${size} bytes instead of ${bytes.length}, so it was left as it was`);
}

function writeAtomically(path: string, text: string, beforeRename: () => void): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'wx');
    try {
      // The new file replaces the old one, so it takes the old one's permissions rather than the defaults.
      const existing = statSync(path, { throwIfNoEntry: false });
      if (existing) fchmodSync(fd, existing.mode & 0o7777);
      writeFully(fd, path, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    beforeRename();
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* never created, or already renamed */ }
    throw e;
  }
  try {
    const dir = openSync(dirname(path), 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch { /* not every platform can fsync a folder; the rename itself has happened */ }
}

/**
 * Applies `mutate` to the ledger's current cards under the ledger's lock and writes the result.
 *
 * `mutate` gets the cards as they are on disk now and returns the new list, which is the new membership:
 * a card left out is deleted. Each returned card is merged over its on-disk version by id, so fields the
 * caller does not know about are kept. Returning null writes nothing. Other top-level keys of the file are
 * kept, and it is written as two-space JSON. Returns the cards written, or null when nothing was.
 */
export function updateTaskLedgerFile(
  path: string,
  mutate: (currentTasks: unknown[]) => unknown[] | null,
  options: TaskLedgerFileOptions = {}
): unknown[] | null {
  const lock = `${path}.lock`;
  const hooks = options.hooks ?? {};
  const own = acquireFileLock(lock, {
    waitMs: options.waitMs ?? 5_000,
    staleMs: options.staleMs ?? 30_000,
    retryMs: options.retryMs ?? 20,
    startTime: options.startTime ?? defaultStartTime,
    link: options.link ?? linkSync,
    hooks,
    name: 'tasks.json',
    disabled: 'task ledger writes',
    timeout: (l, waitedMs, holder) => new TaskLedgerLockTimeout(l, waitedMs, holder),
  });
  try {
    sweepLeftovers(path);
    const ledger = readLedger(path, options.unreadable ?? 'throw');
    const current = Array.isArray(ledger.tasks) ? ledger.tasks : [];
    const next = mutate(current.slice());
    if (next === null) return null;
    const merged = mergeTaskLedger(current, next, (options.now ?? (() => new Date()))().toISOString());
    writeAtomically(path, JSON.stringify({ ...ledger, tasks: merged }, null, 2), () => {
      confirmFileLock(lock, own, (l, holder) => new TaskLedgerLockLost(l, holder));
      hooks.afterOwnershipCheck?.();
    });
    return merged;
  } finally {
    releaseFileLock(lock, own);
  }
}
