'use strict';

/**
 * Codex agents run fine but never reach the cost ledger.
 *
 * The telemetry env that makes an agent push OTel is injected for Claude Code
 * alone, and a Codex agent writes no Claude transcript, so every source the
 * collector reads came back empty: a Codex agent read as $0.00 / 0 tok in the
 * fleet snapshot and had no row in cost-ledger.jsonl at all. Its real numbers
 * are on disk the whole time: Codex appends a `token_count` event with the
 * session's running totals to the session's rollout after every model call.
 *
 * Covers reading those totals (from the end of a rollout that can run to
 * hundreds of MB), pricing them, and gating the ledger so an idle agent's
 * unchanged totals are not written again every beat.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const loadTs = require('./load-ts.cjs');
const { TelemetryCollector } = loadTs('src/main/telemetry.ts');
const { CumulativeSampleGate, RunBaseline, usesCumulativeGate, snapshotUsageFor } = loadTs('src/main/usage.ts');
const { CircuitBreaker } = loadTs('src/main/breaker.ts');
const { lifetimeUsdFromLedger } = loadTs('src/main/costLifetime.ts');

const AGENT = 'reviewer-mt1';
const SESSION = '01a04adb-bf51-7fe0-9627-df7d0dd58837';

function freshHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
}

/** One rollout line, in the shape Codex writes. */
const line = (o) => JSON.stringify(o) + '\n';
const meta = () => line({ timestamp: '2026-10-07T20:00:00.000Z', type: 'session_meta', payload: { id: SESSION } });
const context = (model) => line({ timestamp: '2026-10-07T20:00:01.000Z', type: 'turn_context', payload: { model } });
const rateOnly = () => line({
  timestamp: '2026-10-07T20:00:02.000Z', type: 'event_msg',
  payload: { type: 'token_count', info: null, rate_limits: { primary: { used_percent: 2 } } }
});
function tokens(at, total, last = { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 }) {
  return line({
    timestamp: at, type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { cache_write_input_tokens: 0, reasoning_output_tokens: 0, ...total },
        last_token_usage: { cache_write_input_tokens: 0, reasoning_output_tokens: 0, ...last }
      }
    }
  });
}

/** Writes a rollout under `<home>/<tree>/2026/10/07/` and returns its path. */
function writeRollout(home, body, { tree = 'sessions', session = SESSION } = {}) {
  const dir = path.join(home, tree, '2026', '10', '07');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-07T20-00-00-${session}.jsonl`);
  fs.writeFileSync(file, body);
  return file;
}

const TOTALS = { input_tokens: 1_200_000, cached_input_tokens: 1_000_000, output_tokens: 30_000 };

function collector(home, { sessionId = SESSION } = {}) {
  return new TelemetryCollector({
    resolveCwd: () => null,
    resolveSessionId: () => sessionId,
    resolveCodexHome: () => home
  });
}

test('a Codex agent is costed from its own rollout', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol') + rateOnly() + tokens('2026-10-07T20:05:00.000Z', TOTALS));

  const sample = collector(home).getAgentUsage(AGENT);

  assert.ok(sample, 'no sample: the Codex agent would show $0.00 forever');
  // Codex counts cached input INSIDE input_tokens; the ledger's input is the
  // uncached part, or the cached tokens would be billed twice.
  assert.equal(sample.input, 200_000);
  assert.equal(sample.cacheRead, 1_000_000);
  assert.equal(sample.output, 30_000);
  assert.equal(sample.cacheCreation, 0);
  assert.equal(sample.model, 'gpt-5.6-sol');
  // Dated by the rollout's last change, as the Codex activity readers date it:
  // a long tool call writes output but no token count.
  assert.equal(sample.ts, fs.statSync(path.join(home, 'sessions', '2026', '10', '07',
    `rollout-2026-10-07T20-00-00-${SESSION}.jsonl`)).mtimeMs);
  // 0.2M x $4 + 1M x $0.40 + 0.03M x $20.
  assert.equal(Number(sample.usd.toFixed(4)), 1.8);
});

test('a rollout dated in the future is dated now', () => {
  // A rollout restored from a backup, or written under a clock that ran ahead,
  // can carry a modification time past now; the agent cannot have been active
  // in the future, and the fleet would show it a negative "seconds ago".
  const home = freshHome();
  const file = writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS));
  const ahead = new Date(Date.now() + 3_600_000);
  fs.utimesSync(file, ahead, ahead);
  const before = Date.now();
  const sample = collector(home).getAgentUsage(AGENT);
  assert.ok(sample.ts >= before && sample.ts <= Date.now(), `dated ${sample.ts - Date.now()} ms from now`);
});

test('the sample carries the real session id, so the ledger accepts it', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS));
  // index.ts appends only `if (sample?.sessionId)`.
  assert.equal(collector(home).getAgentUsage(AGENT).sessionId, SESSION);
});

test('the model is the one the latest totals were billed on', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol')
    + tokens('2026-10-07T20:05:00.000Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 10 })
    + context('gpt-6.1-sol')
    + tokens('2026-10-07T20:06:00.000Z', TOTALS)
    + rateOnly());

  const sample = collector(home).getAgentUsage(AGENT);
  assert.equal(sample.cacheRead, 1_000_000);
  assert.equal(sample.model, 'gpt-6.1-sol');
});

test('a restarted Codex process adds to the session, it does not replace it', () => {
  // Codex keeps its running totals per PROCESS: a resumed session starts them
  // again from zero in the same rollout. Taking the last totals alone would
  // forget everything the session spent before the restart.
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol')
    + tokens('2026-10-07T20:05:00.000Z', { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50 })
    + tokens('2026-10-07T20:06:00.000Z', { input_tokens: 900, cached_input_tokens: 300, output_tokens: 70 })
    + meta() + context('gpt-5.6-sol')
    + tokens('2026-10-08T09:00:00.000Z', { input_tokens: 200, cached_input_tokens: 150, output_tokens: 5 }));

  const sample = collector(home).getAgentUsage(AGENT);
  assert.equal(sample.input + sample.cacheRead, 1100, 'input before and after the restart');
  assert.equal(sample.cacheRead, 450);
  assert.equal(sample.output, 75);
});

test('a token count written twice is counted once', () => {
  // Codex re-emits the same totals at times (a later status update carries the
  // previous call's numbers again). Summing each event's per-call usage would
  // bill that call twice.
  const home = freshHome();
  const once = tokens('2026-10-07T20:05:00.000Z', TOTALS);
  writeRollout(home, meta() + context('gpt-5.6-sol') + once + once.replace('20:05:00', '20:05:30'));

  assert.equal(collector(home).getAgentUsage(AGENT).cacheRead, 1_000_000);
});

test('only what was appended since the last read is read again', () => {
  const home = freshHome();
  const file = writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS));
  const c = collector(home);
  assert.equal(c.getAgentUsage(AGENT).output, 30_000);

  // Blank out the part already read, then append a restarted process's first
  // totals. Carrying on from where it stopped, the reader adds them to what it
  // had; starting over from the top, it would see only the new 5.
  const before = fs.readFileSync(file);
  fs.writeFileSync(file, Buffer.alloc(before.length, 0x20));
  fs.appendFileSync(file, '\n' + tokens('2026-10-07T20:09:00.000Z', { input_tokens: 200, cached_input_tokens: 150, output_tokens: 5 }));
  assert.equal(c.getAgentUsage(AGENT).output, 30_005);
});

test('totals far from the end of a large rollout are still found', () => {
  // A long-lived reviewer's rollout runs to 100+ MB, and tool output can push
  // the last token_count megabytes back from the end.
  const home = freshHome();
  const filler = line({ timestamp: '2026-10-07T20:07:00.000Z', type: 'response_item', payload: { output: 'x'.repeat(2000) } });
  writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS) + filler.repeat(1500));

  const sample = collector(home).getAgentUsage(AGENT);
  assert.ok(sample, 'a token_count 3 MB from the end was missed');
  assert.equal(sample.cacheRead, 1_000_000);
  assert.equal(sample.model, 'gpt-5.6-sol');
});

test('an archived session is still read', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS), { tree: 'archived_sessions' });
  assert.equal(collector(home).getAgentUsage(AGENT).cacheRead, 1_000_000);
});

test('only the agent’s own session is read from its home', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS),
    { session: '11111111-2222-3333-4444-555555555555' });
  assert.equal(collector(home).getAgentUsage(AGENT), null);
});

test('no Codex home, no session, or no token_count yet means no data', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol') + rateOnly());
  assert.equal(collector(home).getAgentUsage(AGENT), null, 'nothing billed yet is not a zeroed sample');
  assert.equal(collector(null).getAgentUsage(AGENT), null, 'a Claude agent has no Codex home');
  assert.equal(collector(home, { sessionId: null }).getAgentUsage(AGENT), null);
});

test('an idle Codex agent does not re-append the same ledger row', () => {
  const home = freshHome();
  const file = writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS));
  const gate = new CumulativeSampleGate();
  const read = () => collector(home).getAgentUsage(AGENT);

  assert.equal(usesCumulativeGate('codex'), true, 'a Codex sample always carries a session id');
  assert.equal(gate.admits(read()), true);
  assert.equal(gate.admits(read()), false);
  fs.appendFileSync(file, tokens('2026-10-07T20:09:00.000Z', { ...TOTALS, output_tokens: 31_000 }));
  assert.equal(gate.admits(read()), true);
});

test('only the providers whose samples always carry a session id are gated', () => {
  assert.equal(usesCumulativeGate('grok'), true);
  assert.equal(usesCumulativeGate('codex'), true);
  // The live-OTel path writes only when there is a live session; gating it as
  // well would change what Claude agents record.
  assert.equal(usesCumulativeGate('claude'), false);
  assert.equal(usesCumulativeGate(undefined), false);
});

test('a model switch prices each call at the model it ran on', () => {
  // Codex's /model changes the model mid-session. Pricing every total at the
  // latest model would reprice the whole history, and the lifetime fold reads
  // the resulting drop in usd as a counter reset and adds the two together.
  const home = freshHome();
  const file = writeRollout(home, meta() + context('gpt-5.6-sol')
    + tokens('2026-10-07T20:05:00.000Z', { input_tokens: 10_000_000, cached_input_tokens: 0, output_tokens: 1_000_000 }));
  const c = collector(home);
  const before = c.getAgentUsage(AGENT);
  // 10M x $4 + 1M x $20.
  assert.equal(Number(before.usd.toFixed(4)), 60);

  fs.appendFileSync(file, context('gpt-6.1-sol')
    + tokens('2026-10-07T20:06:00.000Z', { input_tokens: 10_001_000, cached_input_tokens: 0, output_tokens: 1_000_000 }));
  const after = c.getAgentUsage(AGENT);
  // The history stays at its own price; the new call costs 1,000 x $2/M.
  assert.equal(Number(after.usd.toFixed(4)), 60.002);
  assert.equal(after.model, 'gpt-6.1-sol', 'the model shown is still the latest');

  // The row appendCostLedger writes.
  const row = (r) => JSON.stringify({ agent_id: r.agentId, session_id: r.sessionId, ts: r.ts, usd: r.usd });
  const ledger = [before, after].map(row).join('\n');
  assert.equal(Number(lifetimeUsdFromLedger(ledger).get(AGENT).toFixed(4)), 60.002, 'lifetime counted the history twice');
});

test('a resume whose first call outgrows the last process is still a restart', () => {
  // A process that made one 150,000-token call, then a resume whose first call
  // is bigger. No counter drops, but the new process's totals are exactly its
  // first call: everything in them is new.
  const home = freshHome();
  const first = { input_tokens: 150_000, cached_input_tokens: 0, output_tokens: 250 };
  const resumed = { input_tokens: 210_000, cached_input_tokens: 0, output_tokens: 300 };
  writeRollout(home, meta() + context('gpt-5.6-sol')
    + tokens('2026-10-07T20:05:00.000Z', first, first)
    + meta() + context('gpt-5.6-sol')
    + tokens('2026-10-08T09:00:00.000Z', resumed, resumed));

  const sample = collector(home).getAgentUsage(AGENT);
  assert.equal(sample.input, 360_000);
  assert.equal(sample.output, 550);
});

test('a drop in output alone is a restart too', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol')
    + tokens('2026-10-07T20:05:00.000Z', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 900 })
    + tokens('2026-10-08T09:00:00.000Z', { input_tokens: 400, cached_input_tokens: 0, output_tokens: 20 }));

  const sample = collector(home).getAgentUsage(AGENT);
  assert.equal(sample.input, 500);
  assert.equal(sample.output, 920);
});

test('a first call written twice is counted once', () => {
  // The restart marker (per-call usage equal to the totals) is on both copies.
  const home = freshHome();
  const call = { input_tokens: 150_000, cached_input_tokens: 0, output_tokens: 250 };
  const once = tokens('2026-10-07T20:05:00.000Z', call, call);
  writeRollout(home, meta() + context('gpt-5.6-sol') + once + once.replace('20:05:00', '20:05:30'));

  assert.equal(collector(home).getAgentUsage(AGENT).input, 150_000);
});

test('the breaker sees what a Codex session spends in this run, not its history', () => {
  // The rollout holds every call since the session began, across every resume.
  // A per-agent cap means "this run" for agents measured by live telemetry; fed
  // the whole history, a long-lived session trips its cap on the first beat.
  const T0 = 1_000_000_000_000;
  const breaker = new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 1e12, agentTokenCaps: { [AGENT]: 2_500_000 }
  }));
  const history = { agentId: AGENT, sessionId: SESSION, ts: T0, input: 14_400_000, output: 900_000,
    cacheRead: 360_000_000, cacheCreation: 0, model: 'gpt-5.6-sol', usd: 220 };
  const baseline = new RunBaseline();
  const beat = (s, now) => breaker.tick([{ agentId: AGENT, sample: s, progressing: true, lastWorkAt: now }], now)
    .find((d) => d.state.agentId === AGENT).state;

  const first = baseline.sinceFirstSight(history);
  assert.deepEqual([first.input, first.output, first.cacheRead, first.cacheCreation, first.usd], [0, 0, 0, 0, 0]);
  assert.equal(beat(first, T0).level, 'healthy');

  const later = baseline.sinceFirstSight({ ...history, ts: T0 + 60_000, input: 16_400_000, output: 1_600_000, usd: 242 });
  assert.equal(later.input, 2_000_000);
  assert.equal(later.output, 700_000);
  assert.equal(later.usd, 22);
  assert.equal(later.sessionId, SESSION);
  const state = beat(later, T0 + 60_000);
  assert.equal(state.level, 'steering', 'work done in this run is still capped');
  assert.match(state.reason, /^token limit: 2,700,000 work tokens/);
});

test('a session that replaces another in this run is counted from zero', () => {
  const s = { agentId: AGENT, sessionId: SESSION, ts: 1, input: 5_000, output: 50, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 1 };
  const baseline = new RunBaseline();
  baseline.sinceFirstSight(s);
  assert.equal(baseline.sinceFirstSight({ ...s, input: 6_000 }).input, 1_000);
  // The agent started a new thread while this run watched: everything that
  // session holds was spent in this run, including what it spent before the
  // beat first saw it.
  const fresh = baseline.sinceFirstSight({ ...s, sessionId: 'other', input: 9_000, output: 90, usd: 2 });
  assert.deepEqual([fresh.input, fresh.output, fresh.usd], [9_000, 90, 2]);
  assert.equal(baseline.sinceFirstSight({ ...s, sessionId: 'other', input: 9_500 }).input, 9_500);
  // A new thread usually holds far less than the long one it replaced.
  const long = new RunBaseline();
  long.sinceFirstSight({ ...s, input: 14_000_000, output: 900_000, usd: 200 });
  const small = long.sinceFirstSight({ ...s, sessionId: 'third', input: 400, output: 5, usd: 0.1 });
  assert.deepEqual([small.input, small.output, small.usd], [400, 5, 0.1]);
});

test('a forgotten agent starts its baseline again at the next sample', () => {
  const s = { agentId: AGENT, sessionId: SESSION, ts: 1, input: 5_000, output: 50, cacheRead: 0, cacheCreation: 0, model: 'm', usd: 1 };
  const baseline = new RunBaseline();
  baseline.sinceFirstSight(s);
  baseline.forget(AGENT);
  // A respawn resumes whatever session it finds; its history is not this run's.
  assert.equal(baseline.sinceFirstSight({ ...s, sessionId: 'other', input: 9_900 }).input, 0);
});

test('the fleet snapshot shows a Codex agent the sample its ledger records', () => {
  const home = freshHome();
  writeRollout(home, meta() + context('gpt-5.6-sol') + tokens('2026-10-07T20:05:00.000Z', TOTALS));
  const c = collector(home);
  const pulled = snapshotUsageFor('codex', undefined, () => c.getAgentUsage(AGENT));
  assert.equal(pulled.cacheRead, 1_000_000, 'the snapshot showed 0 tokens for a Codex agent');

  const live = { agentId: AGENT, usd: 3 };
  assert.equal(snapshotUsageFor('codex', live, () => assert.fail('read the file despite live telemetry')), live);
  // A Claude agent without live telemetry stays as it was: no fallback read.
  assert.equal(snapshotUsageFor('claude', undefined, () => assert.fail('read a transcript for the snapshot')), undefined);
  assert.equal(snapshotUsageFor('codex', undefined, () => null), undefined);
});

/** Run the real runBreakerBeat from index.ts against stubbed surroundings, with
 *  the real breaker, ledger gate and run baseline. */
function breakerBeatHarness({ provider, cap }) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const start = source.indexOf('function runBreakerBeat(progressWindowMs: number): void {');
  const end = source.indexOf('/** Lifetime spend, folded', start);
  assert.ok(start >= 0 && end > start, 'runBreakerBeat located in index.ts');
  const body = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ledger = [];
  const sent = [];
  let next = null;
  const hive = {
    enabled: () => true,
    registry: () => ({ godId: 'god', agents: { [AGENT]: { name: 'Reviewer', provider } } }),
    appendCostLedger: (s) => ledger.push(s),
    recordSession: () => {},
    send: (m) => sent.push(m.subject)
  };
  const breaker = new CircuitBreaker(() => ({
    enabled: true, hardStop: false, repeatedToolLimit: 8, errorStormLimit: 5,
    tokenVelocityPerMin: 1e12, agentTokenCaps: { [AGENT]: cap }
  }));
  // eslint-disable-next-line no-new-func
  const beat = new Function(
    'hive', 'usageProvider', 'usesCumulativeGate', 'grokLedgerGate', 'breakerBaseline', 'ptyForAgent',
    'telemetry', 'lastCoordinationAt', 'lastWorkAt', 'breaker', 'liveWebContents', 'breakerToast',
    'ptyManager', 'teardownPty',
    `${body}\nreturn runBreakerBeat;`
  )(
    hive, { getAgentUsage: () => next }, usesCumulativeGate, new CumulativeSampleGate(), new RunBaseline(), () => 'pty-1',
    { getSpans: () => [] }, () => Date.now(), () => Date.now(), breaker, () => null, () => {},
    { kill: () => {} }, () => {}
  );
  return {
    ledger,
    sent,
    run(sample) { next = sample; beat(300_000); }
  };
}

test('a Codex session with a long history is not stopped by its cap on the first beat', () => {
  // The live shape: a reviewer whose rollout holds 15M work tokens across a
  // month of resumes, under a 2.5M cap.
  const h = breakerBeatHarness({ provider: 'codex', cap: 2_500_000 });
  const history = { agentId: AGENT, sessionId: SESSION, ts: Date.now(), input: 14_400_000, output: 900_000,
    cacheRead: 360_000_000, cacheCreation: 0, model: 'gpt-5.6-sol', usd: 220 };

  h.run(history);
  h.run({ ...history, ts: Date.now(), input: 14_500_000, usd: 220.4 });
  assert.deepEqual(h.sent, [], 'steered or constrained for work done before this run');
  assert.deepEqual(h.ledger.map((r) => r.input), [14_400_000, 14_500_000], 'the ledger keeps the cumulative rows');

  h.run({ ...history, ts: Date.now(), input: 17_000_000, usd: 230 });
  assert.deepEqual(h.sent, ['Circuit breaker: steer'], 'work done in this run is still capped');
});
