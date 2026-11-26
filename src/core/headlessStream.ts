/**
 * What happens after a headless seat's turn (headlessSeat.ts), outside the app.
 *
 * The cost ledger. The app writes `<hive>/cost-ledger.jsonl` only on its own beat, for live terminal sessions, so a
 * headless run would otherwise spend money that no ledger shows. After the run, the cost the CLI reported
 * (total_cost_usd) is appended as one row in the app's own shape: agent_id, session_id, ts (epoch ms), input,
 * output, cache_read, cache_creation, model and usd, so the lifetime fold (costLifetime.ts) and the later SQLite
 * import read it as they read the app's rows. Two keys are added, which those readers ignore: source "headless", and
 * stop "max_budget_usd" on a run the CLI stopped at its --max-budget-usd cap.
 *
 * The ledger keeps cumulative totals per (agent, session), and one headless run is one session whose total the CLI
 * reports once, so one row per run is that session's total.
 *
 * Only a cost the CLI reported is written. A run that timed out never finished, so its cost is unknown, and a run
 * that printed no cost has none to write: neither gets a row, and the result says why. A guessed 0 would read as a
 * free run.
 *
 * Like every service outside the app, this only writes files: one append, never a commit. The row goes out in one
 * write to a file opened for appending, so it cannot interleave with the app's rows, and never through a link.
 */
import { closeSync, constants, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { parseHeadlessOutput, type HeadlessRun } from './headlessSeat';
import { isPlainObject } from './launchLine';

export const COST_LEDGER_FILE = 'cost-ledger.jsonl';

export interface HeadlessCostRow {
  agent_id: string;
  session_id: string;
  ts: number;
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  model: string;
  usd: number;
  source: 'headless';
  stop?: 'max_budget_usd';
}

export interface HeadlessCost {
  costRecorded: boolean;
  /** Why no row was written; null when one was. */
  costReason: string | null;
  row: HeadlessCostRow | null;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);

/** The model the run spent most on, from the result's modelUsage; else the --model on the launch line; else ''. */
function modelOf(result: Record<string, unknown> | null, argv: string[]): string {
  const usage = result?.modelUsage;
  if (isPlainObject(usage)) {
    let best: string | null = null;
    let bestUsd = -1;
    for (const [name, u] of Object.entries(usage)) {
      const usd = isPlainObject(u) ? count(u.costUSD) : 0;
      if (usd > bestUsd) { best = name; bestUsd = usd; }
    }
    if (best) return best;
  }
  const at = argv.indexOf('--model');
  return at !== -1 && typeof argv[at + 1] === 'string' ? argv[at + 1] : '';
}

/** The ledger row for a finished run, or why it gets none. */
export function headlessCostRow(agentId: string, run: HeadlessRun, now: number): { row: HeadlessCostRow | null; reason: string | null } {
  if (run.timedOut) return { row: null, reason: 'the run timed out, so its cost is unknown' };
  if (run.totalCostUsd === null) return { row: null, reason: 'the CLI reported no cost' };
  if (!run.sessionId) return { row: null, reason: 'the CLI reported no session id, which the ledger is keyed by' };
  const result = parseHeadlessOutput(run.stdout).result;
  const u = isPlainObject(result?.usage) ? (result.usage as Record<string, unknown>) : {};
  const row: HeadlessCostRow = {
    agent_id: agentId, session_id: run.sessionId, ts: now,
    input: count(u.input_tokens), output: count(u.output_tokens),
    cache_read: count(u.cache_read_input_tokens), cache_creation: count(u.cache_creation_input_tokens),
    model: modelOf(result, run.argv), usd: run.totalCostUsd, source: 'headless',
  };
  if (run.outcome === 'budget-stop') row.stop = 'max_budget_usd';
  return { row, reason: null };
}

/** Append one row to `<hiveRoot>/cost-ledger.jsonl` in a single write, or nothing; never throws. */
export function recordHeadlessCost(hiveRoot: string, agentId: string, run: HeadlessRun, now = Date.now()): HeadlessCost {
  const { row, reason } = headlessCostRow(agentId, run, now);
  if (!row) return { costRecorded: false, costReason: reason, row: null };
  const line = Buffer.from(`${JSON.stringify(row)}\n`, 'utf8');
  let fd: number | null = null;
  try {
    fd = openSync(join(hiveRoot, COST_LEDGER_FILE), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o644);
    const wrote = writeSync(fd, line);
    if (wrote !== line.length) return { costRecorded: false, costReason: `the ledger append failed: wrote ${wrote} of ${line.length} bytes`, row: null };
    return { costRecorded: true, costReason: null, row };
  } catch (e) {
    return { costRecorded: false, costReason: `the ledger append failed: ${(e as Error).message}`, row: null };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
