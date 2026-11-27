/**
 * The app's cost rows on their way to `cost-ledger.jsonl`. Rows are only ever written under the ledger's lock
 * (appendCostLedgerRows), several at a time under one hold, and the app's thread does not wait for that lock: each
 * attempt takes it only if it is free at once. When it is not, or the append fails for any other reason (a linked
 * ledger, a volume without hard links, a write that stopped short), the rows stay queued in order and the queue tries
 * again later on a timer, backing off up to the last of `retryMs`; a failure that has not cleared after `slowAfter`
 * attempts (a linked ledger, a volume without hard links) is tried again only every `probeMs`. One attempt writes at most `perTick` rows, and a
 * longer queue is written over several timer ticks, so the thread is never held for long. A failure is reported once,
 * when it starts; a later success says the queue is writing again.
 *
 * The queue holds at most `cap` rows. A row pushed onto a full queue makes it drop its oldest row, and says so (once
 * per run of drops, with the count). Cost rows are periodic per-agent snapshots, so a later row supersedes a lost one.
 * The queue lives in memory: rows still in it when the process stops without flush() are lost, and the next
 * snapshot of each agent replaces them.
 */

/** The waits before each retry after a failed attempt; the last is repeated. */
export const COST_QUEUE_RETRY_MS = [100, 250, 500, 1000, 2000, 5000] as const;
/** After this many failed attempts in a row, the queue tries only every COST_QUEUE_PROBE_MS. */
export const COST_QUEUE_SLOW_AFTER = 12;
/** The wait between attempts once a failure has not cleared. */
export const COST_QUEUE_PROBE_MS = 60_000;
/** A failure is lasting once this many attempts in a row have failed... */
export const COST_QUEUE_LASTING_AFTER = 3;
/** ...or once it has gone on this long, at its next attempt. */
export const COST_QUEUE_LASTING_MS = 1000;
/** The most rows the queue holds. */
export const COST_QUEUE_CAP = 1000;
/** The most rows one attempt on the timer writes. */
export const COST_QUEUE_PER_TICK = 25;

export interface CostLedgerQueueOptions {
  /** Appends `rows` (oldest first) under the ledger's lock, waiting at most `waitMs` for it, and returns how many of
   *  them, from the first, it wrote (at least one); throws when it wrote none. */
  append: (rows: readonly object[], waitMs: number) => number;
  /** Told once when appends start failing (with why); once more when the failure has lasted (LASTING_AFTER attempts
   *  or LASTING_MS, whichever comes first), so brief contention for the lock is not mistaken for a fault; once when
   *  rows are dropped; and once when appends succeed again. */
  report: (event: { kind: 'failing'; reason: string; queued: number } | { kind: 'lasting'; reason: string } | { kind: 'dropped'; count: number } | { kind: 'recovered' }) => void;
  cap?: number;
  perTick?: number;
  retryMs?: readonly number[];
  slowAfter?: number;
  probeMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  /** A monotonic clock in milliseconds, for flush's deadline. */
  now?: () => number;
}

export class CostLedgerQueue {
  private readonly rows: object[] = [];
  private timer: unknown = null;
  private failures = 0;
  private dropped = 0;
  private failingSince = 0;
  private lasting = false;
  private readonly cap: number;
  private readonly perTick: number;
  private readonly retryMs: readonly number[];
  private readonly slowAfter: number;
  private readonly probeMs: number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly opts: CostLedgerQueueOptions) {
    this.cap = opts.cap ?? COST_QUEUE_CAP;
    this.perTick = opts.perTick ?? COST_QUEUE_PER_TICK;
    this.retryMs = opts.retryMs ?? COST_QUEUE_RETRY_MS;
    this.slowAfter = opts.slowAfter ?? COST_QUEUE_SLOW_AFTER;
    this.probeMs = opts.probeMs ?? COST_QUEUE_PROBE_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
    this.now = opts.now ?? (() => performance.now());
  }

  /** How many rows are waiting. */
  get size(): number { return this.rows.length; }

  /** Queue `row` and, unless an attempt is already due on the timer, try to write now, without waiting for the lock. */
  push(row: object): void {
    if (this.rows.length >= this.cap) {
      this.rows.shift();
      if (this.dropped++ === 0) this.opts.report({ kind: 'dropped', count: 1 });
    }
    this.rows.push(row);
    if (this.timer === null) this.tick();
  }

  /** For quitting: write what is queued now, stopping once `withinMs` has passed (lock waits and writes included;
   *  each attempt may wait for the lock no longer than what is left). Returns how many rows are still queued. */
  flush(withinMs: number): number {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    const deadline = this.now() + withinMs;
    while (this.rows.length) {
      const left = Math.floor(deadline - this.now());
      if (left <= 0) break;
      if (!this.attempt(this.rows.length, left)) break;
    }
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    return this.rows.length;
  }

  /** One attempt on the timer path: at most `perTick` rows, no wait; what is left goes on the next tick. */
  private tick(): void {
    if (!this.attempt(this.perTick, 0)) return;
    if (this.rows.length) this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, 0);
  }

  /** Try to write up to `max` queued rows; on failure, schedule the retry. Returns whether any row was written. */
  private attempt(max: number, waitMs: number): boolean {
    let wrote: number;
    try {
      wrote = this.opts.append(this.rows.slice(0, max), waitMs);
    } catch (e) {
      const reason = (e as Error).message;
      if (this.failures++ === 0) {
        this.failingSince = this.now();
        this.opts.report({ kind: 'failing', reason, queued: this.rows.length });
      }
      if (!this.lasting && (this.failures >= COST_QUEUE_LASTING_AFTER || this.now() - this.failingSince >= COST_QUEUE_LASTING_MS)) {
        this.lasting = true;
        this.opts.report({ kind: 'lasting', reason });
      }
      const wait = this.failures >= this.slowAfter ? this.probeMs : this.retryMs[Math.min(this.failures - 1, this.retryMs.length - 1)];
      this.timer = this.setTimer(() => { this.timer = null; this.tick(); }, wait);
      return false;
    }
    this.rows.splice(0, Math.max(1, wrote));
    if (this.failures > 0 || this.dropped > 0) {
      if (this.dropped > 1) this.opts.report({ kind: 'dropped', count: this.dropped });
      this.failures = 0;
      this.dropped = 0;
      this.lasting = false;
      this.opts.report({ kind: 'recovered' });
    }
    return true;
  }
}
