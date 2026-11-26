/**
 * Read-modify-write of the task ledger file (`hive/tasks.json`) for more than one writer process.
 *
 * Several processes may edit the ledger: the app, and services that run beside it. A plain read, edit and
 * write from two of them at once loses whichever write lands first, and a file written in place can be read
 * half-written. So every update here:
 *
 *  - takes an exclusive lock file next to the ledger (`tasks.json.lock`, holding the holder's pid, host,
 *    acquisition time and a random token), waiting a bounded time for a holder to finish. The record is
 *    written to a temporary file first and hard-linked to the lock's name, which fails if the lock exists,
 *    so a lock never exists without its record;
 *  - re-reads the ledger UNDER the lock, applies the caller's edit to that, and folds the result over the
 *    on-disk cards with mergeTaskLedger, so fields the caller does not model survive;
 *  - writes a temporary file in the same folder, fsyncs it and renames it over the ledger, so a reader sees
 *    the old file or the new one, never a partial one. Just before the rename it checks that the lock is
 *    still its own (same token, same file); if it was broken meanwhile, it writes nothing and throws
 *    TaskLedgerLockLost;
 *  - releases the lock, if it is still its own, whatever happened.
 *
 * A lock is stale, and is broken, when its holder on this host has exited. A holder on this host that is
 * still running is never judged by `staleMs`: it may be slow (stopped in a debugger, a sleeping laptop, a
 * stalled disk, a wall-clock step) and would go on to write after its lock was broken. Only after
 * `liveStaleMs`, far longer than any real update, is such a lock broken, because by then the pid has more
 * likely been reused by an unrelated process. A lock from another host, or one with no readable record,
 * can only be judged by age, and is stale after `staleMs`.
 *
 * The lock is advisory. A writer that edits tasks.json without this function, such as an agent with a
 * file-edit tool, is not serialized with the others; the rename only means no reader sees a torn file.
 *
 * Writing never commits: committing the hive repository stays with the app.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
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
  /** A lock whose holder on this host is still running is stale only after this (pid reuse). Default 5 min. */
  liveStaleMs?: number;
  /** Pause between attempts to take the lock. Default 20 ms. */
  retryMs?: number;
  /** A ledger that is not valid JSON: refuse ('throw', the default), or treat it as empty ('empty'). */
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

interface LockRecord { pid?: unknown; host?: unknown; acquiredAt?: unknown; token?: unknown }

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

function isStale(lock: HeldLock, staleMs: number, liveStaleMs: number): boolean {
  const { record } = lock;
  if (!record || record.host !== hostname() || typeof record.pid !== 'number') return lock.ageMs > staleMs;
  return !alive(record.pid) || lock.ageMs > liveStaleMs;
}

function describe(record: LockRecord | null): string {
  if (!record) return 'a holder that has not written its record yet';
  return `pid ${String(record.pid)} on ${String(record.host)} since ${String(record.acquiredAt)}`;
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
  const body = JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: new Date().toISOString(), token });
  const deadline = Date.now() + opts.waitMs;
  let last: LockRecord | null = null;
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
        last = held.record;
        if (isStale(held, opts.staleMs, opts.liveStaleMs)) {
          opts.hooks.beforeBreak?.();
          if (breakStale(lock, held)) continue;
        }
      }
      if (Date.now() >= deadline) throw new TaskLedgerLockTimeout(lock, opts.waitMs, describe(last));
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
  throw new TaskLedgerLockLost(lock, held ? describe(held.record) : 'no lock');
}

function release(lock: string, own: OwnLock): void {
  try { confirmOwn(lock, own); } catch { return; }
  try { unlinkSync(lock); } catch { /* already gone */ }
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

function writeAtomically(path: string, text: string, beforeRename: () => void): void {
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  try {
    const fd = openSync(tmp, 'wx');
    try {
      writeSync(fd, text);
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
  const own = acquire(lock, {
    waitMs: options.waitMs ?? 5_000,
    staleMs: options.staleMs ?? 30_000,
    liveStaleMs: options.liveStaleMs ?? 300_000,
    retryMs: options.retryMs ?? 20,
    hooks: options.hooks ?? {}
  });
  try {
    const ledger = readLedger(path, options.unreadable ?? 'throw');
    const current = Array.isArray(ledger.tasks) ? ledger.tasks : [];
    const next = mutate(current.slice());
    if (next === null) return null;
    const merged = mergeTaskLedger(current, next, (options.now ?? (() => new Date()))().toISOString());
    writeAtomically(path, JSON.stringify({ ...ledger, tasks: merged }, null, 2), () => confirmOwn(lock, own));
    return merged;
  } finally {
    release(lock, own);
  }
}
