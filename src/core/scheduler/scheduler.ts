/**
 * The scheduler: on each tick, every task that is due is claimed as one run and run, and every run a crash or restart
 * left unfinished is resumed.
 *
 * Claim. A run is one row per (task, slot), unique in core.db; its id is derived from the task and the slot's key, and
 * the slot is named by the schedule, never by the clock reading (task.ts). A slot fires only when it falls after the
 * task was first stored and after the newest slot already claimed for the task, so neither a second scheduler, nor a
 * restart, nor a wall clock stepped backwards can fire a slot twice or fire an older slot after a newer one. A clock
 * stepped forwards over several slots fires only the latest of them, once; slots it skipped are not run (missed-run
 * policy and retries are not part of this module yet). At claim, the task definition is frozen into the run row; the
 * run uses that snapshot whatever is edited later.
 *
 * Lease. Only the holder of the task's lease (lease.ts) claims or runs it, and the holder heartbeats while its runner
 * works. A live holder on this host is never taken over; a dead one's run is resumed by the next holder: a run whose
 * runner had not finished ("claimed" or "running") is run again, and one whose runner had finished ("ran", its outcome
 * stored) is finished off without calling the runner again. The lease is released when the task's turn ends, however it
 * ends.
 *
 * Side effects, keyed by the run id. A finished run gets at most one cost-ledger row and one done mail, however often
 * it is resumed:
 *  - the cost row carries the run id (run_id). Before appending, the run row records "pending" and the ledger's size;
 *    after, "recorded". A run found "pending" was interrupted between the two, so the ledger is searched from that
 *    size for a row with its run id, and only appended to when there is none. The ledger is append-only, so the
 *    search is bounded by what was appended since.
 *  - the done mail's id is derived from the run id and the claim time. Before writing, the run row records "pending"
 *    and the id; after, "sent". Before writing, the seat's outbox and then outbox/.sent (where the router files a
 *    delivered message under the same name, perhaps with a prefix) are searched for that id: in that order, because
 *    mail moves from the first to the second, so a message the router moves in between is still seen.
 * One window is left: a crash after the runner's process has ended but before its outcome is stored (one synchronous
 * SQLite write) leaves the run "running", so it is run again; the ledger then has one row, for the second turn.
 *
 * A runner that throws marks the run failed with its reason; it writes no cost row and no mail, and is not retried.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { HeadlessRun } from '../headlessSeat';
import { appendCostLedgerRow, COST_LEDGER_FILE } from '../costLedgerFile';
import { headlessCostRow, headlessDoneMessage, writeOutboxMessage } from '../headlessStream';
import { leaseStatus, ownsLease, releaseLease, renewLease, takeLease, type HeldLease, type LeaseStatus } from './lease';
import type { SchedulerStore, StoredRun } from './store';
import { slotAtOrBefore, type ScheduledTask, type Slot } from './task';

/** What a runner is given: the run, the definition frozen at claim, and the cap to pass as --max-budget-usd. */
export interface RunJob {
  runId: string;
  taskId: string;
  slot: string;
  snapshot: ScheduledTask;
  maxBudgetUsd: number;
}

/** What a runner returns: the finished headless run, and whether its output is in place. */
export interface RunnerOutcome {
  run: HeadlessRun;
  done: boolean;
  doneReason: string | null;
}

/** Runs one job. It records no cost and sends no mail: the scheduler does both, keyed by the run id. */
export type Runner = (job: RunJob) => Promise<RunnerOutcome>;

/** Points between the steps of a run, where a test can stop the process as a crash would. Not for production use. */
export interface SchedulerHooks {
  afterClaim?: () => void;
  beforeRunnerStart?: () => void;
  afterRunnerResult?: () => void;
  afterCostAppend?: () => void;
  afterMailWrite?: () => void;
}

export const DEFAULT_LEASE_MS = 120_000;

export interface SchedulerOptions {
  store: SchedulerStore;
  /** The hive the cost ledger and the seats' outboxes are in. */
  hiveRoot: string;
  runner: Runner;
  /** The wall clock (epoch ms). */
  now?: () => number;
  /** How long a lease lasts after its last heartbeat (default DEFAULT_LEASE_MS). */
  leaseMs?: number;
  /** How often the holder heartbeats while its runner works (default a quarter of leaseMs). */
  heartbeatMs?: number;
  /** When process `pid` started (fileLock.ts defaultStartTime). */
  startTime?: (pid: number, timeoutMs: number) => string | null;
  hooks?: SchedulerHooks;
}

export interface TickReport {
  /** Runs this tick took to an end, or left failed. */
  ran: Array<{ taskId: string; runId: string; slot: string; state: StoredRun['state'] }>;
  /** Tasks with work to do whose lease someone else holds, and who. */
  skipped: Array<{ taskId: string; reason: string; holder: LeaseStatus }>;
  /** Tasks whose turn stopped on an error; their run is left to resume on a later tick. */
  errors: Array<{ taskId: string; error: string }>;
}

/** The lease was taken over while this holder was still working. */
class LeaseLost extends Error {}

/** A run's id: the same for the same task and slot, whoever claims it. */
export function runIdFor(taskId: string, slot: string): string {
  return `r-${createHash('sha256').update(`${taskId}\n${slot}`).digest('hex').slice(0, 24)}`;
}

/** The done mail's id for a run: a safe message id, in the router's time-first form. */
export function doneMailIdFor(run: Pick<StoredRun, 'id' | 'claimedAt'>): string {
  return `${new Date(run.claimedAt).toISOString().replace(/[:.]/g, '-')}-scheduled-${run.id}`;
}

/** Whether the ledger has a row for `runId` at or after byte `from` (from the start, if the ledger is now shorter). */
function ledgerHasRun(ledger: string, runId: string, from: number): boolean {
  let fd: number;
  try { fd = openSync(ledger, 'r'); } catch { return false; }
  try {
    const size = fstatSync(fd).size;
    const start = from <= size ? from : 0;
    const buf = Buffer.alloc(size - start);
    let got = 0;
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, start + got);
      if (n === 0) break;
      got += n;
    }
    return buf.subarray(0, got).toString('utf8').split('\n').some((line) => {
      if (!line.includes(runId)) return false;
      try { return (JSON.parse(line) as { run_id?: unknown }).run_id === runId; } catch { return false; }
    });
  } finally {
    closeSync(fd);
  }
}

function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return 0; }
}

/** Whether a message with id `id` is in the seat's outbox or has been filed under outbox/.sent. */
function mailWritten(outbox: string, id: string): boolean {
  const named = (n: string): boolean => n === `${id}.json` || n.endsWith(`-${id}.json`);
  for (const dir of [outbox, join(outbox, '.sent')]) {
    let names: string[] = [];
    try { names = readdirSync(dir); } catch { continue; }
    if (names.some(named)) return true;
  }
  return false;
}

export class Scheduler {
  private readonly store: SchedulerStore;
  private readonly now: () => number;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly hooks: SchedulerHooks;

  constructor(private readonly o: SchedulerOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    this.leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = o.heartbeatMs ?? Math.max(10, Math.floor(this.leaseMs / 4));
    this.hooks = o.hooks ?? {};
  }

  /** Resumes every unfinished run and claims and runs every due slot, each task under its lease, all at once. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { ran: [], skipped: [], errors: [] };
    await Promise.all(this.store.tasks().map((t) => this.tickTask(t.def.id, t.createdAt, report)));
    return report;
  }

  private openRun(taskId: string): StoredRun | null {
    const open = this.store.runs(taskId).filter((r) => r.state === 'claimed' || r.state === 'running' || r.state === 'ran');
    return open[0] ?? null;
  }

  /** The slot to claim now, if any: the latest one at or before now, if it falls after the task was first stored and
   *  after the newest slot already claimed. */
  private dueSlot(def: ScheduledTask, createdAt: number, now: number): Slot | null {
    const slot = slotAtOrBefore(def.schedule, now);
    if (slot.at < createdAt) return null;
    const newest = this.store.db.prepare('SELECT MAX(slot_at) AS at FROM scheduler_runs WHERE task_id = ?').get(def.id) as { at: number | null };
    return newest.at !== null && slot.at <= Number(newest.at) ? null : slot;
  }

  private async tickTask(taskId: string, createdAt: number, report: TickReport): Promise<void> {
    const def = this.store.getTask(taskId);
    if (!def) return;
    const now = this.now();
    if (!this.openRun(taskId) && !this.dueSlot(def, createdAt, now)) return;
    const took = takeLease(this.store, taskId, now, { leaseMs: this.leaseMs, startTime: this.o.startTime });
    if (!took.ok) {
      report.skipped.push({ taskId, reason: took.holder.summary, holder: took.holder });
      return;
    }
    const lease = took.lease;
    try {
      let run = this.openRun(taskId);
      if (!run) {
        run = this.claim(taskId, createdAt, lease);
        if (!run) return;
        this.hooks.afterClaim?.();
      }
      const end = await this.execute(run, lease);
      report.ran.push({ taskId, runId: run.id, slot: run.slot, state: end });
    } catch (e) {
      report.errors.push({ taskId, error: (e as Error).message });
    } finally {
      releaseLease(this.store, lease);
    }
  }

  /** Claims the due slot, freezing the task's definition as it is stored now; null when there is none to claim. */
  private claim(taskId: string, createdAt: number, lease: HeldLease): StoredRun | null {
    const now = this.now();
    return this.store.write(() => {
      if (!ownsLease(this.store, lease)) throw new LeaseLost(`the lease on task ${taskId} was taken over`);
      const def = this.store.getTask(taskId);
      if (!def) return null;
      const slot = this.dueSlot(def, createdAt, now);
      if (!slot) return null;
      const id = runIdFor(taskId, slot.key);
      const inserted = this.store.db.prepare(`INSERT OR IGNORE INTO scheduler_runs (id, task_id, slot, slot_at, state, snapshot, claimed_at)
        VALUES (?, ?, ?, ?, 'claimed', ?, ?)`).run(id, taskId, slot.key, slot.at, JSON.stringify(def), now);
      return Number(inserted.changes) === 1 ? this.store.run(id) : null;
    });
  }

  /** One write for the run, made only while the lease is still this holder's. */
  private guarded(lease: HeldLease, sql: string, ...args: Array<string | number | null>): void {
    this.store.write(() => {
      if (!ownsLease(this.store, lease)) throw new LeaseLost(`the lease on task ${lease.taskId} was taken over`);
      this.store.db.prepare(sql).run(...args);
    });
  }

  private async execute(claimed: StoredRun, lease: HeldLease): Promise<StoredRun['state']> {
    let run = claimed;
    if (run.state === 'claimed' || run.state === 'running') {
      this.hooks.beforeRunnerStart?.();
      this.guarded(lease, "UPDATE scheduler_runs SET state = 'running', attempt = attempt + 1, started_at = ? WHERE id = ?", this.now(), run.id);
      const beat = setInterval(() => { try { renewLease(this.store, lease, this.now()); } catch { /* the next beat tries again */ } }, this.heartbeatMs);
      let outcome: RunnerOutcome;
      try {
        outcome = await this.o.runner({ runId: run.id, taskId: run.taskId, slot: run.slot, snapshot: run.snapshot, maxBudgetUsd: run.snapshot.maxBudgetUsd });
        if (!outcome || typeof outcome !== 'object' || !outcome.run) throw new Error('the runner returned no run');
      } catch (e) {
        this.guarded(lease, "UPDATE scheduler_runs SET state = 'failed', failure = ?, ended_at = ? WHERE id = ?", `the runner failed: ${(e as Error).message}`, this.now(), run.id);
        return 'failed';
      } finally {
        clearInterval(beat);
      }
      this.guarded(lease, "UPDATE scheduler_runs SET state = 'ran', outcome = ? WHERE id = ?", JSON.stringify(outcome), run.id);
      this.hooks.afterRunnerResult?.();
      run = this.store.run(run.id) as StoredRun;
    }
    this.recordCost(run, lease);
    this.sendDoneMail(this.store.run(run.id) as StoredRun, lease);
    this.guarded(lease, "UPDATE scheduler_runs SET state = 'done', ended_at = ? WHERE id = ?", this.now(), run.id);
    return 'done';
  }

  /** At most one ledger row for the run: see the header. Throws when the append fails, leaving the run to resume. */
  private recordCost(run: StoredRun, lease: HeldLease): void {
    if (run.costState === 'recorded' || run.costState === 'none') return;
    const ledger = join(this.o.hiveRoot, COST_LEDGER_FILE);
    if (run.costState === 'pending' && ledgerHasRun(ledger, run.id, run.costFrom ?? 0)) {
      this.guarded(lease, "UPDATE scheduler_runs SET cost_state = 'recorded' WHERE id = ?", run.id);
      return;
    }
    const outcome = run.outcome as RunnerOutcome;
    const { row, reason } = headlessCostRow(run.snapshot.agentId, outcome.run, this.now());
    if (!row) {
      this.guarded(lease, "UPDATE scheduler_runs SET cost_state = 'none', cost_reason = ? WHERE id = ?", reason, run.id);
      return;
    }
    this.guarded(lease, "UPDATE scheduler_runs SET cost_state = 'pending', cost_from = ? WHERE id = ?", sizeOf(ledger), run.id);
    try {
      appendCostLedgerRow(this.o.hiveRoot, { ...row, run_id: run.id }, 'scheduled run cost rows');
    } catch (e) {
      throw new Error(`run ${run.id}: ${(e as Error).message}`);
    }
    this.hooks.afterCostAppend?.();
    this.guarded(lease, "UPDATE scheduler_runs SET cost_state = 'recorded' WHERE id = ?", run.id);
  }

  /** At most one done mail for the run, and only when its output is in place: see the header. */
  private sendDoneMail(run: StoredRun, lease: HeldLease): void {
    if (run.mailState === 'sent' || run.mailState === 'none') return;
    const outcome = run.outcome as RunnerOutcome;
    if (!outcome.done) {
      this.guarded(lease, "UPDATE scheduler_runs SET mail_state = 'none' WHERE id = ?", run.id);
      return;
    }
    const agentId = run.snapshot.agentId;
    const id = doneMailIdFor(run);
    if (mailWritten(join(this.o.hiveRoot, 'agents', agentId, 'outbox'), id)) {
      this.guarded(lease, "UPDATE scheduler_runs SET mail_state = 'sent', mail_id = ? WHERE id = ?", id, run.id);
      return;
    }
    this.guarded(lease, "UPDATE scheduler_runs SET mail_state = 'pending', mail_id = ? WHERE id = ?", id, run.id);
    const cost = run.costState === 'recorded' ? { costRecorded: true, costReason: null } : { costRecorded: false, costReason: run.costReason };
    const msg = { ...headlessDoneMessage(agentId, outcome.run, run.snapshot.outputFile, cost, this.now()), id };
    writeOutboxMessage(this.o.hiveRoot, agentId, msg);
    this.hooks.afterMailWrite?.();
    this.guarded(lease, "UPDATE scheduler_runs SET mail_state = 'sent' WHERE id = ?", run.id);
  }
}

export interface SchedulerStatus {
  /** Every lease, with its holder and whether it is held, hung (expired, holder alive) or stale. */
  leases: LeaseStatus[];
  /** Runs claimed but not yet done or failed. */
  openRuns: Array<Pick<StoredRun, 'id' | 'taskId' | 'slot' | 'state' | 'attempt'>>;
}

/** What the scheduler is doing, for a caller to read: a hung holder shows as a lease in state "hung". */
export function schedulerStatus(store: SchedulerStore, o: { now?: number; startTime?: (pid: number, timeoutMs: number) => string | null } = {}): SchedulerStatus {
  return {
    leases: leaseStatus(store, o.now ?? Date.now(), { startTime: o.startTime }),
    openRuns: store.runs().filter((r) => r.state !== 'done' && r.state !== 'failed')
      .map((r) => ({ id: r.id, taskId: r.taskId, slot: r.slot, state: r.state, attempt: r.attempt })),
  };
}
