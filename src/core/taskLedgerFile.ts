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
 *    fails if the lock exists, so a lock never exists without its record;
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
 * milliseconds while its writer is alive.
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
 * Only a lock that cannot be checked is judged by age: a lock from another host, or one with no readable
 * record, is stale after `staleMs`; a lock on this host whose holder is running but whose start time cannot
 * be compared (a record without one, or a start time this process cannot read) is stale after
 * `liveStaleMs`, far longer than any real update.
 *
 * The lock is advisory. A writer that edits tasks.json without this function, such as an agent with a
 * file-edit tool, is not serialized with the others; the rename only means no reader sees a torn file.
 *
 * Writing never commits: committing the hive repository stays with the app.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mergeTaskLedger } from './taskLedger';

export interface TaskLedgerFileOptions {
  /** Clock for the `updatedAt` stamp mergeTaskLedger puts on changed cards. */
  now?: () => Date;
  /** How long to wait for another holder before giving up. Default 5 s. */
  waitMs?: number;
  /** A lock from another host, or with no readable record, is stale after this. Default 30 s. */
  staleMs?: number;
  /**
   * A lock whose holder on this host is running, but whose start time cannot be compared with the one in
   * the record, is stale after this. A holder whose start time matches is never stale. Default 5 min.
   */
  liveStaleMs?: number;
  /** Pause between attempts to take the lock. Default 20 ms. */
  retryMs?: number;
  /**
   * A ledger that is not valid JSON, or is valid JSON but not an object whose `tasks`, if present, is a
   * list: refuse ('throw', the default), or treat it as empty ('empty').
   */
  unreadable?: 'throw' | 'empty';
  /** Called between the steps of taking the lock, so a test can interleave writers. Not for production use. */
  hooks?: TaskLedgerLockHooks;
}

/** Points inside lock acquisition where a test can pause one writer while another runs. */
export interface TaskLedgerLockHooks {
  /** A lock was judged stale and is about to be broken. */
  beforeBreak?: () => void;
  /** The writer is about to make the lock its own, carrying its record. */
  beforeLockRecorded?: () => void;
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

interface LockRecord { pid?: unknown; host?: unknown; started?: unknown; acquiredAt?: unknown; token?: unknown }

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

/** The lock as read at one moment: its record, its age, and the file it was read from (`dev`/`ino`). */
interface HeldLock { record: LockRecord | null; ageMs: number; dev: number; ino: number }

function readLock(lock: string): HeldLock | null {
  let fd: number;
  try { fd = openSync(lock, 'r'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const stat = fstatSync(fd);
    const text = readFileSync(fd, 'utf8');
    let record: LockRecord | null = null;
    try { record = JSON.parse(text) as LockRecord; } catch { record = null; }
    const acquired = record && typeof record.acquiredAt === 'string' ? Date.parse(record.acquiredAt) : NaN;
    // A lock with no readable record (one left by an older writer, or damaged): judge it by its mtime.
    const since = Number.isFinite(acquired) ? acquired : stat.mtimeMs;
    return { record, ageMs: Date.now() - since, dev: stat.dev, ino: stat.ino };
  } finally {
    closeSync(fd);
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * When process `pid` started, as a string no later process with the same pid can have, or null when it
 * cannot be read. Two values are comparable only when read the same way, so each carries its method:
 *
 *  - Linux: `proc:` and field 22 of /proc/<pid>/stat, the start time in clock ticks after boot. Exact.
 *  - Other Unix (macOS, BSD): `ps:` and `ps -o lstart= -p <pid>`, the start time to the second, run with
 *    LC_ALL=C and TZ=UTC so every process on the host formats it alike. A pid reused within the same
 *    second as the process it replaced started would read alike; that needs the first process to have
 *    lived under a second and its pid to come round again in that second.
 *
 * null (no /proc and no ps, as on Windows; a sandbox that hides the process from ps; the process gone)
 * means "cannot check", never "a different process".
 */
function processStart(pid: number): string | null {
  if (process.platform === 'win32') return null;
  if (process.platform === 'linux' && existsSync('/proc/self/stat')) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // The command name in field 2 is in parentheses and may contain spaces or ')'; the fields after it don't.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const ticks = fields[22 - 3];
      return ticks && /^\d+$/.test(ticks) ? `proc:${ticks}` : null;
    } catch {
      return null;
    }
  }
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env: { PATH: '/bin:/usr/bin', LC_ALL: 'C', TZ: 'UTC' },
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000
    }).toString().trim();
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

let ownStart: string | null | undefined;
/** This process's start time, read once. */
function ownProcessStart(): string | null {
  if (ownStart === undefined) ownStart = processStart(process.pid);
  return ownStart;
}

/** Whether running process `pid` is the one that recorded `started`: null when that cannot be told. */
function sameProcess(pid: number, started: unknown): boolean | null {
  if (typeof started !== 'string') return null;
  const now = processStart(pid);
  if (now === null) return null;
  const method = (value: string): string => value.slice(0, value.indexOf(':') + 1);
  if (method(now) !== method(started)) return null;
  return now === started;
}

interface StaleBounds { staleMs: number; liveStaleMs: number }

/**
 * `owners` remembers, for the length of one wait, whether a recorded holder is still the process that wrote
 * it, so a waiter does not read a start time on every retry. A holder that exits meanwhile is still seen at
 * once, because whether the pid is alive is asked every time.
 */
function isStale(lock: HeldLock, bounds: StaleBounds, owners: Map<string, boolean | null>): boolean {
  const { record } = lock;
  if (!record || record.host !== hostname() || typeof record.pid !== 'number') return lock.ageMs > bounds.staleMs;
  if (!alive(record.pid)) return true;
  // A fresh lock with a running holder is never broken, so there is no need yet to ask which process it is.
  if (lock.ageMs <= bounds.staleMs) return false;
  const key = `${record.pid} ${String(record.started)}`;
  if (!owners.has(key)) owners.set(key, sameProcess(record.pid, record.started));
  const same = owners.get(key);
  if (same === true) return false;
  if (same === false) return true;
  return lock.ageMs > bounds.liveStaleMs;
}

function describe(held: HeldLock | null): string {
  const record = held?.record;
  if (!held || !record) return 'a holder that has not written its record yet';
  const seconds = Math.max(0, Math.round(held.ageMs / 1000));
  return `pid ${String(record.pid)} on ${String(record.host)}, held for ${seconds} s (since ${String(record.acquiredAt)})`;
}

/**
 * Removes a stale lock without removing a fresh one another writer took in the meantime: the lock is
 * renamed aside first, and put back if what was renamed is not the very file judged stale. Files are
 * compared by device and inode, never by content: two locks can have the same content, one file cannot
 * be two locks. Returns whether the stale lock was removed; when it was not, the caller must not take the
 * lock straight away, because the lock it saw may belong to a live holder.
 */
function breakStale(lock: string, judged: HeldLock): boolean {
  const aside = `${lock}.stale-${randomBytes(6).toString('hex')}`;
  try { renameSync(lock, aside); } catch { return false; }
  const moved = statSync(aside, { throwIfNoEntry: false });
  if (moved && moved.dev === judged.dev && moved.ino === judged.ino) {
    try { unlinkSync(aside); } catch { /* already gone */ }
    return true;
  }
  // A newer holder's lock: put it back. If yet another writer took the name in the meantime this fails,
  // and the newer holder finds before it writes that the lock is no longer its own.
  try { linkSync(aside, lock); } catch { /* the name was taken again */ }
  try { unlinkSync(aside); } catch { /* already gone */ }
  return false;
}

/** The lock this writer holds: its token, and the file it created (`dev`/`ino`). */
interface OwnLock { token: string; dev: number; ino: number }

function acquire(
  lock: string,
  opts: Required<Pick<TaskLedgerFileOptions, 'waitMs' | 'staleMs' | 'liveStaleMs' | 'retryMs'>> & { hooks: TaskLedgerLockHooks }
): OwnLock {
  const token = randomBytes(12).toString('hex');
  const started = ownProcessStart();
  const body = JSON.stringify({ pid: process.pid, host: hostname(), ...(started === null ? {} : { started }), acquiredAt: new Date().toISOString(), token });
  // A monotonic clock: a wall-clock step back would stretch the wait, a step forward would cut it short.
  const deadline = performance.now() + opts.waitMs;
  let last: HeldLock | null = null;
  const owners = new Map<string, boolean | null>();
  const tmp = join(dirname(lock), `.${basename(lock)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, body, { flag: 'wx' });
  const { dev, ino } = statSync(tmp);
  try {
    for (;;) {
      opts.hooks.beforeLockRecorded?.();
      try {
        linkSync(tmp, lock);
        return { token, dev, ino };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const held = readLock(lock);
      if (held) {
        last = held;
        if (isStale(held, opts, owners)) {
          opts.hooks.beforeBreak?.();
          if (breakStale(lock, held)) continue;
        }
      }
      if (performance.now() >= deadline) {
        const here = last?.record?.host === hostname();
        throw new TaskLedgerLockTimeout(lock, opts.waitMs, `${describe(last)}${here ? '; if that process is stuck, stopping it frees the lock' : ''}`);
      }
      sleep(opts.retryMs);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Throws TaskLedgerLockLost unless the lock is still the file this writer created, with its token. */
function confirmOwn(lock: string, own: OwnLock): void {
  const held = readLock(lock);
  if (held && held.record?.token === own.token && held.dev === own.dev && held.ino === own.ino) return;
  throw new TaskLedgerLockLost(lock, held ? describe(held) : 'no lock');
}

function release(lock: string, own: OwnLock): void {
  try { confirmOwn(lock, own); } catch { return; }
  try { unlinkSync(lock); } catch { /* already gone */ }
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
  if (unreadable === 'empty') return {};
  const shape = isObject ? '"tasks" is not a list' : 'it is not an object';
  throw new Error(`${path} is not a task ledger (${shape}), so it was left as it is`);
}

/**
 * Writes all of `text` to `fd`. A write to a regular file may complete only part of what it was given and
 * report how much; the rest is written by further calls. A call that writes nothing would loop for ever,
 * so it is an error. The file's size is then checked against what was meant to be written.
 */
function writeFully(fd: number, path: string, text: string): void {
  const bytes = Buffer.from(text, 'utf8');
  let done = 0;
  while (done < bytes.length) {
    const wrote = writeSync(fd, bytes, done, bytes.length - done);
    if (!(wrote > 0)) throw new Error(`writing ${path} stopped after ${done} of ${bytes.length} bytes, so it was left as it was`);
    done += wrote;
  }
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
  const own = acquire(lock, {
    waitMs: options.waitMs ?? 5_000,
    staleMs: options.staleMs ?? 30_000,
    liveStaleMs: options.liveStaleMs ?? 300_000,
    retryMs: options.retryMs ?? 20,
    hooks
  });
  try {
    sweepLeftovers(path);
    const ledger = readLedger(path, options.unreadable ?? 'throw');
    const current = Array.isArray(ledger.tasks) ? ledger.tasks : [];
    const next = mutate(current.slice());
    if (next === null) return null;
    const merged = mergeTaskLedger(current, next, (options.now ?? (() => new Date()))().toISOString());
    writeAtomically(path, JSON.stringify({ ...ledger, tasks: merged }, null, 2), () => {
      confirmOwn(lock, own);
      hooks.afterOwnershipCheck?.();
    });
    return merged;
  } finally {
    release(lock, own);
  }
}
