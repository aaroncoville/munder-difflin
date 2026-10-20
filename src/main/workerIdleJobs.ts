/**
 * Is a silent worker actually idle, or waiting on a job it launched?
 *
 * The idle reaper measures silence on the worker's terminal. A worker that
 * starts a long job in the background (a 25-minute test suite) and waits for
 * it is silent the whole time, yet busy — reaping it throws the result away.
 *
 * Telling a launched job from the session's own helpers: the worker's pty
 * child is a session leader (forkpty does setsid), so its process group id is
 * its pid. Long-lived helpers it spawns directly — MCP servers — stay in that
 * group. The shells its tools run commands in are started in a group of their
 * own, and so is everything those commands launch. A direct child whose group
 * differs from the worker's is therefore work the worker launched. Children of
 * a same-group helper are not looked at: an MCP server may start a process in
 * a session of its own (a browser, say), and that belongs to the server.
 *
 * Limitation: a job whose launching shell has exited is reparented to init and
 * no longer descends from the worker, so it is not seen.
 */
import { spawnSync } from 'node:child_process';

export interface ProcRow { pid: number; ppid: number; pgid: number }

/** Parse `ps -axo pid=,ppid=,pgid=` output. */
export function parseProcessTable(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) });
  }
  return rows;
}

/** Does `rootPid` have a direct child outside its own process group? */
export function hasLaunchedJob(rootPid: number, rows: ProcRow[]): boolean {
  return rows.some((r) => r.ppid === rootPid && r.pgid !== rootPid);
}

/** Probe the live process table for jobs under `pid`. Fails toward "no job"
 *  (the pre-existing behaviour) when `ps` is unavailable or on Windows. */
export function workerHasLiveJob(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0 || process.platform === 'win32') return false;
  try {
    const r = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid='], { timeout: 2_000 });
    if (r.error || r.status !== 0) return false;
    return hasLaunchedJob(pid, parseProcessTable(String(r.stdout ?? '')));
  } catch {
    return false;
  }
}

/** Per-worker state: when a launched job was last seen alive. */
export interface IdleJobState { jobSeenAt?: number }

/**
 * Decide whether a worker is idle past the limit. Idle time is the shorter of
 * the terminal's silence and the time since a launched job was last seen
 * alive, so the clock restarts when the job exits. The process table is only
 * probed once that idle time is past the limit, so a busy floor pays nothing.
 * Once the terminal has been silent past `ceilingMs` the worker is reaped
 * whatever the process table says, so no job can hold it forever.
 */
export function shouldReapIdle(
  state: IdleJobState,
  o: { ptyIdleMs: number; limitMs: number; ceilingMs?: number; now: number; hasLiveJob: () => boolean }
): boolean {
  if (o.ceilingMs !== undefined && o.ptyIdleMs > o.ceilingMs) return true;
  const sinceJob = state.jobSeenAt === undefined ? Infinity : o.now - state.jobSeenAt;
  if (Math.min(o.ptyIdleMs, sinceJob) <= o.limitMs) return false;
  if (o.hasLiveJob()) {
    state.jobSeenAt = o.now;
    return false;
  }
  return true;
}
