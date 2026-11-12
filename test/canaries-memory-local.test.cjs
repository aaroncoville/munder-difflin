'use strict';
// The memory canary must be provably local and passive. It is wired here through
// the REAL MemoryManager and REAL adapters, with child_process and fetch
// instrumented: for every backend setting, a canary pass starts no child process
// and contacts no host other than loopback. It probes only a loopback Hindsight
// server; MemPalace (which spawns its CLI) and a remote Hindsight URL are not probed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const cp = require('node:child_process');
const loadTs = require('./load-ts.cjs');

// Instrument before any adapter loads: every spawn-family call is recorded and refused.
const spawned = [];
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  const real = cp[fn];
  cp[fn] = (...args) => { spawned.push([fn, String(args[0])]); throw new Error(`blocked ${fn}`); };
  cp[fn].real = real;
}
const net = require('node:net');
// Socket level: every outgoing TCP connection's host, whatever made it (fetch, http, undici).
const sockets = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = Array.isArray(args[0]) ? args[0][0] : args[0]; // net.createConnection passes [options, cb]
  if (o && typeof o === 'object') { if (!o.path) sockets.push(String(o.host ?? 'localhost')); }
  else if (typeof o === 'number') sockets.push(String(typeof args[1] === 'string' ? args[1] : 'localhost'));
  return realConnect.apply(this, args);
};
const contacted = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => { contacted.push(new URL(String(url)).hostname); return realFetch(url, init); };

const { MemoryManager } = loadTs('src/main/memory.ts');
const C = loadTs('src/main/canaries.ts');

const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);

function settings(over) {
  return { enabled: true, backend: 'mempalace', mempalace: { model: 'minilm' }, hindsight: { url: 'http://127.0.0.1:9', bank: 'b' }, ...over };
}

async function pass(t, s, warm, opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-canary-mem-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  spawned.length = 0; contacted.length = 0; sockets.length = 0;
  const memory = opts.memory ?? new MemoryManager(() => home, () => s);
  // The canary sends its own request and never asks the adapter, so the adapter's health needs no warming.
  void warm;
  const deps = { memory: C.memoryCanary(memory, s, 'god'), kg: null, hook: null, helpers: [], pathDirs: [], launches: new Map(), ledgerPath: path.join(home, 'none'), timeoutMs: 3000 };
  const r = Object.fromEntries((await C.runCanaries(deps)).map((x) => [x.feature, x]));
  return r;
}

test('mempalace: not probed, and no child process is started', async (t) => {
  const r = await pass(t, settings({ backend: 'mempalace' }));
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [null, 'not-probed-spawn']);
  assert.deepEqual([r['memory-wakeup'].ok, r['memory-wakeup'].detail], [null, 'not-probed-spawn']);
  assert.deepEqual(spawned, []);
  assert.deepEqual(contacted, []);
});

test('hindsight on a remote host: not probed, and nothing is contacted', async (t) => {
  for (const url of ['https://memory.example.invalid', 'http://10.0.0.5:8888', 'http://127.0.0.1.example.invalid']) {
    const r = await pass(t, settings({ backend: 'hindsight', hindsight: { url, bank: 'b' } }));
    assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [null, 'not-probed-remote'], url);
    assert.deepEqual(contacted, [], url);
    assert.deepEqual(spawned, [], url);
  }
});

test('hindsight on loopback: probed, contacting only loopback, starting no child', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ results: [{ text: 'x', score: 1 }] })); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await pass(t, settings({ backend: 'hindsight', hindsight: { url: `http://127.0.0.1:${server.address().port}`, bank: 'b' } }));
  assert.equal(r['memory-search'].ok, true);
  assert.equal(r['memory-search'].hits, 1);
  assert.ok(sockets.length > 0, 'the probe connected somewhere');
  assert.ok(sockets.every((h) => LOOPBACK.has(h)), sockets.join(','));
  assert.ok(contacted.every((h) => LOOPBACK.has(h)), contacted.join(','));
  assert.deepEqual(spawned, []);
});

test('memory switched off: not checked, nothing touched', async (t) => {
  const r = await pass(t, settings({ enabled: false, backend: 'mempalace' }));
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [null, 'off']);
  assert.deepEqual(spawned, []);
  assert.deepEqual(contacted, []);
});

test('loopback means loopback', () => {
  for (const u of ['http://127.0.0.1:8888', 'http://localhost:1', 'http://[::1]:8888', 'http://127.0.0.2']) assert.equal(C.isLoopbackUrl(u), true, u);
  for (const u of ['http://localhost.example.com', 'http://0.0.0.0:1', 'http://192.168.1.2', 'not a url', 'file:///x']) assert.equal(C.isLoopbackUrl(u), false, u);
});

test('a manager still holding MemPalace after the settings switched to loopback Hindsight is not probed', async (t) => {
  const live = { enabled: true, backend: 'mempalace', mempalace: { model: 'minilm' }, hindsight: { url: 'http://127.0.0.1:9', bank: 'b' } };
  const memory = new MemoryManager(() => os.tmpdir(), () => live);
  // Saved settings now say loopback Hindsight, but no refresh has swapped the live backend yet.
  live.backend = 'hindsight';
  const r = await pass(t, live, false, { memory });
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [null, 'not-probed-switching']);
  assert.deepEqual(spawned, []);
  assert.deepEqual(sockets, []);
});

test('a loopback server that redirects off-host is refused, with no off-host connection at the socket level', async (t) => {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.statusCode = 302; res.setHeader('location', 'http://198.51.100.7:8888/v1/default/banks/b/memories/recall'); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const r = await pass(t, settings({ backend: 'hindsight', hindsight: { url: `http://127.0.0.1:${server.address().port}`, bank: 'b' } }));
  assert.deepEqual([r['memory-search'].ok, r['memory-search'].detail], [false, 'redirect']);
  assert.deepEqual([r['memory-wakeup'].ok, r['memory-wakeup'].detail], [false, 'redirect']);
  assert.ok(sockets.length > 0);
  assert.ok(sockets.every((h) => LOOPBACK.has(h)), sockets.join(','));
  assert.deepEqual(spawned, []);
});
