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
 * works. A live holder on this host is never taken over; a dead one's run is resumed by the next holder. A run whose
 * runner had finished ("ran", its outcome stored) is finished off without calling the runner again. One that was
 * "claimed" is started. The lease is released when the task's turn ends, however it ends.
 *
 * Resume, not repeat. A run found "running" belonged to a scheduler that died while its runner worked, and the process
 * that runner started (the headless CLI, detached into a process group of its own) may still be running and spending.
 * So the runner reports that process as soon as it starts (RunJob.onProcess), and its pid, process group, host and
 * start time are stored on the run row. A later scheduler judges that record by the file lock's own rule
 * (fileLock.ts isStaleHolder: a pid that is running, and not proven by its start time to be another process, is
 * alive; asked on this machine whatever host name was recorded, since core.db is local to it), and also asks whether
 * anything is left in the process group:
 *  - still running: the run is not started again. The task is skipped with a reason naming the process, the same
 *    "hung" report a live lease holder gets; the run goes on once the process has ended. Stopping a stuck one is the
 *    operator's call.
 *  - gone, or never reported: the attempt counts. The runner is started again only while fewer than MAX_RUN_ATTEMPTS
 *    attempts have been made; after that the run is marked failed with the reason.
 * Before the process is started, the runner says what its command line will hold that no other process's does: the
 * headless seat's settings file argument, for a settings file of this run and attempt's own (headlessRunner.ts). That
 * is written to the run row first; a runner that cannot have it
 * written does not start the process. So a crash between the start and the pid's record cannot hide the process: a
 * later scheduler that finds a "running" run with that text but no pid reads the process table once, and a process
 * (not itself) holding exactly that text is recorded, with its start time, and judged as above. Since the text names
 * the run and the attempt, another task's CLI on the same seat never matches. A run whose runner gave no such text, or whose process is not
 * found, counts as an attempt, so at most MAX_RUN_ATTEMPTS processes can ever be started for one run.
 *
 * In this process, a task whose turn is still going is not started again by a second tick (a lease whose holder's
 * host name has changed would otherwise look like another machine's, and be taken over by its own process).
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
 * A run whose cost row or done mail cannot be written (the ledger or the seat's outbox refuses it) stays "ran" with
 * the reason stored and shown in the status, is reported on each tick, and is tried again; it does not hold up the
 * task's later slots. A clock that ran ahead and claimed a future slot is reported on each tick until that slot's time.
 *
 * One window is left: a crash after the runner's process has ended but before its outcome is stored (one synchronous
 * SQLite write) leaves the run "running" with a process that is gone, so it counts as an interrupted attempt and is
 * run again while attempts remain; the ledger then has one row, for the second turn.
 *
 * A runner that throws marks the run failed with its reason; it writes no cost row and no mail, and is not retried. A
 * run whose CLI did not succeed (a usage limit, a budget stop, an error) gets its cost row as any other, and is marked
 * failed with the CLI's reason, never done.
 */
import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { defaultStartTime, isStaleHolder } from '../fileLock';
import { probeProcessGroups, type GroupProcRow } from '../processGroups';
import type { HeadlessRun } from '../headlessSeat';
import { appendCostLedgerRow, COST_LEDGER_FILE } from '../costLedgerFile';
import { headlessCostRow, headlessDoneMessage, writeOutboxMessage } from '../headlessStream';
import { leaseStatus, ownsLease, releaseLease, renewLease, takeLease, type HeldLease, type LeaseStatus } from './lease';
import type { RunnerProcess, SchedulerStore, StoredRun } from './store';
import { slotAtOrBefore, type ScheduledTask, type Slot } from './task';

/** What a runner is given: the run, the definition frozen at claim, and the cap to pass as --max-budget-usd. */
export interface RunJob {
  runId: string;
  taskId: string;
  slot: string;
  snapshot: ScheduledTask;
  maxBudgetUsd: number;
  /** Which attempt at the run this is (1 for the first). With runId it names this launch and no other. */
  attempt: number;
  /** The runner calls this as soon as it has started the process that does the work (the headless CLI), with its
   *  pid and the process group it leads, before awaiting anything: see the header. */
  onProcess: (proc: { pid: number; pgid: number | null }) => void;
  /** The runner calls this just before it starts that process, with text its command line will hold and no other
   *  process's will, naming this run and attempt (the headless seat's settings file argument for a launch keyed by
   *  run id and attempt): see the header. If it throws, the runner must not
   *  start the process. */
  onLaunch: (marker: string) => void;
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

/** How many times one run's runner may be started before a run interrupted again is marked failed. */
export const MAX_RUN_ATTEMPTS = 2;

/** The longest one process start-time read may take (it runs ps on macOS). */
const START_READ_MS = 500;

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
  /** One read of the process table, with process groups (processGroups.ts probeProcessGroups). */
  processTable?: () => Promise<GroupProcRow[]>;
  hooks?: SchedulerHooks;
}

export interface TickReport {
  /** Runs this tick took to an end, or left failed. */
  ran: Array<{ taskId: string; runId: string; slot: string; state: StoredRun['state'] }>;
  /** Tasks with work to do that were left alone, and why: their lease is someone else's (holder), the process an
   *  earlier runner started for their run is still running (runner), or this scheduler is already running them. */
  skipped: Array<{ taskId: string; reason: string; holder?: LeaseStatus; runner?: RunnerProcess }>;
  /** Tasks whose turn stopped on an error; their run is left to resume on a later tick. */
  errors: Array<{ taskId: string; error: string }>;
  /** Tasks whose newest run is for a slot after the clock's reading: a clock that ran ahead claimed it. No earlier slot
   *  fires after a later one, so the task runs nothing until that slot's time comes; this says so on every tick. */
  ahead: Array<{ taskId: string; slot: string; slotAt: number; reason: string }>;
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

/** Whether process group `pgid` still has a member: signal 0 to the group, where EPERM means one exists. */
function groupHasMember(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
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
  /** Tasks whose turn is going on in this process. */
  private readonly inFlight = new Set<string>();

  constructor(private readonly o: SchedulerOptions) {
    this.store = o.store;
    this.now = o.now ?? Date.now;
    this.leaseMs = o.leaseMs ?? DEFAULT_LEASE_MS;
    this.heartbeatMs = o.heartbeatMs ?? Math.max(10, Math.floor(this.leaseMs / 4));
    this.hooks = o.hooks ?? {};
  }

  /** Resumes every unfinished run and claims and runs every due slot, each task under its lease, all at once. */
  async tick(): Promise<TickReport> {
    const report: TickReport = { ran: [], skipped: [], errors: [], ahead: [] };
    await Promise.all(this.store.tasks().map((t) => this.tickTask(t.def.id, t.createdAt, report)));
    return report;
  }

  /** The task's run whose runner has not finished, if any: the one run a task's turn starts or resumes. */
  private openRun(taskId: string): StoredRun | null {
    const open = this.store.runs(taskId).filter((r) => r.state === 'claimed' || r.state === 'running');
    return open[0] ?? null;
  }

  /** The task's runs whose runner has finished but whose cost row or done mail is still to be written. */
  private unfinished(taskId: string): StoredRun[] {
    return this.store.runs(taskId).filter((r) => r.state === 'ran');
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
    const ahead = newestAhead(this.store, taskId, now);
    if (ahead && slotAtOrBefore(def.schedule, now).at >= createdAt) {
      report.ahead.push({ taskId, slot: ahead.slot, slotAt: ahead.slotAt, reason: `task ${taskId}: its newest run is for slot ${ahead.slot}, `
        + `which lies after the clock's reading now (${new Date(now).toISOString()}), so a clock that ran ahead claimed it; no earlier slot fires `
        + 'after a later one, so the task runs nothing until that slot\'s time comes. If the clock was wrong, removing that run lets the task go on' });
    }
    if (!this.openRun(taskId) && !this.unfinished(taskId).length && !this.dueSlot(def, createdAt, now)) return;
    if (this.inFlight.has(taskId)) {
      report.skipped.push({ taskId, reason: `task ${taskId}: this scheduler is already running it` });
      return;
    }
    const took = takeLease(this.store, taskId, now, { leaseMs: this.leaseMs, startTime: this.o.startTime });
    if (!took.ok) {
      report.skipped.push({ taskId, reason: took.holder.summary, holder: took.holder });
      return;
    }
    const lease = took.lease;
    this.inFlight.add(taskId);
    const problem = (error: string): void => { report.errors.push({ taskId, error }); };
    try {
      for (const done of this.unfinished(taskId)) {
        const end = this.finish(done, lease, problem);
        if (end !== 'ran') report.ran.push({ taskId, runId: done.id, slot: done.slot, state: end });
      }
      let run = this.openRun(taskId);
      if (run && run.state === 'running' && !run.runner && run.runnerMarker) {
        const why = await this.adoptUnrecorded(run, lease);
        if (why) {
          report.skipped.push({ taskId, reason: why });
          return;
        }
        run = this.store.run(run.id) as StoredRun;
      }
      if (run && run.state === 'running' && run.runner) {
        const why = this.survivor(run, run.runner);
        if (why) {
          report.skipped.push({ taskId, reason: why, runner: run.runner });
          return;
        }
      }
      if (!run) {
        run = this.claim(taskId, createdAt, lease);
        if (!run) return;
        this.hooks.afterClaim?.();
      }
      const end = await this.execute(run, lease, problem);
      report.ran.push({ taskId, runId: run.id, slot: run.slot, state: end });
    } catch (e) {
      report.errors.push({ taskId, error: (e as Error).message });
    } finally {
      releaseLease(this.store, lease);
      this.inFlight.delete(taskId);
    }
  }

  /** Why the process an earlier attempt's runner started must be waited for, or null when it is gone. Judged by the
   *  file lock's rule for a recorded holder, with no age: a pid that is running, and not proven by its start time to
   *  be another process, is alive. core.db is local to this machine, so the pid is asked about here whatever host
   *  name was recorded with it: macOS changes its host name with the network, and a recorded name that differs says
   *  nothing about the process. A group that still has a member counts as running too, since the CLI's own
   *  subprocesses join it. */
  private survivor(run: StoredRun, p: RunnerProcess): string | null {
    const startTime = this.o.startTime ?? defaultStartTime;
    const cliAlive = !isStaleHolder({ pid: p.pid, host: hostname(), started: p.started ?? undefined }, Number.POSITIVE_INFINITY,
      { staleMs: 0, startTime: (pid) => startTime(pid, START_READ_MS) });
    const groupAlive = !cliAlive && p.pgid !== null && p.pgid > 1 && groupHasMember(p.pgid);
    if (!cliAlive && !groupAlive) return null;
    const what = cliAlive ? `its runner's process (pid ${p.pid}${p.pgid === null ? '' : `, group ${p.pgid}`})` : `a process in its runner's group ${p.pgid}`;
    return `task ${run.taskId}: run ${run.id} was started by a scheduler that has since stopped, and ${what} on ${p.host} is still running; `
      + 'it is not started again, and the run goes on once that process has ended: if it is stuck, stopping it frees the run';
  }

  /** For a run whose runner said what its process's command line holds but whose pid was never recorded (a crash
   *  between the two): one read of the process table, and a process found holding that text is recorded as the
   *  runner's, to be judged as any recorded one. Returns why the run must wait when the table cannot be read. */
  private async adoptUnrecorded(run: StoredRun, lease: HeldLease): Promise<string | null> {
    const marker = run.runnerMarker as string;
    let rows: GroupProcRow[];
    try {
      rows = await (this.o.processTable ?? probeProcessGroups)();
    } catch (e) {
      return `task ${run.taskId}: run ${run.id} was started by a scheduler that has since stopped before recording its runner's process, and the process table, where it would be found, could not be read (${(e as Error).message}); it is not started again this time`;
    }
    const found = rows.find((r) => r.pid !== process.pid && ` ${r.commandLine} `.includes(` ${marker}`));
    if (found) {
      // Its start time too, so that a later reuse of the pid can be told from it.
      const started = (this.o.startTime ?? defaultStartTime)(found.pid, START_READ_MS);
      this.guarded(lease, 'UPDATE scheduler_runs SET runner_pid = ?, runner_pgid = ?, runner_host = ?, runner_started = ? WHERE id = ?',
        found.pid, found.pgid ?? null, hostname(), started, run.id);
    }
    return null;
  }

  /** Records the runner's process on the run row; see the header. The start time is read after, off the spawn path. A
   *  write that fails is reported through `problem`: the run then counts as unrecorded if this scheduler stops. */
  private recordRunner(run: StoredRun, lease: HeldLease, proc: { pid: number; pgid: number | null }, problem: (error: string) => void): void {
    const failed = (what: string, e: unknown): void => problem(`run ${run.id}: ${what} of its runner's process (pid ${proc.pid}) could not be recorded, so a scheduler that restarts while it runs cannot judge it by that: ${(e as Error).message}`);
    try {
      this.guarded(lease, 'UPDATE scheduler_runs SET runner_pid = ?, runner_pgid = ?, runner_host = ? WHERE id = ?', proc.pid, proc.pgid, hostname(), run.id);
    } catch (e) { failed('the pid', e); return; }
    setImmediate(() => {
      const started = (this.o.startTime ?? defaultStartTime)(proc.pid, START_READ_MS);
      if (started === null) return;
      try {
        this.guarded(lease, 'UPDATE scheduler_runs SET runner_started = ? WHERE id = ? AND runner_pid = ?', started, run.id, proc.pid);
      } catch (e) { failed('the start time', e); }
    });
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

  private async execute(claimed: StoredRun, lease: HeldLease, problem: (error: string) => void): Promise<StoredRun['state']> {
    let run = claimed;
    if (run.state === 'claimed' || run.state === 'running') {
      if (run.attempt >= MAX_RUN_ATTEMPTS) {
        this.guarded(lease, "UPDATE scheduler_runs SET state = 'failed', failure = ?, ended_at = ? WHERE id = ?",
          `the run was interrupted after each of its ${run.attempt} attempts (the scheduler stopped while its runner worked); it is not started again`, this.now(), run.id);
        return 'failed';
      }
      this.hooks.beforeRunnerStart?.();
      this.guarded(lease, "UPDATE scheduler_runs SET state = 'running', attempt = attempt + 1, started_at = ?, runner_pid = NULL, runner_pgid = NULL, runner_host = NULL, runner_started = NULL, runner_marker = NULL WHERE id = ?", this.now(), run.id);
      const beat = setInterval(() => { try { renewLease(this.store, lease, this.now()); } catch { /* the next beat tries again */ } }, this.heartbeatMs);
      let outcome: RunnerOutcome;
      try {
        const started = run;
        outcome = await this.o.runner({
          runId: run.id, taskId: run.taskId, slot: run.slot, snapshot: run.snapshot, maxBudgetUsd: run.snapshot.maxBudgetUsd, attempt: run.attempt + 1,
          onProcess: (proc) => this.recordRunner(started, lease, proc, problem),
          onLaunch: (marker) => this.guarded(lease, 'UPDATE scheduler_runs SET runner_marker = ? WHERE id = ?', marker, started.id),
        });
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
    return this.finish(run, lease, problem);
  }

  /** Writes a finished run's cost row and done mail, once each, and ends it done or failed. When either cannot be
   *  written, the run stays "ran" with the reason stored (effects_error, shown in the status) and reported, and is
   *  tried again on later ticks; it no longer holds up the task's later slots. */
  private finish(ran: StoredRun, lease: HeldLease, problem: (error: string) => void): StoredRun['state'] {
    const run = ran;
    try {
      this.writeEffects(run, lease);
    } catch (e) {
      if (e instanceof LeaseLost) throw e;
      const why = `run ${run.id}: its cost row or done mail could not be written (${(e as Error).message}); its turn has been paid for, so it is tried again on each tick, and the task's later slots go on meanwhile`;
      this.guarded(lease, 'UPDATE scheduler_runs SET effects_error = ? WHERE id = ?', why, run.id);
      problem(why);
      return 'ran';
    }
    const cli = (run.outcome as RunnerOutcome).run;
    if (!cli.ok) {
      const why = cli.error ?? `the CLI ended ${cli.outcome}${cli.subtype ? ` (${cli.subtype})` : ''}`;
      this.guarded(lease, "UPDATE scheduler_runs SET state = 'failed', failure = ?, effects_error = NULL, ended_at = ? WHERE id = ?", `the run did not succeed: ${why}`, this.now(), run.id);
      return 'failed';
    }
    this.guarded(lease, "UPDATE scheduler_runs SET state = 'done', effects_error = NULL, ended_at = ? WHERE id = ?", this.now(), run.id);
    return 'done';
  }

  private writeEffects(run: StoredRun, lease: HeldLease): void {
    this.recordCost(run, lease);
    this.sendDoneMail(this.store.run(run.id) as StoredRun, lease);
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

/** The task's newest run, when its slot lies after `now`. */
function newestAhead(store: SchedulerStore, taskId: string, now: number): { slot: string; slotAt: number } | null {
  const r = store.db.prepare('SELECT slot, slot_at FROM scheduler_runs WHERE task_id = ? ORDER BY slot_at DESC LIMIT 1').get(taskId) as Record<string, unknown> | undefined;
  return r && Number(r.slot_at) > now ? { slot: String(r.slot), slotAt: Number(r.slot_at) } : null;
}

export interface SchedulerStatus {
  /** Every lease, with its holder and whether it is held, hung (expired, holder alive) or stale. */
  leases: LeaseStatus[];
  /** Tasks whose newest run is for a slot after `now` (see TickReport.ahead). */
  ahead: Array<{ taskId: string; slot: string; slotAt: number }>;
  /** Runs claimed but not yet done or failed. */
  openRuns: Array<Pick<StoredRun, 'id' | 'taskId' | 'slot' | 'state' | 'attempt' | 'runner' | 'effectsError'>>;
}

/** What the scheduler is doing, for a caller to read: a hung holder shows as a lease in state "hung". */
export function schedulerStatus(store: SchedulerStore, o: { now?: number; startTime?: (pid: number, timeoutMs: number) => string | null } = {}): SchedulerStatus {
  return {
    leases: leaseStatus(store, o.now ?? Date.now(), { startTime: o.startTime }),
    ahead: store.tasks().flatMap((t) => { const a = newestAhead(store, t.def.id, o.now ?? Date.now()); return a ? [{ taskId: t.def.id, ...a }] : []; }),
    openRuns: store.runs().filter((r) => r.state !== 'done' && r.state !== 'failed')
      .map((r) => ({ id: r.id, taskId: r.taskId, slot: r.slot, state: r.state, attempt: r.attempt, runner: r.runner, effectsError: r.effectsError })),
  };
}
