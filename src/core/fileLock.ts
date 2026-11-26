/**
 * An exclusive lock file for one writer at a time across processes: the lock taken around every update of
 * `hive/tasks.json` (taskLedgerFile.ts, whose header gives the rules this keeps), usable for any file.
 *
 * The lock holds its holder's pid, host, process start time, acquisition time and a random token, and is
 * created by hard-linking a complete record to its name, so it never exists without its record. A holder on
 * this host that is still running (the same process, by start time where that can be read) is never broken,
 * however old its lock; one that has exited is. A lock whose holder cannot be identified is stale after
 * `staleMs`. A stale lock is renamed aside and removed only if it is still the very file judged stale (device,
 * inode and token); otherwise it is put back. A volume that cannot make hard links cannot hold this lock, so
 * taking it fails there, saying so. A holder confirms the lock is still its own (confirmFileLock) immediately
 * before it writes.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fstatSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Points inside lock acquisition where a test can pause one writer while another runs. */
export interface FileLockHooks {
  /** A lock was judged stale and is about to be broken. */
  beforeBreak?: () => void;
  /** The writer is about to make the lock its own, carrying its record. */
  beforeLockRecorded?: () => void;
}

export interface FileLockOptions {
  /** How long to wait for another holder before giving up. */
  waitMs: number;
  /** A lock from another host, or with no readable record, is stale after this. */
  staleMs: number;
  /** Pause between attempts to take the lock. */
  retryMs: number;
  /** When process `pid` started, or null when that cannot be read within `timeoutMs` (defaultStartTime). */
  startTime: (pid: number, timeoutMs: number) => string | null;
  /** The most each start-time read may take. Default: what is left of `waitMs`, at most START_READ_MS. A writer
   *  that does not wait for the lock (waitMs 0) gives the reads a budget of their own, or it records no start time
   *  and cannot tell a running holder's process from another that took its pid. */
  startReadMs?: number;
  /** Makes the hard link that takes the lock (fs.linkSync). */
  link: (existingPath: string, newPath: string) => void;
  hooks: FileLockHooks;
  /** The file the lock protects, as errors name it ("tasks.json"). */
  name: string;
  /** What stops when the lock cannot be held, as errors name it ("task ledger writes"). */
  disabled: string;
  /** The error thrown when a live, fresh holder kept the lock for the whole wait. */
  timeout: (lock: string, waitedMs: number, holder: string) => Error;
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

export function alive(pid: number): boolean {
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
 * null (no /proc and no ps, as on Windows; a sandbox that hides the process from ps or will not start it;
 * a ps that did not answer within `timeoutMs`; the process gone) means "cannot check", never "a different
 * process".
 */
function processStart(pid: number, timeoutMs: number): string | null {
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
      timeout: timeoutMs
    }).toString().trim();
    return out ? `ps:${out}` : null;
  } catch {
    return null;
  }
}

let ownStart: string | null = null;
/**
 * When process `pid` started (see processStart). This process's own start time is kept once it has been
 * read; a read that failed, perhaps only because ps was slow that time, is tried again on the next update.
 */
export function defaultStartTime(pid: number, timeoutMs: number): string | null {
  if (pid !== process.pid) return processStart(pid, timeoutMs);
  if (ownStart === null) ownStart = processStart(process.pid, timeoutMs);
  return ownStart;
}

/**
 * The longest one start-time read may take. It runs ps, synchronously, on the caller's thread (the app's
 * main thread), normally in a few milliseconds; a ps that hangs must not stall it past the wait for the
 * lock, which the app keeps short for that reason.
 */
const START_READ_MS = 100;

/**
 * Whether `pid` can name one process to ask about. Only a positive integer can: kill(0, 0) and kill(-1, 0) ask
 * about process groups and succeed, and a value process.kill refuses as an argument (a fraction, or an integer
 * from 2^31 up) throws before the system is asked, so it is never "no such process". Any of those, read as a
 * pid, would name a holder alive for good.
 */
function usablePid(pid: unknown): pid is number {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    // The system's own answers (ESRCH, EPERM) come from the kill call; an argument error does not.
    if ((e as NodeJS.ErrnoException).syscall !== 'kill') return false;
  }
  return true;
}

/** Whether running process `pid` is the one that recorded `started`: null when that cannot be told. */
function sameProcess(pid: number, started: unknown, startTime: (pid: number) => string | null): boolean | null {
  if (typeof started !== 'string') return null;
  const now = startTime(pid);
  if (now === null) return null;
  const method = (value: string): string => value.slice(0, value.indexOf(':') + 1);
  if (method(now) !== method(started)) return null;
  return now === started;
}

export interface StaleBounds { staleMs: number; startTime: (pid: number) => string | null }

/** Who holds a lock, as its record says: the pid, host and process start time it was taken with. */
export interface HolderRecord { pid?: unknown; host?: unknown; started?: unknown }

/**
 * Whether a holder recorded `ageMs` ago may be broken, by the rule in the header: a holder on this host that is
 * still running (the same process, by start time where that can be read) is never broken, however old; one
 * that has exited is, at once; a holder that cannot be identified (no record, another host, no usable pid) is
 * stale after `staleMs`. Exported so that anything else that records a holder (a lease in a database, say)
 * judges it by this same rule.
 *
 * `owners` remembers, for the length of one wait, whether a recorded holder is still the process that wrote
 * it, so a waiter does not read a start time on every retry. A holder that exits meanwhile is still seen at
 * once, because whether the pid is alive is asked every time.
 */
export function isStaleHolder(record: HolderRecord | null, ageMs: number, bounds: StaleBounds, owners: Map<string, boolean | null> = new Map()): boolean {
  if (!record || record.host !== hostname() || !usablePid(record.pid)) return ageMs > bounds.staleMs;
  if (!alive(record.pid)) return true;
  // A fresh lock with a running holder is never broken, so there is no need yet to ask which process it is.
  if (ageMs <= bounds.staleMs) return false;
  const key = `${record.pid} ${String(record.started)}`;
  if (!owners.has(key)) owners.set(key, sameProcess(record.pid, record.started, bounds.startTime));
  const same = owners.get(key);
  // null: running, but which process cannot be told (see the header). Never broken on age.
  return same === false;
}

function isStale(lock: HeldLock, bounds: StaleBounds, owners: Map<string, boolean | null>): boolean {
  return isStaleHolder(lock.record, lock.ageMs, bounds, owners);
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
 * compared by device and inode, not by content alone: two locks can have the same content, one file cannot
 * be two locks. The token is compared as well, because a filesystem can give a new lock the inode number
 * of the one just removed. Returns whether the stale lock was removed; when it was not, the caller must not take the
 * lock straight away, because the lock it saw may belong to a live holder.
 */
function breakStale(lock: string, judged: HeldLock): boolean {
  const aside = `${lock}.stale-${randomBytes(6).toString('hex')}`;
  try { renameSync(lock, aside); } catch { return false; }
  let moved: HeldLock | null = null;
  try { moved = readLock(aside); } catch { /* unreadable: not the lock judged */ }
  if (moved && moved.dev === judged.dev && moved.ino === judged.ino && moved.record?.token === judged.record?.token) {
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
export interface OwnLock { token: string; dev: number; ino: number }

/**
 * What link() fails with on a volume that cannot make hard links (some network and FUSE mounts, exFAT and
 * FAT). The lock depends on them: it is only ever created by linking a complete record to its name, and a
 * breaker that set a newer holder's lock aside by mistake puts it back with a link. There is no safe lock
 * without them, so the ledger is not written there at all.
 */
const NO_HARD_LINKS = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS']);

export function acquireFileLock(lock: string, opts: FileLockOptions): OwnLock {
  const token = randomBytes(12).toString('hex');
  // A monotonic clock: a wall-clock step back would stretch the wait, a step forward would cut it short.
  const deadline = performance.now() + opts.waitMs;
  // Start-time reads count against the wait, unless startReadMs gives them a budget of their own: each gets at most
  // START_READ_MS, and no more than is left of it. A read that runs out of time cannot tell whether a holder is the process that wrote its record,
  // so that holder is taken to be alive (see isStale), and the wait still ends on time.
  const readStart = (pid: number): string | null => {
    const left = opts.startReadMs ?? Math.min(START_READ_MS, Math.floor(deadline - performance.now()));
    return left > 0 ? opts.startTime(pid, left) : null;
  };
  const started = readStart(process.pid);
  const body = JSON.stringify({ pid: process.pid, host: hostname(), ...(started === null ? {} : { started }), acquiredAt: new Date().toISOString(), token });
  let last: HeldLock | null = null;
  const owners = new Map<string, boolean | null>();
  const tmp = join(dirname(lock), `.${basename(lock)}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
  writeFileSync(tmp, body, { flag: 'wx' });
  const { dev, ino } = statSync(tmp);
  try {
    for (;;) {
      opts.hooks.beforeLockRecorded?.();
      try {
        opts.link(tmp, lock);
        return { token, dev, ino };
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code && NO_HARD_LINKS.has(code)) {
          // EPERM is also what a permission or sandbox rule refusing the link gives, so it names both causes.
          const cause = code === 'EPERM'
            ? 'this volume may not support hard links, or a permission or sandbox rule refused one'
            : 'this volume does not support hard links';
          throw new Error(`${dirname(lock)}: ${cause} (${code}), which the lock on ${opts.name} needs; ${opts.disabled} are disabled`);
        }
        if (code !== 'EEXIST') throw e;
      }
      const held = readLock(lock);
      if (held) {
        last = held;
        if (isStale(held, { staleMs: opts.staleMs, startTime: readStart }, owners)) {
          opts.hooks.beforeBreak?.();
          if (breakStale(lock, held)) continue;
        }
      }
      if (performance.now() >= deadline) {
        const pid = last?.record?.host === hostname() ? last.record.pid : undefined;
        const advice = typeof pid === 'number'
          ? `; if that process is stuck, stopping it frees the lock; if pid ${pid} is not a hive process, deleting ${lock} by hand frees it`
          : '';
        throw opts.timeout(lock, opts.waitMs, `${describe(last)}${advice}`);
      }
      sleep(opts.retryMs);
    }
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Throws `lost(lock, holder)` unless the lock is still the file this writer created, with its token. */
export function confirmFileLock(lock: string, own: OwnLock, lost: (lock: string, holder: string) => Error): void {
  const held = readLock(lock);
  if (held && held.record?.token === own.token && held.dev === own.dev && held.ino === own.ino) return;
  throw lost(lock, held ? describe(held) : 'no lock');
}

/** Removes the lock, if it is still this writer's. */
export function releaseFileLock(lock: string, own: OwnLock): void {
  try { confirmFileLock(lock, own, () => new Error('not this writer\'s lock')); } catch { return; }
  try { unlinkSync(lock); } catch { /* already gone */ }
}
