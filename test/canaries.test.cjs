'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/canaries.ts');
const SHIM = path.resolve(__dirname, '..', 'resources', 'hive-memory.cjs');

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-canary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function backend(t, status, body) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(body); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { HIVE_MEMORY_BACKEND: 'hindsight', HINDSIGHT_URL: `http://127.0.0.1:${server.address().port}`, HINDSIGHT_BANK: 'b' };
}

function baseDeps(dir, extra = {}) {
  return {
    memoryShim: SHIM, memoryEnv: {}, kg: null, node: process.execPath, hookSocket: null,
    hiveLogPath: path.join(dir, 'log.jsonl'), ledgerPath: path.join(dir, 'cost-ledger.jsonl'), ...extra
  };
}

const byFeature = (results) => Object.fromEntries(results.map((r) => [r.feature, r]));

test('a refusing memory backend fails the search canary with its status code, through the real shim', async (t) => {
  const dir = tmp(t);
  const env = await backend(t, 422, '{"detail":"no"}');
  const r = byFeature(await C.runCanaries(baseDeps(dir, { memoryEnv: env })));
  assert.equal(r['memory-search'].ok, false);
  assert.equal(r['memory-search'].detail, 'refused-422');
});

test('a working memory backend passes both memory canaries', async (t) => {
  const dir = tmp(t);
  const env = await backend(t, 200, JSON.stringify({ results: [{ text: 'secret memory text', score: 1 }] }));
  const results = await C.runCanaries(baseDeps(dir, { memoryEnv: env }));
  const r = byFeature(results);
  assert.equal(r['memory-search'].ok, true);
  assert.equal(r['memory-wakeup'].ok, true);
  // Measure only: nothing the backend returned is carried into the result.
  assert.doesNotMatch(JSON.stringify(results), /secret memory text/);
});

test('an unreachable memory backend reads as unavailable', () => {
  assert.deepEqual(C.classifyMemoryRun({ code: 0, stdout: 'memory recall unavailable — continue without it\n', stderr: '' }), { ok: false, detail: 'unavailable' });
  assert.deepEqual(C.classifyMemoryRun({ code: 2, stdout: '', stderr: 'usage' }), { ok: false, detail: 'exit-2' });
});

test('features that are off are reported as not checked, not as failures', async (t) => {
  const dir = tmp(t);
  const r = byFeature(await C.runCanaries(baseDeps(dir, { memoryShim: null })));
  assert.equal(r['memory-search'].ok, null);
  assert.equal(r['kg-search'].ok, null);
  assert.equal(r['kg-search'].detail, 'off');
});

test('the hook canary gets a pong from a live socket and fails on a missing one', async (t) => {
  const dir = tmp(t);
  const sock = path.join(dir, 'h.sock');
  const server = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; if (buf.includes('\n')) c.end(JSON.stringify({ pong: JSON.parse(buf).ping, instance: 'x' })); });
  });
  await new Promise((r) => server.listen(sock, r));
  t.after(() => server.close());
  assert.deepEqual(await C.pingHookSocket(sock), { ok: true });
  const missing = await C.pingHookSocket(path.join(dir, 'nobody.sock'));
  assert.equal(missing.ok, false);
  assert.equal(missing.detail, 'ENOENT');
});

test('a kg CLI that exits non-zero fails its canary with the exit code', async (t) => {
  const dir = tmp(t);
  const cli = path.join(dir, 'kg.cjs');
  fs.writeFileSync(cli, 'process.exit(3)');
  const r = byFeature(await C.runCanaries(baseDeps(dir, { memoryShim: null, kg: { cli, env: {} } })));
  assert.deepEqual([r['kg-search'].ok, r['kg-search'].detail], [false, 'exit-3']);
});

test('model canary flags an agent whose ledger model differs from its launch model after launch', async (t) => {
  const dir = tmp(t);
  const log = [
    { ts: 100, kind: 'agent-model', agentId: 'rev', model: 'claude-fable-5-1' },
    { ts: 100, kind: 'agent-model', agentId: 'dev', model: 'claude-opus-5-5' },
    { ts: 100, kind: 'agent-model', agentId: 'old', model: 'claude-opus-5-5' },
    { ts: 100, kind: 'agent-model', agentId: 'alias', model: 'opus' }
  ];
  const ledger = [
    { agent_id: 'rev', ts: 200, model: 'claude-opus-4-8' },   // refusal fallback
    { agent_id: 'dev', ts: 200, model: 'claude-opus-5-5' },
    { agent_id: 'old', ts: 50, model: 'claude-fable-5-1' },   // before its launch: ignored
    { agent_id: 'alias', ts: 200, model: 'claude-opus-5-5' }  // alias pin: not comparable
  ];
  fs.writeFileSync(path.join(dir, 'log.jsonl'), log.map((e) => JSON.stringify(e)).join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'cost-ledger.jsonl'), ledger.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const r = byFeature(await C.runCanaries(baseDeps(dir, { memoryShim: null })));
  assert.equal(r['model-matches-launch'].ok, false);
  assert.equal(r['model-matches-launch'].checked, 2);
  assert.deepEqual(r['model-matches-launch'].mismatched, ['rev']);
});

test('tailLines drops the partial first line of a tail read', (t) => {
  const dir = tmp(t);
  const p = path.join(dir, 'f');
  fs.writeFileSync(p, 'aaaa\nbbbb\ncccc\n');
  assert.deepEqual(C.tailLines(p, 7), ['cccc']);
  assert.deepEqual(C.tailLines(path.join(dir, 'missing')), []);
});

test('the memory canary runs search exactly as agents do, without --results', async (t) => {
  const dir = tmp(t);
  const calls = [];
  const run = async (cmd, args) => { calls.push(args); return { code: 0, stdout: '', stderr: '' }; };
  await C.runCanaries(baseDeps(dir, { memoryEnv: { HIVE_MEMORY_BACKEND: 'hindsight' }, run }));
  const search = calls.find((a) => a[1] === 'search');
  assert.deepEqual(search.slice(1), ['search', 'canary probe']);
});
