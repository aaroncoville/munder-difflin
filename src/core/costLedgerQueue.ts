/**
 * The app's cost rows on their way to `cost-ledger.jsonl`. A row is only ever written under the ledger's lock
 * (appendCostLedgerRow); the app's thread does not wait for that lock. Each attempt takes the lock only if it is
 * free at once. When it is not, or the append fails for any other reason (a linked ledger, a volume without hard
 * links, a write that stopped short), the row stays at the head of the queue, the rows behind it wait their turn, and
 * the queue tries again later on a timer, backing off up to RETRY_MAX_MS. A failure is reported once, when it
 * starts; a later success says the queue is writing again.
 *
 * The queue holds at most `cap` rows. A row pushed onto a full queue makes it drop its oldest row, and says so (once
 * per run of drops, with the count). Cost rows are periodic per-agent snapshots, so a later row supersedes a lost one.
 * The queue lives in memory: rows still in it when the process stops without flush() are lost, and the next
 * snapshot of each agent replaces them.
 */

/** The waits before each retry after a failed attempt; the last is repeated. */
export const COST_QUEUE_RETRY_MS = [100, 250, 500, 1000, 2000, 5000] as const;
/** The most rows the queue holds. */
export const COST_QUEUE_CAP = 1000;

export interface CostLedgerQueueOptions {
  /** Appends one row under the ledger's lock, or throws; `waitMs` is how long it may wait for the lock. */
  append: (row: object, waitMs: number) => void;
  /** Told once when appends start failing (with why) or rows are dropped, and once when appends succeed again. */
  report: (event: { kind: 'failing'; reason: string; queued: number } | { kind: 'dropped'; count: number } | { kind: 'recovered' }) => void;
  cap?: number;
  retryMs?: readonly number[];
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class CostLedgerQueue {
  private readonly rows: object[] = [];
  private timer: unknown = null;
  private failures = 0;
  private dropped = 0;
  private readonly cap: number;
  private readonly retryMs: readonly number[];
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;

  constructor(private readonly opts: CostLedgerQueueOptions) {
    this.cap = opts.cap ?? COST_QUEUE_CAP;
    this.retryMs = opts.retryMs ?? COST_QUEUE_RETRY_MS;
    this.setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  /** How many rows are waiting. */
  get size(): number { return this.rows.length; }

  /** Queue `row` and, unless a retry is already due, try to write what is queued now, without waiting for the lock. */
  push(row: object): void {
    if (this.rows.length >= this.cap) {
      this.rows.shift();
      if (this.dropped++ === 0) this.opts.report({ kind: 'dropped', count: 1 });
    }
    this.rows.push(row);
    if (this.timer === null) this.drain(0);
  }

  /** Try to write every queued row now, each attempt waiting up to `waitMs` for the lock (for quitting, where the
   *  thread may wait). Returns how many rows are still queued. */
  flush(waitMs: number): number {
    if (this.timer !== null) { this.clearTimer(this.timer); this.timer = null; }
    this.drain(waitMs);
    return this.rows.length;
  }

  private drain(waitMs: number): void {
    while (this.rows.length) {
      try {
        this.opts.append(this.rows[0], waitMs);
      } catch (e) {
        if (this.failures++ === 0) this.opts.report({ kind: 'failing', reason: (e as Error).message, queued: this.rows.length });
        const wait = this.retryMs[Math.min(this.failures - 1, this.retryMs.length - 1)];
        this.timer = this.setTimer(() => { this.timer = null; this.drain(0); }, wait);
        return;
      }
      this.rows.shift();
      if (this.failures > 0 || this.dropped > 0) {
        if (this.dropped > 1) this.opts.report({ kind: 'dropped', count: this.dropped });
        this.failures = 0;
        this.dropped = 0;
        this.opts.report({ kind: 'recovered' });
      }
    }
  }
}
