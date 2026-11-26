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

// --- done-check ----------------------------------------------------------------------------------------------------
// A run is done only when the output file its brief names exists, is a regular file (not a link, whatever it points
// at), is not empty, and lies inside the seat's write roots (writeRoots.ts seatWriteRoots), judged on its real path.

/** A hive with the seat's folder and evidence/, and a working folder outside it. */
function seat(t) {
  const h = hive(t);
  fs.mkdirSync(path.join(h.root, 'evidence'));
  const cwd = path.join(h.base, 'work');
  fs.mkdirSync(cwd);
  return { ...h, cwd, ctx: { hiveRoot: h.root, agentId: 'ag1', isGod: false, cwd } };
}

test('Given a non-empty output file in the working folder, the seat folder or evidence/, when the output is checked, then the run is done', (t) => {
  const s = seat(t);
  for (const file of [path.join(s.cwd, 'out.md'), path.join(s.root, 'agents', 'ag1', 'out.md'), path.join(s.root, 'evidence', 'out.md')]) {
    fs.writeFileSync(file, 'findings\n');
    const r = S.checkHeadlessOutput(s.ctx, file);
    assert.equal(r.done, true, file);
    assert.equal(r.reason, null);
  }
});

test('Given no output file was named, or it is missing, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  const a = S.checkHeadlessOutput(s.ctx, null);
  assert.equal(a.done, false);
  assert.match(a.reason, /no output file/);
  const b = S.checkHeadlessOutput(s.ctx, path.join(s.cwd, 'missing.md'));
  assert.equal(b.done, false);
  assert.match(b.reason, /does not exist/);
});

test('Given an empty output file, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  fs.writeFileSync(path.join(s.cwd, 'out.md'), '');
  const r = S.checkHeadlessOutput(s.ctx, path.join(s.cwd, 'out.md'));
  assert.equal(r.done, false);
  assert.match(r.reason, /empty/);
});

test('Given an output path that is a folder, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  fs.mkdirSync(path.join(s.cwd, 'out.md'));
  const r = S.checkHeadlessOutput(s.ctx, path.join(s.cwd, 'out.md'));
  assert.equal(r.done, false);
  assert.match(r.reason, /not a regular file/);
});

test('Given an output file outside the seat\'s write roots (elsewhere, or another hive file), when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  for (const file of [path.join(s.base, 'elsewhere.md'), path.join(s.root, 'tasks.json')]) {
    fs.writeFileSync(file, 'x\n');
    const r = S.checkHeadlessOutput(s.ctx, file);
    assert.equal(r.done, false, file);
    assert.match(r.reason, /outside the seat's write roots/);
  }
});

test('Given an output path that is a link, even to a real file inside the roots, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  fs.writeFileSync(path.join(s.base, 'elsewhere.md'), 'x\n');
  fs.writeFileSync(path.join(s.cwd, 'real.md'), 'x\n');
  fs.symlinkSync(path.join(s.base, 'elsewhere.md'), path.join(s.cwd, 'out.md'));
  fs.symlinkSync(path.join(s.cwd, 'real.md'), path.join(s.cwd, 'alias.md'));
  for (const name of ['out.md', 'alias.md']) {
    const r = S.checkHeadlessOutput(s.ctx, path.join(s.cwd, name));
    assert.equal(r.done, false, name);
    assert.match(r.reason, /link/);
  }
});

test('Given an output file reached through a linked folder that leads out of the roots, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  fs.mkdirSync(path.join(s.base, 'outside'));
  fs.writeFileSync(path.join(s.base, 'outside', 'out.md'), 'x\n');
  fs.symlinkSync(path.join(s.base, 'outside'), path.join(s.cwd, 'linked'));
  const r = S.checkHeadlessOutput(s.ctx, path.join(s.cwd, 'linked', 'out.md'));
  assert.equal(r.done, false);
  assert.match(r.reason, /outside the seat's write roots/);
});

test('Given a relative output path, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  const r = S.checkHeadlessOutput(s.ctx, 'out.md');
  assert.equal(r.done, false);
  assert.match(r.reason, /absolute/);
});

// --- done message --------------------------------------------------------------------------------------------------
// A done run sends god one message in the hive's mail format, written into the seat's own outbox for the app to
// deliver: a JSON file named by its own safe id, with to, act, subject and body.

const { isSafeMessageId } = loadTs('src/core/messageId.ts');

test('Given a done run, when its message is written, then the seat\'s outbox holds exactly one well-formed message to god and nothing else', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  const cost = { costRecorded: true, costReason: null, row: null };
  const msg = S.headlessDoneMessage('ag1', run({ outputFile: out }), out, cost, Date.UTC(2026, 10, 26, 12));
  const id = S.writeOutboxMessage(s.root, 'ag1', msg);
  const outbox = path.join(s.root, 'agents', 'ag1', 'outbox');
  assert.deepEqual(fs.readdirSync(outbox), [`${id}.json`], 'one message, and no temporary file left behind');
  assert.ok(isSafeMessageId(id));
  const m = JSON.parse(fs.readFileSync(path.join(outbox, `${id}.json`), 'utf8'));
  assert.deepEqual(Object.keys(m).sort(), ['act', 'body', 'created_at', 'id', 'subject', 'to']);
  assert.equal(m.id, id);
  assert.equal(m.to, 'god');
  assert.equal(m.act, 'done', 'a terminal act: god does not reply to it');
  assert.equal(m.created_at, '2026-11-26T12:00:00.000Z');
  assert.match(m.subject, /out\.md/);
  assert.ok(!m.subject.includes('\n'), 'the subject is one line');
  assert.match(m.body, new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(m.body, /exit 0/);
  assert.match(m.body, /\$0\.0042/);
  assert.match(m.body, new RegExp(SESSION));
});

test('Given a done run whose cost was not recorded, when its message is built, then the body says the cost and why it is not in the ledger', () => {
  const m = S.headlessDoneMessage('ag1', run({ totalCostUsd: null }), '/w/out.md', { costRecorded: false, costReason: 'the CLI reported no cost', row: null }, 0);
  assert.match(m.body, /unknown/);
  assert.match(m.body, /the CLI reported no cost/);
});

test('Given two messages written in the same instant, when both are written, then each gets its own file', (t) => {
  const s = seat(t);
  const msg = S.headlessDoneMessage('ag1', run(), '/w/out.md', { costRecorded: true, costReason: null, row: null }, 0);
  const a = S.writeOutboxMessage(s.root, 'ag1', msg);
  const b = S.writeOutboxMessage(s.root, 'ag1', msg);
  assert.notEqual(a, b);
  assert.equal(fs.readdirSync(path.join(s.root, 'agents', 'ag1', 'outbox')).length, 2);
});

test('Given the seat\'s outbox is a link to a folder elsewhere, when a message is written, then it is refused and nothing lands through the link', (t) => {
  const s = seat(t);
  fs.mkdirSync(path.join(s.base, 'elsewhere'));
  fs.symlinkSync(path.join(s.base, 'elsewhere'), path.join(s.root, 'agents', 'ag1', 'outbox'));
  const msg = S.headlessDoneMessage('ag1', run(), '/w/out.md', { costRecorded: true, costReason: null, row: null }, 0);
  assert.throws(() => S.writeOutboxMessage(s.root, 'ag1', msg), /not a real folder/);
  assert.deepEqual(fs.readdirSync(path.join(s.base, 'elsewhere')), []);
});

test('Given a run whose reported cost is negative or not a finite number, when its cost is recorded, then no row is written and the result says why', (t) => {
  const h = hive(t);
  for (const usd of [-5, -0.0001, Number.POSITIVE_INFINITY, Number.NaN]) {
    const c = S.recordHeadlessCost(h.root, 'ag1', run({ totalCostUsd: usd }), 5);
    assert.equal(c.costRecorded, false, String(usd));
    assert.match(c.costReason, /not a cost/);
  }
  assert.equal(fs.existsSync(h.ledger), false, 'a negative row would lower the agent\'s lifetime spend');
});

// A message reaches the router's name only once all of it is on disk.

test('Given a write that stops short, when a message is written, then it throws, no message id is returned and the outbox holds nothing', (t) => {
  const s = seat(t);
  const msg = S.headlessDoneMessage('ag1', run(), '/w/out.md', { costRecorded: true, costReason: null, row: null }, 0);
  const short = (fd, buf, off, len) => (len > 1 ? fs.writeSync(fd, buf, off, len - 1) : 0);
  assert.throws(() => S.writeOutboxMessage(s.root, 'ag1', msg, { writeSync: short }), /stopped after/);
  assert.deepEqual(fs.readdirSync(path.join(s.root, 'agents', 'ag1', 'outbox')), []);
});

test('Given a write that completes a few bytes at a time, when a message is written, then the whole message lands', (t) => {
  const s = seat(t);
  const msg = S.headlessDoneMessage('ag1', run(), '/w/out.md', { costRecorded: true, costReason: null, row: null }, 0);
  const trickle = (fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(len, 7));
  const id = S.writeOutboxMessage(s.root, 'ag1', msg, { writeSync: trickle });
  const m = JSON.parse(fs.readFileSync(path.join(s.root, 'agents', 'ag1', 'outbox', `${id}.json`), 'utf8'));
  assert.equal(m.body, msg.body);
});

// --- ledger append integrity ---------------------------------------------------------------------------------------
// The row is appended whole or not at all, on a line of its own, one writer at a time (a lock file beside the ledger,
// cost-ledger.jsonl.lock, taken with O_EXCL and broken only when its holder on this host has exited).

const parseAll = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('Given a ledger whose last line is unterminated, when a cost is recorded, then the row starts on a fresh line and both rows parse', (t) => {
  const h = hive(t);
  const torn = JSON.stringify({ agent_id: 'other', session_id: 's0', ts: 1, input: 0, output: 0, cache_read: 0, cache_creation: 0, model: 'm', usd: 1 });
  fs.writeFileSync(h.ledger, torn);
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5);
  assert.equal(c.costRecorded, true, c.costReason);
  const rows = parseAll(h.ledger);
  assert.deepEqual(rows.map((r) => r.agent_id), ['other', 'ag1']);
  assert.ok(fs.readFileSync(h.ledger, 'utf8').endsWith('\n'));
});

test('Given a write that stops short, when a cost is recorded, then no row is recorded, the result says why, and the ledger is as it was', (t) => {
  const h = hive(t);
  const before = `${JSON.stringify({ agent_id: 'other', session_id: 's0', ts: 1, usd: 1 })}\n`;
  fs.writeFileSync(h.ledger, before);
  const short = (fd, buf, off, len) => (len > 10 ? fs.writeSync(fd, buf, off, 10) : 0);
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { writeSync: short });
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /stopped after/);
  assert.equal(fs.readFileSync(h.ledger, 'utf8'), before, 'no half row is left behind');
  assert.deepEqual(fs.readdirSync(h.root).sort(), ['agents', 'cost-ledger.jsonl'], 'and no lock is left behind');
});

test('Given a write that completes a few bytes at a time, when a cost is recorded, then the whole row lands and the lock is gone', (t) => {
  const h = hive(t);
  const trickle = (fd, buf, off, len) => fs.writeSync(fd, buf, off, Math.min(len, 5));
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { writeSync: trickle });
  assert.equal(c.costRecorded, true, c.costReason);
  assert.equal(parseAll(h.ledger).length, 1);
  assert.deepEqual(fs.readdirSync(h.root).sort(), ['agents', 'cost-ledger.jsonl']);
});

test('Given the ledger lock is held by a running process, when a cost is recorded, then it waits, gives up, and writes nothing', (t) => {
  const h = hive(t);
  fs.writeFileSync(`${h.ledger}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), token: 'x' }));
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { lockWaitMs: 200 });
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, new RegExp(`lock.*pid ${process.pid}`));
  assert.equal(fs.existsSync(h.ledger), false);
  assert.ok(fs.existsSync(`${h.ledger}.lock`), 'a live holder\'s lock is never broken');
});

test('Given a ledger lock left by a process that has exited, when a cost is recorded, then the lock is broken and the row lands', (t) => {
  const h = hive(t);
  const { spawnSync } = require('node:child_process');
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString();
  fs.writeFileSync(`${h.ledger}.lock`, JSON.stringify({ pid: Number(dead), host: os.hostname(), token: 'x' }));
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { lockWaitMs: 2000 });
  assert.equal(c.costRecorded, true, c.costReason);
  assert.equal(parseAll(h.ledger).length, 1);
  assert.equal(fs.existsSync(`${h.ledger}.lock`), false);
});

test('Given several processes appending at once, a few bytes per write, when they finish, then every row is intact on a line of its own', { timeout: 60000 }, async (t) => {
  const h = hive(t);
  const { spawn } = require('node:child_process');
  const N = 6;
  const ROWS = 25;
  const script = `
    const fs = require('node:fs');
    const S = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/core/headlessStream.ts');
    const nap = new Int32Array(new SharedArrayBuffer(4));
    const slow = (fd, buf, off, len) => { Atomics.wait(nap, 0, 0, 1); return fs.writeSync(fd, buf, off, Math.min(len, 16)); };
    const base = JSON.parse(process.argv[1]);
    for (let i = 0; i < ${ROWS}; i++) {
      const c = S.recordHeadlessCost(process.argv[2], 'ag' + process.argv[3], { ...base, sessionId: 'w' + process.argv[3] + '-' + i }, Date.now(), { writeSync: slow, lockWaitMs: 30000 });
      if (!c.costRecorded) { console.error(c.costReason); process.exit(1); }
    }`;
  const codes = await Promise.all(Array.from({ length: N }, (_, w) => new Promise((res) => {
    const c = spawn(process.execPath, ['-e', script, JSON.stringify(run()), h.root, String(w)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'inherit'] });
    c.on('exit', res);
  })));
  assert.deepEqual(codes, Array(N).fill(0));
  const text = fs.readFileSync(h.ledger, 'utf8');
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'newline-terminated');
  assert.equal(lines.length, N * ROWS);
  const sessions = new Set(lines.map((l) => JSON.parse(l).session_id));
  assert.equal(sessions.size, N * ROWS, 'every row whole and distinct');
});

// The done-check reads the file through one descriptor opened without following a link, and the path must still name
// that same file (device and inode) once resolved, so a link or a swap cannot stand in for it.

test('Given an output file with a second name (a hard link), inside the roots or out, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  fs.writeFileSync(path.join(s.base, 'outside.md'), 'not the run\'s\n');
  fs.linkSync(path.join(s.base, 'outside.md'), path.join(s.cwd, 'out.md'));
  const a = S.checkHeadlessOutput(s.ctx, path.join(s.cwd, 'out.md'));
  assert.equal(a.done, false);
  assert.match(a.reason, /more than one name/);
  fs.writeFileSync(path.join(s.cwd, 'twin.md'), 'x\n');
  fs.linkSync(path.join(s.cwd, 'twin.md'), path.join(s.root, 'evidence', 'twin.md'));
  assert.equal(S.checkHeadlessOutput(s.ctx, path.join(s.cwd, 'twin.md')).done, false);
});

test('Given the output path is swapped for a link to an outside file while it is checked, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  fs.writeFileSync(out, 'the run\'s\n');
  fs.writeFileSync(path.join(s.base, 'outside.md'), 'not the run\'s\n');
  const swap = () => { fs.rmSync(out); fs.symlinkSync(path.join(s.base, 'outside.md'), out); };
  const r = S.checkHeadlessOutput(s.ctx, out, { afterOpen: swap });
  assert.equal(r.done, false);
  assert.match(r.reason, /changed while it was checked|outside/);
});

test('Given an output path that is a named pipe, when the output is checked, then the run is not done and the check does not wait on it', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  const { execFileSync, spawnSync } = require('node:child_process');
  execFileSync('mkfifo', [out]);
  // In a child process with a deadline: an open that waits for a writer would block this test's own thread.
  const script = `const S = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))})('src/core/headlessStream.ts');
    process.stdout.write(JSON.stringify(S.checkHeadlessOutput(JSON.parse(process.argv[1]), process.argv[2])));`;
  const c = spawnSync(process.execPath, ['-e', script, JSON.stringify(s.ctx), out], { cwd: path.join(__dirname, '..'), timeout: 10000, encoding: 'utf8' });
  assert.equal(c.signal, null, 'the check returned instead of waiting on the pipe');
  const r = JSON.parse(c.stdout);
  assert.equal(r.done, false);
  assert.match(r.reason, /not a regular file/);
});

test('Given a done output file, when the output is checked, then the result names the file it checked by device and inode', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  fs.writeFileSync(out, 'x\n');
  const r = S.checkHeadlessOutput(s.ctx, out);
  const st = fs.statSync(out);
  assert.equal(r.done, true);
  assert.deepEqual(r.file, { dev: st.dev, ino: st.ino });
});

test('Given the output path is swapped for a link to another file inside the roots while it is checked, when the output is checked, then the run is not done', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  fs.writeFileSync(out, 'the run\'s\n');
  const other = path.join(s.root, 'evidence', 'old.md');
  fs.writeFileSync(other, 'an older file\n');
  const r = S.checkHeadlessOutput(s.ctx, out, { afterOpen: () => { fs.rmSync(out); fs.symlinkSync(other, out); } });
  assert.equal(r.done, false);
  assert.match(r.reason, /changed while it was checked/);
});

test('Given an output file last written before the run started, when the output is checked against the run\'s start, then the run is not done', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  fs.writeFileSync(out, 'x\n');
  fs.utimesSync(out, new Date('2020-01-01'), new Date('2020-01-01'));
  const r = S.checkHeadlessOutput(s.ctx, out, { notBefore: Date.now() - 1000 });
  assert.equal(r.done, false);
  assert.match(r.reason, /before the run started/);
  fs.writeFileSync(out, 'written now\n');
  assert.equal(S.checkHeadlessOutput(s.ctx, out, { notBefore: Date.now() - 1000 }).done, true);
});

test('Given an output file whose name starts with two dots, inside a root, when the output is checked, then the run is done', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, '..notes.md');
  fs.writeFileSync(out, 'findings\n');
  const r = S.checkHeadlessOutput(s.ctx, out);
  assert.equal(r.done, true, r.reason);
});

test('Given a file system that keeps whole seconds, when an output file written in the run\'s first second is checked, then the run is done', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  fs.writeFileSync(out, 'x\n');
  const second = Math.floor(Date.now() / 1000) - 5;
  // The file's time as such a file system keeps it: the second it was written in, rounded down.
  fs.utimesSync(out, second, second);
  assert.equal(S.checkHeadlessOutput(s.ctx, out, { notBefore: second * 1000 + 700 }).done, true);
  assert.equal(S.checkHeadlessOutput(s.ctx, out, { notBefore: (second + 1) * 1000 }).done, false, 'a file from the second before is still refused');
});

test('Given a checked output file emptied in place before the message, when it is re-checked, then it no longer counts', (t) => {
  const s = seat(t);
  const out = path.join(s.cwd, 'out.md');
  fs.writeFileSync(out, 'findings\n');
  const r = S.checkHeadlessOutput(s.ctx, out);
  assert.equal(r.done, true);
  assert.equal(S.sameOutputFile(out, r.file), null);
  fs.truncateSync(out, 0);
  assert.match(S.sameOutputFile(out, r.file) ?? '', /empty/);
});

// The ledger lock is the shared file lock (fileLock.ts), so it keeps that lock's guarantees: a volume without hard
// links refuses it (no append), a live lock that replaced a stale one while it was being broken is never removed,
// and the holder confirms the lock is still its own immediately before it appends.

test('Given a volume that cannot make hard links, when a cost is recorded, then nothing is appended and the result says why', (t) => {
  const h = hive(t);
  const enotsup = () => { throw Object.assign(new Error('operation not supported'), { code: 'ENOTSUP' }); };
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { link: enotsup, lockWaitMs: 500 });
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /hard links/);
  assert.equal(fs.existsSync(h.ledger), false);
});

test('Given a stale lock replaced by a live holder\'s lock just as it is broken, when a cost is recorded, then the live lock stays and nothing is appended', (t) => {
  const h = hive(t);
  const lock = `${h.ledger}.lock`;
  const { spawnSync } = require('node:child_process');
  const dead = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']).stdout.toString());
  fs.writeFileSync(lock, JSON.stringify({ pid: dead, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'stale' }));
  const live = JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'live' });
  let replaced = false;
  const beforeBreak = () => { if (replaced) return; replaced = true; fs.rmSync(lock); fs.writeFileSync(lock, live); };
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { hooks: { beforeBreak }, lockWaitMs: 300 });
  assert.ok(replaced, 'the interleaving happened');
  assert.equal(c.costRecorded, false);
  assert.equal(fs.readFileSync(lock, 'utf8'), live, 'the live holder\'s lock is still in place');
  assert.equal(fs.existsSync(h.ledger), false, 'and nothing was appended beside it');
});

test('Given a ledger lock whose pid is one process.kill refuses as an argument, when it is old, then it is broken by age and the row lands', (t) => {
  for (const pid of [2 ** 31, Number.MAX_SAFE_INTEGER]) {
    const h = hive(t);
    const lock = `${h.ledger}.lock`;
    const hourAgo = new Date(Date.now() - 3_600_000);
    fs.writeFileSync(lock, JSON.stringify({ pid, host: os.hostname(), acquiredAt: hourAgo.toISOString(), token: 'x' }));
    fs.utimesSync(lock, hourAgo, hourAgo);
    const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { lockWaitMs: 300 });
    assert.equal(c.costRecorded, true, `pid ${pid}: ${c.costReason}`);
    assert.equal(parseAll(h.ledger).length, 1);
  }
});

test('Given the lock is taken from the holder after the ledger is opened, when it is about to write, then the second check finds the lock is not its own and appends nothing', (t) => {
  const h = hive(t);
  fs.writeFileSync(h.ledger, '');
  const lock = `${h.ledger}.lock`;
  const other = JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'someone-else' });
  const afterOpen = () => { fs.rmSync(lock); fs.writeFileSync(lock, other); };
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { hooks: { afterOpen } });
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /cost-ledger\.jsonl\.lock no longer holds this writer's record/);
  assert.equal(fs.readFileSync(h.ledger, 'utf8'), '', 'nothing was appended');
  assert.equal(fs.readFileSync(lock, 'utf8'), other, 'the other holder\'s lock is left alone');
});

test('Given the lock is taken from the holder after it acquired it, when it is about to append, then it checks, finds the lock is not its own, and appends nothing', (t) => {
  const h = hive(t);
  const lock = `${h.ledger}.lock`;
  const other = JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString(), token: 'someone-else' });
  const afterLock = () => { fs.rmSync(lock); fs.writeFileSync(lock, other); };
  const c = S.recordHeadlessCost(h.root, 'ag1', run(), 5, { hooks: { afterLock } });
  assert.equal(c.costRecorded, false);
  assert.match(c.costReason, /no longer holds/);
  assert.equal(fs.existsSync(h.ledger), false);
  assert.equal(fs.readFileSync(lock, 'utf8'), other, 'the other holder\'s lock is left alone');
});
