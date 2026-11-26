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
import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, realpathSync, rmSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, isAbsolute, join, relative } from 'node:path';
import { parseHeadlessOutput, runHeadlessSeat, type HeadlessRun, type HeadlessSeatOptions } from './headlessSeat';
import { isPlainObject } from './launchLine';
import { isSafeMessageId } from './messageId';
import { assertRealFolder } from './sentFolder';
import { seatWriteRoots } from './writeRoots';

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

/*
 * The done-check. A stream's brief names the file its run produces, and the run is done only when that file is
 * there: a regular file (not a link, wherever it points), not empty, and inside the seat's write roots
 * (seatWriteRoots), judged on its real path so a linked folder cannot lead the check out of them. Otherwise the
 * result says why it is not done.
 *
 * Only a done run tells god, with one message in the hive's mail format, written into the seat's own outbox for the
 * app to deliver like any agent's mail: a JSON file named by its own id, with to, act ("done", which is terminal, so
 * god does not reply), subject and body. Writing into god's inbox directly would bypass the router, which is the
 * only writer of inboxes.
 */

export interface HeadlessSeatPlace {
  hiveRoot: string;
  agentId: string;
  isGod?: boolean;
  /** The seat's working folder. */
  cwd: string;
}

export interface HeadlessDoneCheck {
  done: boolean;
  /** Why the run is not done; null when it is. */
  reason: string | null;
}

const inside = (root: string, p: string): boolean => {
  const rel = relative(root, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

/** Whether the run's output file is in place: see above. Never throws. */
export function checkHeadlessOutput(seat: HeadlessSeatPlace, outputFile: string | null): HeadlessDoneCheck {
  const no = (reason: string): HeadlessDoneCheck => ({ done: false, reason });
  if (!outputFile) return no('no output file was named for the run');
  if (!isAbsolute(outputFile)) return no(`the output file ${outputFile} is not an absolute path`);
  let st;
  try { st = lstatSync(outputFile); } catch { return no(`the output file ${outputFile} does not exist`); }
  if (st.isSymbolicLink()) return no(`the output file ${outputFile} is a link, not the file itself`);
  if (!st.isFile()) return no(`the output file ${outputFile} is not a regular file`);
  if (st.size === 0) return no(`the output file ${outputFile} is empty`);
  let real: string;
  try { real = realpathSync(outputFile); } catch { return no(`the output file ${outputFile} cannot be resolved`); }
  const roots = seatWriteRoots({ root: seat.hiveRoot, agentId: seat.agentId, isGod: seat.isGod === true, cwd: seat.cwd });
  const realRoots = roots.flatMap((r) => { try { return [realpathSync(r)]; } catch { return []; } });
  if (!realRoots.some((r) => inside(r, real))) return no(`the output file ${outputFile} is outside the seat's write roots`);
  return { done: true, reason: null };
}

/** A message as an agent writes it into its outbox (PROTOCOL.md); the router fills in the rest. */
export interface OutboxMessage {
  id: string;
  to: string;
  act: 'done' | 'inform';
  subject: string;
  body: string;
  created_at: string;
}

/** A message id in the router's own form (time stamp, then random hex), always a safe file name. */
function mintMessageId(now: number): string {
  return `${new Date(now).toISOString().replace(/[:.]/g, '-')}-headless-${randomBytes(4).toString('hex')}`;
}

/** At most this much of the run's result text goes into the message. */
const RESULT_EXCERPT = 2000;

/** The message that tells god a run is done: what produced what, at what cost. */
export function headlessDoneMessage(agentId: string, run: HeadlessRun, outputFile: string, cost: { costRecorded: boolean; costReason: string | null }, now = Date.now()): OutboxMessage {
  const usd = run.totalCostUsd === null ? 'unknown' : `$${run.totalCostUsd}`;
  const ledger = cost.costRecorded ? 'recorded in cost-ledger.jsonl' : `not recorded: ${cost.costReason ?? 'no reason given'}`;
  const result = run.result === null ? '' : run.result.length > RESULT_EXCERPT ? `${run.result.slice(0, RESULT_EXCERPT)}...` : run.result;
  const body = [
    `The headless run for ${agentId} is done: its output file is in place.`,
    `Output: ${outputFile}`,
    `Exit: exit ${run.exitCode ?? 'none'}${run.subtype ? ` (${run.subtype})` : ''}`,
    `Cost: ${usd} (${ledger})`,
    `Session: ${run.sessionId ?? 'none'}`,
    ...(result ? ['', 'Result:', result] : []),
  ].join('\n');
  return { id: mintMessageId(now), to: 'god', act: 'done', subject: `Headless run done: ${basename(outputFile)}`.replace(/[\r\n]+/g, ' '), body, created_at: new Date(now).toISOString() };
}

/** How many fresh ids to try when a name is already taken. */
const MAX_ID_ATTEMPTS = 100;

/** Write `msg` into `<hiveRoot>/agents/<agentId>/outbox/<id>.json` and return the id used. The file appears whole
 *  (written under a name the router skips, then linked into place without replacing anything), and the agent
 *  folder and outbox must be real folders, never links. Throws when it cannot. */
export function writeOutboxMessage(hiveRoot: string, agentId: string, msg: OutboxMessage): string {
  const folder = join(hiveRoot, 'agents', agentId);
  assertRealFolder(folder);
  const outbox = join(folder, 'outbox');
  try { mkdirSync(outbox); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
  assertRealFolder(outbox);
  const temp = join(outbox, `.headless-${randomBytes(6).toString('hex')}.tmp`);
  let id = msg.id;
  try {
    for (let attempt = 0; attempt < MAX_ID_ATTEMPTS; attempt++, id = mintMessageId(Date.now())) {
      if (!isSafeMessageId(id)) continue;
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
      try { writeSync(fd, JSON.stringify({ ...msg, id }, null, 2)); } finally { closeSync(fd); }
      try {
        linkSync(temp, join(outbox, `${id}.json`));
        return id;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
  throw new Error('no free message id in the outbox');
}

/*
 * One stream, end to end: run the turn, record its cost, check its output, and tell god only when it is done.
 *
 * A run that is not done sends no message. The result says why (doneReason), and the caller that scheduled the run
 * decides what to do about it: retry, or report it once. A "not done" message from every failed attempt would reach
 * god as noise, and one from the seat's outbox would read as the seat's own word on a run that may never have
 * started properly.
 */

export interface HeadlessStreamOptions extends HeadlessSeatOptions {
  /** The file the stream's brief says the run produces; the run is done only when it is in place. */
  outputFile: string;
}

export interface HeadlessStreamResult {
  run: HeadlessRun;
  cost: HeadlessCost;
  done: boolean;
  /** Why the run is not done; null when it is. */
  doneReason: string | null;
  /** The done message's id; null when none was written. */
  messageId: string | null;
  /** Why a done run's message could not be written; null otherwise. */
  messageError: string | null;
}

/** Run one headless turn, then record its cost, check its output and, when it is done, mail god. A refused launch
 *  throws before anything runs or is written. */
export async function runHeadlessStream(o: HeadlessStreamOptions): Promise<HeadlessStreamResult> {
  const run = await runHeadlessSeat(o);
  const cost = recordHeadlessCost(o.hiveRoot, o.agentId, run);
  const check: HeadlessDoneCheck = run.ok
    ? checkHeadlessOutput({ hiveRoot: o.hiveRoot, agentId: o.agentId, isGod: o.isGod, cwd: o.cwd }, o.outputFile)
    : { done: false, reason: `the run did not succeed: ${run.error ?? `the CLI reported ${run.subtype ?? 'an error'}`}` };
  const result: HeadlessStreamResult = { run, cost, done: check.done, doneReason: check.reason, messageId: null, messageError: null };
  if (!check.done) return result;
  try {
    result.messageId = writeOutboxMessage(o.hiveRoot, o.agentId, headlessDoneMessage(o.agentId, run, o.outputFile, cost));
  } catch (e) {
    result.messageError = (e as Error).message;
  }
  return result;
}
