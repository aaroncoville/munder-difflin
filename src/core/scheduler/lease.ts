/**
 * The lease on a scheduled task: whoever runs the task holds it, one holder at a time, in core.db.
 *
 * A lease records its holder as the shared file lock does (fileLock.ts): pid, host and process start time, plus a
 * random token, when it was taken, and the last heartbeat. The holder renews it by heartbeat while its runner works;
 * it expires `leaseMs` after the last one. Whether an existing lease may be taken over is decided by the file lock's
 * own rule (isStaleHolder), never by a copy of it:
 *  - a holder on this host that has exited is taken over at once, expired or not;
 *  - a holder on this host that is still running (the same process, by start time where that can be read) is never
 *    taken over on expiry alone. A holder that has stopped heartbeating but is alive may be hung or may be in a long
 *    synchronous stretch; either way taking over would run the task twice. It is reported instead: leaseStatus gives
 *    state "hung" with its pid, host and heartbeat age, and a tick that skips the task says the same;
 *  - a holder that cannot be identified (another host, no usable pid) is taken over once its lease has expired.
 *
 * Every step happens in one write transaction, so two schedulers cannot both take one lease. The holder checks the
 * token is still its own (ownsLease) before each write it makes for the run.
 */
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { alive, defaultStartTime, isStaleHolder } from '../fileLock';
import type { SchedulerStore } from './store';

/** The longest one process start-time read may take (it runs ps on macOS). */
const START_READ_MS = 500;

/** A lease this process holds. */
export interface HeldLease { taskId: string; token: string }

export interface LeaseStatus {
  taskId: string;
  pid: number;
  host: string;
  acquiredAt: number;
  heartbeatAt: number;
  /** How long since the last heartbeat, by the caller's clock. */
  heartbeatAgeMs: number;
  leaseMs: number;
  expired: boolean;
  /** held: fresh, or expired with an unidentifiable holder not yet broken; hung: expired, and the holder on this host is
   *  still running, so it is not taken over; stale: may be taken over. */
  state: 'held' | 'hung' | 'stale';
  /** One line naming the holder, its heartbeat age and what that means. */
  summary: string;
}

export interface LeaseOptions {
  /** How long a lease lasts after its last heartbeat. */
  leaseMs: number;
  /** When process `pid` started (fileLock.ts defaultStartTime). */
  startTime?: (pid: number, timeoutMs: number) => string | null;
}

type Row = Record<string, unknown>;

function describe(row: Row, now: number, leaseMs: number, state: LeaseStatus['state']): string {
  const age = now - Number(row.heartbeat_at);
  const who = `task ${String(row.task_id)}: lease held by pid ${Number(row.pid)} on ${String(row.host)}, last heartbeat ${age} ms ago (lease ${leaseMs} ms)`;
  if (state === 'hung') return `${who}; it has expired but the holder is still running, so it is not taken over: if that process is stuck, stopping it frees the task`;
  if (state === 'stale') return `${who}; the holder is gone or the lease has expired, so it may be taken over`;
  return who;
}

function judge(row: Row, now: number, o: LeaseOptions): LeaseStatus {
  const leaseMs = Number(row.lease_ms);
  const startTime = o.startTime ?? defaultStartTime;
  const ageMs = now - Number(row.heartbeat_at);
  const record = { pid: Number(row.pid), host: String(row.host), started: row.started ?? undefined };
  const stale = isStaleHolder(record, ageMs, { staleMs: leaseMs, startTime: (pid) => startTime(pid, START_READ_MS) });
  const expired = ageMs > leaseMs;
  const sameHostAlive = record.host === hostname() && alive(record.pid);
  const state: LeaseStatus['state'] = stale ? 'stale' : expired && sameHostAlive ? 'hung' : 'held';
  return {
    taskId: String(row.task_id), pid: record.pid, host: record.host, acquiredAt: Number(row.acquired_at), heartbeatAt: Number(row.heartbeat_at),
    heartbeatAgeMs: ageMs, leaseMs, expired, state, summary: describe(row, now, leaseMs, state),
  };
}

/** Takes the lease on `taskId` when it is free or may be taken over; otherwise says who holds it. */
export function takeLease(store: SchedulerStore, taskId: string, now: number, o: LeaseOptions): { ok: true; lease: HeldLease } | { ok: false; holder: LeaseStatus } {
  const startTime = o.startTime ?? defaultStartTime;
  const started = startTime(process.pid, START_READ_MS);
  return store.write(() => {
    const row = store.db.prepare('SELECT * FROM scheduler_leases WHERE task_id = ?').get(taskId) as Row | undefined;
    if (row) {
      const status = judge(row, now, o);
      if (status.state !== 'stale') return { ok: false as const, holder: status };
      store.db.prepare('DELETE FROM scheduler_leases WHERE task_id = ? AND token = ?').run(taskId, String(row.token));
    }
    const token = randomBytes(12).toString('hex');
    store.db.prepare('INSERT INTO scheduler_leases (task_id, pid, host, started, token, acquired_at, heartbeat_at, lease_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(taskId, process.pid, hostname(), started, token, now, now, o.leaseMs);
    return { ok: true as const, lease: { taskId, token } };
  });
}

/** Renews the lease's heartbeat; false when it is no longer this holder's. */
export function renewLease(store: SchedulerStore, lease: HeldLease, now: number): boolean {
  return Number(store.db.prepare('UPDATE scheduler_leases SET heartbeat_at = ? WHERE task_id = ? AND token = ?').run(now, lease.taskId, lease.token).changes) === 1;
}

/** Whether the lease is still this holder's. */
export function ownsLease(store: SchedulerStore, lease: HeldLease): boolean {
  return store.db.prepare('SELECT 1 FROM scheduler_leases WHERE task_id = ? AND token = ?').get(lease.taskId, lease.token) !== undefined;
}

/** Gives the lease up, if it is still this holder's. */
export function releaseLease(store: SchedulerStore, lease: HeldLease): void {
  store.db.prepare('DELETE FROM scheduler_leases WHERE task_id = ? AND token = ?').run(lease.taskId, lease.token);
}

/** Every lease, judged at `now`. */
export function leaseStatus(store: SchedulerStore, now: number, o: Omit<LeaseOptions, 'leaseMs'> = {}): LeaseStatus[] {
  return (store.db.prepare('SELECT * FROM scheduler_leases ORDER BY task_id').all() as Row[]).map((r) => judge(r, now, { leaseMs: Number(r.lease_ms), ...o }));
}
