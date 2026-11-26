'use strict';
// What happens after a headless seat's turn, outside the app:
//  - its cost is appended to <hive>/cost-ledger.jsonl as ONE newline-terminated JSON line, in the row shape the app
//    writes (agent_id, session_id, ts, input, output, cache_read, cache_creation, model, usd) plus source "headless",
//    and stop "max_budget_usd" when the CLI stopped on its budget. Only a cost the CLI reported is written: a run
//    with no cost, or one that timed out (cost unknown), writes no row and says why. Nothing else is written and
//    nothing is committed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/core/headlessStream.ts');
const { lifetimeUsdFromLedger } = loadTs('src/core/costLifetime.ts');

const SESSION = '8c1d2f3a-0000-4000-8000-000000000001';
const RESULT = {
  type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION, total_cost_usd: 0.0042,
  usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 560, cache_creation_input_tokens: 78 },
  modelUsage: { 'claude-haiku-4-5-20251001': { costUSD: 0.004 }, 'claude-sonnet-x': { costUSD: 0.0002 } },
};

/** A finished run as runHeadlessSeat resolves it. */
function run(more = {}, result = RESULT) {
  return {
    ok: true, outcome: 'success', exitCode: 0, signal: null, result: 'ok', sessionId: SESSION, totalCostUsd: 0.0042, subtype: 'success',
    error: null, stdout: `${JSON.stringify(result)}\n`, stderr: '', argv: ['claude', '-p', '--model', 'haiku', 'Say ok.'],
    cwd: '/w', settingsFile: '/s.json', outputFile: null, timedOut: false, killSignal: null, ...more,
  };
}

function hive(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdst-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'hive');
  fs.mkdirSync(path.join(root, 'agents', 'ag1'), { recursive: true });
  return { base, root, ledger: path.join(root, 'cost-ledger.jsonl') };
}

const lines = (file) => fs.readFileSync(file, 'utf8').split('\n');

// --- cost ledger ---------------------------------------------------------------------------------------------------

test('Given a run that reported its cost, when its cost is recorded, then exactly one newline-terminated row in the app\'s shape is appended after the existing rows', (t) => {
  const h = hive(t);
  const before = `${JSON.stringify({ agent_id: 'other', session_id: 's0', ts: 1, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 1 })}\n`;
  fs.writeFileSync(h.ledger, before);
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 1_700_000_000_000);
  assert.equal(c.costRecorded, true);
  assert.equal(c.costReason, null);
  const text = fs.readFileSync(h.ledger, 'utf8');
  assert.ok(text.startsWith(before), 'the existing rows are untouched');
  const added = text.slice(before.length);
  assert.ok(added.endsWith('\n') && added.indexOf('\n') === added.length - 1, 'one line, newline-terminated');
  assert.deepEqual(JSON.parse(added), {
    agent_id: 'ag1', session_id: SESSION, ts: 1_700_000_000_000, input: 12, output: 34, cache_read: 560, cache_creation: 78,
    model: 'claude-haiku-4-5-20251001', usd: 0.0042, source: 'headless',
  });
  assert.deepEqual(c.row, JSON.parse(added));
});

test('Given a recorded headless row, when the app folds the ledger for lifetime spend, then the run\'s cost counts for its agent', (t) => {
  const h = hive(t);
  S.recordHeadlessCost(h.root, 'ag1', run(), 5);
  assert.equal(lifetimeUsdFromLedger(fs.readFileSync(h.ledger, 'utf8')).get('ag1'), 0.0042);
});

test('Given a run whose result names no model, when its cost is recorded, then the model asked for on the launch line is used', (t) => {
  const h = hive(t);
  const { modelUsage, ...bare } = RESULT;
  const c = S.recordHeadlessCost(h.root, 'ag1', run({ stdout: JSON.stringify(bare) }, bare), 5);
  assert.equal(c.row.model, 'haiku');
});

test('Given a run with no reported cost, when its cost is recorded, then no row is written and the result says why', (t) => {
  const h = hive(t);
  const c = S.recordHeadlessCost(h.root, 'ag1', run({ ok: false, totalCostUsd: null, error: 'the CLI printed no JSON result object' }), 5);
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /no cost/);
  assert.equal(c.row, null);
  assert.equal(fs.existsSync(h.ledger), false, 'the ledger is not even created');
});

test('Given a run stopped by its budget, when its cost is recorded, then the row carries its cost and a budget-stop marker', (t) => {
  const h = hive(t);
  const capped = { ...RESULT, subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.051 };
  const c = S.recordHeadlessCost(h.root, 'ag1', run({ ok: false, outcome: 'budget-stop', exitCode: 1, subtype: 'error_max_budget_usd', totalCostUsd: 0.051 }, capped), 5);
  assert.equal(c.costRecorded, true);
  const rows = lines(h.ledger).filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].usd, 0.051);
  assert.equal(rows[0].stop, 'max_budget_usd');
  assert.equal(rows[0].source, 'headless');
});

test('Given a run that timed out, when its cost is recorded, then no row is written because the cost is unknown', (t) => {
  const h = hive(t);
  // Even if a number were somehow present, a run that never finished has no total to record.
  const c = S.recordHeadlessCost(h.root, 'ag1', run({ ok: false, timedOut: true, killSignal: 'SIGTERM', totalCostUsd: 0.01 }), 5);
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /timed out/);
  assert.equal(fs.existsSync(h.ledger), false);
});

test('Given a run with a cost but no session id, when its cost is recorded, then no row is written, since the ledger is keyed by session', (t) => {
  const h = hive(t);
  const c = S.recordHeadlessCost(h.root, 'ag1', run({ sessionId: null }), 5);
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /session/);
  assert.equal(fs.existsSync(h.ledger), false);
});

test('Given the ledger path is a link to a file elsewhere, when a cost is recorded, then nothing is written through the link and the result says so', (t) => {
  const h = hive(t);
  const elsewhere = path.join(h.base, 'elsewhere.txt');
  fs.writeFileSync(elsewhere, 'keep\n');
  fs.symlinkSync(elsewhere, h.ledger);
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5);
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /append failed/);
  assert.equal(fs.readFileSync(elsewhere, 'utf8'), 'keep\n');
});
