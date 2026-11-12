'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/canaries.ts');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-canary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A hive bin folder whose helpers write a sentinel file if anything ever runs them. */
function hostileBin(dir) {
  const bin = path.join(dir, 'hive', 'bin');
  fs.mkdirSync(path.join(bin, 'runtime'), { recursive: true });
  const sentinel = path.join(dir, 'EXECUTED');
  const body = `#!/bin/sh\necho ran >> "${sentinel}"\n`;
  for (const f of ['hive-memory', 'hive-node', 'runtime/node']) {
    fs.writeFileSync(path.join(bin, f), body);
    fs.chmodSync(path.join(bin, f), 0o755);
  }
  return { bin, sentinel };
}

function deps(dir, extra = {}) {
  return {
    memory: null, kg: null, hook: null, helpers: [], pathDirs: [],
    launches: new Map(), ledgerPath: path.join(dir, 'cost-ledger.jsonl'), ...extra
  };
}

const byFeature = (results) => Object.fromEntries(results.map((r) => [r.feature, r]));
const recall = (output, ok = true, error) => async () => ({ ok, output, ...(error ? { error } : {}) });

// ── never execute anything under the hive root ───────────────────────────────

test('a canary pass never executes the installed helpers, and reports them as modified', async (t) => {
  const dir = tmp(t);
  const { bin, sentinel } = hostileBin(dir);
  const expected = '#!/usr/bin/env node\n// the real shim\n';
  const helpers = [
    { name: 'hive-memory', path: path.join(bin, 'hive-memory'), expected, sourceMtimeMs: 0 },
    { name: 'hive-node', path: path.join(bin, 'hive-node'), expected },
    { name: 'runtime-node', path: path.join(bin, 'runtime', 'node'), expected }
  ];
  const r = byFeature(await C.runCanaries(deps(dir, {
    helpers, pathDirs: [path.join(bin, 'runtime')],
    memory: { plan: 'probe', search: recall('— a'), wakeUp: recall('— a'), wing: 'god' }
  })));
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(fs.existsSync(sentinel), false, 'a helper under the hive root was executed');
  assert.equal(r['helpers-intact'].ok, false);
  assert.deepEqual(r['helpers-intact'].problems, { 'hive-memory': 'modified', 'hive-node': 'modified', 'runtime-node': 'modified' });
});

// ── installed helpers, read not run ──────────────────────────────────────────

test('helper integrity: intact, stale, missing, not executable, not a regular file', (t) => {
  const dir = tmp(t);
  const expected = 'shim v2\n';
  const p = (n) => path.join(dir, n);
  fs.writeFileSync(p('good'), expected); fs.chmodSync(p('good'), 0o755);
  fs.writeFileSync(p('old'), 'shim v1\n'); fs.chmodSync(p('old'), 0o755);
  fs.utimesSync(p('old'), new Date(1000), new Date(1000));
  fs.writeFileSync(p('noexec'), expected); fs.chmodSync(p('noexec'), 0o644);
  fs.symlinkSync(p('good'), p('link'));
  const check = (name, extra = {}) => C.checkHelper({ name, path: p(name), expected, sourceMtimeMs: 5_000_000, ...extra });
  assert.equal(check('good'), null);
  assert.equal(check('old'), 'stale');
  assert.equal(check('missing'), 'missing');
  assert.equal(check('noexec'), 'not-executable');
  assert.equal(check('link'), 'not-regular');
  // A generated helper has no source file: any difference is a modification.
  assert.equal(C.checkHelper({ name: 'old', path: p('old'), expected }), 'modified');
});

test('node is found on the agents\' PATH by lookup only', (t) => {
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'node'), '#!/bin/sh\n'); fs.chmodSync(path.join(dir, 'node'), 0o755);
  assert.equal(C.nodeOnPath([path.join(dir, 'none'), dir]), true);
  assert.equal(C.nodeOnPath([path.join(dir, 'none')]), false);
});

// ── memory and knowledge, probed in-process ──────────────────────────────────

test('memory canaries count hits and name a refusal by its status code', async (t) => {
  const dir = tmp(t);
  const seen = [];
  const memory = {
    plan: 'probe', wing: 'god',
    search: async (q, o) => { seen.push(['search', q, o]); return { ok: true, output: '— one\n— two' }; },
    wakeUp: async (w) => { seen.push(['wake', w]); return { ok: false, output: '', error: 'HTTP 422' }; }
  };
  const r = byFeature(await C.runCanaries(deps(dir, { memory })));
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].hits], [true, 2]);
  assert.deepEqual([r['memory-wakeup'].ok, r['memory-wakeup'].detail], [false, 'refused-422']);
  // The tagged request form agents send: a wing (owner tag) is always passed.
  assert.deepEqual(seen, [['search', 'canary probe', { wing: 'god' }], ['wake', 'god']]);
});

test('zero hits is its own detail, and nothing recalled reaches the result', async (t) => {
  const dir = tmp(t);
  const results = await C.runCanaries(deps(dir, {
    memory: { plan: 'probe', wing: 'god', search: recall(''), wakeUp: recall('— secret memory text') },
    kg: { search: () => [{ title: 'secret doc' }] }
  }));
  const r = byFeature(results);
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].hits, r['memory-search'].detail], [true, 0, 'no-hits']);
  assert.deepEqual([r['kg-search'].ok, r['kg-search'].hits], [true, 1]);
  assert.doesNotMatch(JSON.stringify(results), /secret/);
});

test('a probe that hangs times out instead of holding the pass', async (t) => {
  const dir = tmp(t);
  const never = () => new Promise(() => {});
  const r = byFeature(await C.runCanaries(deps(dir, { memory: { plan: 'probe', wing: 'god', search: never, wakeUp: never }, timeoutMs: 50 })));
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [false, 'timeout']);
});

test('features that are off are reported as not checked', async (t) => {
  const r = byFeature(await C.runCanaries(deps(tmp(t))));
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [null, 'off']);
  assert.deepEqual([r['kg-search'].ok, r['kg-search'].detail], [null, 'off']);
});

// ── hook socket ──────────────────────────────────────────────────────────────

async function pongServer(t, dir, instance) {
  const sock = path.join(dir, 'h.sock');
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) c.end(JSON.stringify({ pong: JSON.parse(buf).ping, instance })); });
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  return sock;
}

test('the hook canary wants this app\'s instance, not just any listener', async (t) => {
  const dir = tmp(t);
  const sock = await pongServer(t, dir, 'me');
  assert.deepEqual(await C.pingHookSocket(sock, 'me'), { ok: true });
  assert.deepEqual(await C.pingHookSocket(sock, 'someone-else'), { ok: false, detail: 'other-instance' });
  const missing = await C.pingHookSocket(path.join(dir, 'nobody.sock'), 'me');
  assert.deepEqual(missing, { ok: false, detail: 'ENOENT' });
});

// ── model check ──────────────────────────────────────────────────────────────

test('model canary: a session that moved off its launch model is flagged; subagent rows are not', (t) => {
  const dir = tmp(t);
  const launches = new Map([
    ['rev', { model: 'claude-fable-5-1', ts: 100 }],
    ['dev', { model: 'claude-opus-5-5', ts: 100 }],
    ['old', { model: 'claude-opus-5-5', ts: 100 }],
    ['alias', { model: 'opus', ts: 100 }]
  ]);
  const MIN = 60_000;
  const rows = [
    ['rev', 1 * MIN, 'claude-fable-5-1'], ['rev', 2 * MIN, 'claude-opus-4-8'], ['rev', 20 * MIN, 'claude-opus-4-8'], // fallback, 18 min
    ['dev', 1 * MIN, 'claude-opus-5-5'], ['dev', 2 * MIN, 'claude-haiku-5-5'], ['dev', 3 * MIN, 'claude-haiku-5-5'],  // subagent burst, 1 min
    ['old', 50, 'claude-fable-5-1'],                                                                                    // before launch
    ['alias', 2 * MIN, 'claude-opus-5-5']
  ];
  fs.writeFileSync(path.join(dir, 'l'), rows.map(([agent_id, ts, model]) => JSON.stringify({ agent_id, ts, model })).join('\n') + '\n');
  const res = C.checkModels(launches, C.tailLines(path.join(dir, 'l')));
  assert.deepEqual(res, { checked: 2, mismatched: ['rev'] });
});

test('tailLines drops the partial first line of a tail read', (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f');
  fs.writeFileSync(p, 'aaaa\nbbbb\ncccc\n');
  assert.deepEqual(C.tailLines(p, 7), ['cccc']);
  assert.deepEqual(C.tailLines(path.join(dir, 'missing')), []);
});
