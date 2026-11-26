/**
 * Read-modify-write of the task ledger file (`hive/tasks.json`) for more than one writer process.
 *
 * Several processes may edit the ledger: the app, and services that run beside it. A plain read, edit and
 * write from two of them at once loses whichever write lands first, and a file written in place can be read
 * half-written. So every update here:
 *
 *  - takes an exclusive lock file next to the ledger (`tasks.json.lock`, created with O_EXCL, holding the
 *    holder's pid, host and acquisition time), waiting a bounded time for a holder to finish;
 *  - re-reads the ledger UNDER the lock, applies the caller's edit to that, and folds the result over the
 *    on-disk cards with mergeTaskLedger, so fields the caller does not model survive;
 *  - writes a temporary file in the same folder, fsyncs it and renames it over the ledger, so a reader sees
 *    the old file or the new one, never a partial one;
 *  - releases the lock, if it is still its own, whatever happened.
 *
 * A lock is stale, and is broken, when its holder on this host has exited, or when it is older than
 * `staleMs` (a holder on another host can only be judged by age).
 *
 * The lock is advisory. A writer that edits tasks.json without this function, such as an agent with a
 * file-edit tool, is not serialized with the others; the rename only means no reader sees a torn file.
 *
 * Writing never commits: committing the hive repository stays with the app.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { mergeTaskLedger } from './taskLedger';

export interface TaskLedgerFileOptions {
  /** Clock for the `updatedAt` stamp mergeTaskLedger puts on changed cards. */
  now?: () => Date;
  /** How long to wait for another holder before giving up. Default 5 s. */
  waitMs?: number;
  /** A lock older than this is stale whoever holds it. Default 30 s. */
  staleMs?: number;
  /** Pause between attempts to take the lock. Default 20 ms. */
  retryMs?: number;
  /** A ledger that is not valid JSON: refuse ('throw', the default), or treat it as empty ('empty'). */
  unreadable?: 'throw' | 'empty';
}

/** The lock stayed held by a live, fresh holder for the whole wait. */
export class TaskLedgerLockTimeout extends Error {
  constructor(lock: string, waitedMs: number, holder: string) {
    super(`could not lock ${lock} within ${waitedMs} ms: held by ${holder}`);
    this.name = 'TaskLedgerLockTimeout';
  }
}

interface LockRecord { pid?: unknown; host?: unknown; acquiredAt?: unknown; token?: unknown }

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleep(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function readLock(lock: string): { record: LockRecord | null; text: string; ageMs: number } | null {
  try {
    const text = readFileSync(lock, 'utf8');
    let record: LockRecord | null = null;
    try { record = JSON.parse(text) as LockRecord; } catch { record = null; }
    const acquired = record && typeof record.acquiredAt === 'string' ? Date.parse(record.acquiredAt) : NaN;
    // A lock read between its creation and its first write has no record yet: judge it by its mtime.
    const since = Number.isFinite(acquired) ? acquired : statSync(lock).mtimeMs;
    return { record, text, ageMs: Date.now() - since };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
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

function isStale(lock: { record: LockRecord | null; ageMs: number }, staleMs: number): boolean {
  if (lock.ageMs > staleMs) return true;
  const { record } = lock;
  if (!record || record.host !== hostname() || typeof record.pid !== 'number') return false;
  return !alive(record.pid);
}

function describe(record: LockRecord | null): string {
  if (!record) return 'a holder that has not written its record yet';
  return `pid ${String(record.pid)} on ${String(record.host)} since ${String(record.acquiredAt)}`;
}

/**
 * Removes a stale lock without removing a fresh one another writer took in the meantime: the lock is
 * renamed aside first, and put back if what was renamed is not the lock judged stale.
 */
function breakStale(lock: string, judgedText: string): void {
  const aside = `${lock}.stale-${randomBytes(6).toString('hex')}`;
  try { renameSync(lock, aside); } catch { return; }
  let text = '';
  try { text = readFileSync(aside, 'utf8'); } catch { /* gone */ }
  if (text !== judgedText) {
    try { linkSync(aside, lock); } catch { /* a newer holder already took it */ }
  }
  try { unlinkSync(aside); } catch { /* already gone */ }
}

function acquire(lock: string, opts: Required<Pick<TaskLedgerFileOptions, 'waitMs' | 'staleMs' | 'retryMs'>>): string {
  const token = randomBytes(12).toString('hex');
  const body = JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), token });
  const deadline = Date.now() + opts.waitMs;
  let last: LockRecord | null = null;
  for (;;) {
    try {
      const fd = openSync(lock, 'wx');
      try { writeSync(fd, body); } finally { closeSync(fd); }
      return token;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const held = readLock(lock);
    if (held) {
      last = held.record;
      if (isStale(held, opts.staleMs)) { breakStale(lock, held.text); continue; }
    }
    if (Date.now() >= deadline) throw new TaskLedgerLockTimeout(lock, opts.waitMs, describe(last));
    sleep(opts.retryMs);
  }
}

function release(lock: string, token: string): void {
  const held = readLock(lock);
  if (held?.record?.token === token) {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

function readLedger(path: string, unreadable: 'throw' | 'empty'): Record<string, unknown> {
  let text: string;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch (e) {
    if (unreadable === 'empty') return {};
    throw new Error(`${path} is not valid JSON, so it was left as it is: ${(e as Error).message}`);
  }
}

function writeAtomically(path: string, text: string): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'wx');
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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
  const token = acquire(lock, {
    waitMs: options.waitMs ?? 5_000,
    staleMs: options.staleMs ?? 30_000,
    retryMs: options.retryMs ?? 20
  });
  try {
    const ledger = readLedger(path, options.unreadable ?? 'throw');
    const current = Array.isArray(ledger.tasks) ? ledger.tasks : [];
    const next = mutate(current.slice());
    if (next === null) return null;
    const merged = mergeTaskLedger(current, next, (options.now ?? (() => new Date()))().toISOString());
    writeAtomically(path, JSON.stringify({ ...ledger, tasks: merged }, null, 2));
    return merged;
  } finally {
    release(lock, token);
  }
}
