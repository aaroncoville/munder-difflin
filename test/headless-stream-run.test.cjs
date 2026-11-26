'use strict';
// runHeadlessStream runs one headless turn and then, in order: records its cost in <hive>/cost-ledger.jsonl when the
// cost is known, checks the output file its brief names, and only when the run succeeded and that file is in place
// writes one "done" message to god into the seat's own outbox. A run that is not done sends no message; the result
// says why. Nothing else in the hive changes: no other file is written and nothing is committed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/core/headlessStream.ts');
const { stageHookRuntime } = loadTs('src/core/hookRuntime.ts');

const NODE_DIR = path.dirname(process.execPath);
const SESSION = '8c1d2f3a-0000-4000-8000-000000000001';
const SUCCESS = {
  type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: SESSION, total_cost_usd: 0.0042,
  usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 560, cache_creation_input_tokens: 78 },
  modelUsage: { 'claude-haiku-4-5-20251001': { costUSD: 0.0042 } },
};

/** A temporary hive with the seat's folder (and outbox) and evidence/, a working folder outside it, private settings
 *  and hook-runtime folders outside it, and a stub `claude` printing `canned`. */
function floor(t, canned) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdsr-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const hiveRoot = path.join(base, 'hive');
  fs.mkdirSync(path.join(hiveRoot, 'agents', 'ag1', 'outbox'), { recursive: true });
  fs.mkdirSync(path.join(hiveRoot, 'evidence'));
  fs.writeFileSync(path.join(hiveRoot, 'tasks.json'), '{"tasks":[]}\n');
  fs.writeFileSync(path.join(hiveRoot, 'cost-ledger.jsonl'), `${JSON.stringify({ agent_id: 'other', session_id: 's0', ts: 1, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 1 })}\n`);
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  const hookRuntime = stageHookRuntime({
    dir: path.join(base, 'app', 'hook-runtime'), hiveRoot, platform: process.platform,
    launcher: { name: 'node-launcher', content: '#!/bin/sh\nexec node "$@"\n', mode: 0o755 },
    shim: { name: 'hive-hook.cjs', content: 'process.exit(0);\n', mode: 0o644 },
  });
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const cli = path.join(bin, 'claude');
  fs.copyFileSync(path.join(__dirname, 'headless-claude-stub.cjs'), cli);
  fs.chmodSync(cli, 0o755);
  fs.writeFileSync(path.join(bin, 'canned.json'), JSON.stringify(canned ?? { stdout: `${JSON.stringify(SUCCESS)}\n` }));
  const opts = (more = {}) => ({
    prompt: 'Write the report.', hiveRoot, agentId: 'ag1', cwd, settingsDir: path.join(base, 'app', 'settings'), hookRuntime, cliPath: cli,
    enabledPlugins: {}, noPlugins: true, managedSettingsFile: path.join(base, 'managed', 'managed-settings.json'), parentEnv: { HOME: base, PATH: `${NODE_DIR}:/usr/bin:/bin` }, outputFile: path.join(cwd, 'report.md'),
    ...more,
  });
  const outbox = path.join(hiveRoot, 'agents', 'ag1', 'outbox');
  return { base, hiveRoot, cwd, cli, opts, outbox, ledger: path.join(hiveRoot, 'cost-ledger.jsonl') };
}

/** Every entry under `dir`: a file's content, a folder, or a link's target. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name);
      const rel = path.relative(dir, p);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[rel] = `link:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[rel] = 'dir'; walk(p); }
      else out[rel] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** What changed between two snapshots, as { added, changed, removed } lists of paths. */
function diff(a, b) {
  return {
    added: Object.keys(b).filter((k) => !(k in a)).sort(),
    changed: Object.keys(b).filter((k) => k in a && a[k] !== b[k]).sort(),
    removed: Object.keys(a).filter((k) => !(k in b)).sort(),
  };
}

const ledgerRows = (f) => fs.readFileSync(f.ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('Given a run that succeeds and writes its output, when the stream runs, then one ledger row and one done message land, and nothing else in the hive changes', async (t) => {
  const f = floor(t, { stdout: `${JSON.stringify(SUCCESS)}\n`, writes: { 'report.md': 'the report\n' } });
  const before = snapshot(f.hiveRoot);
  const s = await S.runHeadlessStream(f.opts());
  assert.equal(s.run.ok, true);
  assert.equal(s.cost.costRecorded, true);
  assert.equal(s.done, true);
  assert.equal(s.doneReason, null);
  assert.ok(s.messageId);
  const after = snapshot(f.hiveRoot);
  assert.deepEqual(diff(before, after), { added: [`agents/ag1/outbox/${s.messageId}.json`], changed: ['cost-ledger.jsonl'], removed: [] });
  const rows = ledgerRows(f);
  assert.equal(rows.length, 2, 'exactly one row appended');
  assert.equal(rows[1].agent_id, 'ag1');
  assert.equal(rows[1].usd, 0.0042);
  const m = JSON.parse(after[`agents/ag1/outbox/${s.messageId}.json`]);
  assert.equal(m.to, 'god');
  assert.equal(m.act, 'done');
  assert.ok(m.body.includes(path.join(f.cwd, 'report.md')));
});

for (const [name, prepare, why] of [
  ['missing', () => {}, /does not exist/],
  ['empty', (f) => fs.writeFileSync(path.join(f.cwd, 'report.md'), ''), /empty/],
  ['a link out of the roots', (f) => { fs.writeFileSync(path.join(f.base, 'x.md'), 'x\n'); fs.symlinkSync(path.join(f.base, 'x.md'), path.join(f.cwd, 'report.md')); }, /link/],
]) {
  test(`Given a run that succeeds but whose output file is ${name}, when the stream runs, then it is not done, no message is sent, and only the ledger row lands`, async (t) => {
    const f = floor(t);
    prepare(f);
    const before = snapshot(f.hiveRoot);
    const s = await S.runHeadlessStream(f.opts());
    assert.equal(s.run.ok, true);
    assert.equal(s.done, false);
    assert.match(s.doneReason, why);
    assert.equal(s.messageId, null);
    assert.deepEqual(fs.readdirSync(f.outbox), [], 'no message');
    assert.deepEqual(diff(before, snapshot(f.hiveRoot)), { added: [], changed: ['cost-ledger.jsonl'], removed: [] });
  });
}

test('Given a run that succeeds but whose output file is outside the seat\'s roots, when the stream runs, then it is not done and no message is sent', async (t) => {
  const f = floor(t);
  const outside = path.join(f.base, 'report.md');
  fs.writeFileSync(outside, 'x\n');
  const s = await S.runHeadlessStream(f.opts({ outputFile: outside }));
  assert.equal(s.done, false);
  assert.match(s.doneReason, /outside the seat's write roots/);
  assert.equal(s.messageId, null);
  assert.deepEqual(fs.readdirSync(f.outbox), []);
});

test('Given a run that fails although its output file is in place, when the stream runs, then it is not done and no message is sent', async (t) => {
  const f = floor(t, { stdout: JSON.stringify(SUCCESS), exitCode: 2, writes: { 'report.md': 'the report\n' } });
  const s = await S.runHeadlessStream(f.opts());
  assert.equal(s.run.ok, false);
  assert.equal(s.done, false);
  assert.match(s.doneReason, /did not succeed/);
  assert.deepEqual(fs.readdirSync(f.outbox), []);
  assert.equal(ledgerRows(f).length, 2, 'the cost it reported is still recorded');
});

test('Given a run stopped by its budget, when the stream runs, then its row carries the budget-stop marker and it is not done', async (t) => {
  const capped = { ...SUCCESS, subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 0.051 };
  const f = floor(t, { stdout: JSON.stringify(capped), exitCode: 1, writes: { 'report.md': 'partial\n' } });
  const s = await S.runHeadlessStream(f.opts({ maxBudgetUsd: 0.05 }));
  assert.equal(s.done, false);
  const rows = ledgerRows(f);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].stop, 'max_budget_usd');
  assert.equal(rows[1].usd, 0.051);
  assert.deepEqual(fs.readdirSync(f.outbox), []);
});

test('Given a run that times out, when the stream runs, then no ledger row and no message land and the hive is unchanged', { timeout: 15000 }, async (t) => {
  const f = floor(t);
  fs.copyFileSync(path.join(__dirname, 'headless-hang-stub.cjs'), f.cli);
  fs.chmodSync(f.cli, 0o755);
  // Kept outside the floor, which an earlier cleanup removes first.
  const pidsFile = path.join(os.tmpdir(), `mdhang-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(path.join(path.dirname(f.cli), 'hang.json'), JSON.stringify({ pidsFile }));
  t.after(() => {
    try {
      const p = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
      for (const pid of [p.child, p.grandchild]) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    } catch { /* never started */ }
    fs.rmSync(pidsFile, { force: true });
  });
  fs.writeFileSync(path.join(f.cwd, 'report.md'), 'the report\n');
  const before = snapshot(f.hiveRoot);
  const s = await S.runHeadlessStream(f.opts({ timeoutMs: 1000, killGraceMs: 500 }));
  assert.equal(s.run.timedOut, true);
  assert.equal(s.cost.costRecorded, false);
  assert.match(s.cost.costReason, /timed out/);
  assert.equal(s.done, false);
  assert.equal(s.messageId, null);
  assert.deepEqual(diff(before, snapshot(f.hiveRoot)), { added: [], changed: [], removed: [] });
});

test('Given an output file left by an earlier run and a run that writes nothing, when the stream runs, then it is not done and no message is sent', async (t) => {
  const f = floor(t);
  const out = path.join(f.cwd, 'report.md');
  fs.writeFileSync(out, 'yesterday\'s report\n');
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(out, old, old);
  const s = await S.runHeadlessStream(f.opts());
  assert.equal(s.run.ok, true);
  assert.equal(s.done, false);
  assert.match(s.doneReason, /before the run started/);
  assert.deepEqual(fs.readdirSync(f.outbox), []);
});
