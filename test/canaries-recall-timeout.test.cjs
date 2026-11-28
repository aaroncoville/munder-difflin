'use strict';

// A loopback memory server that accepts the probe and never answers (a frozen container, say) is reported as a
// timeout, not as a generic error, so the log tells a silent server from a refused or broken connection.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/canaries.ts');

async function silentServer(t) {
  const held = [];
  const server = http.createServer((req) => { held.push(req); req.resume(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => { for (const r of held) r.socket.destroy(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('a server that never answers gives the recall a timeout error', async (t) => {
  const base = await silentServer(t);
  const r = await C.localRecall(base, 'b', 'q', 5, 'god', 50);
  assert.deepEqual([r.ok, r.error], [false, 'timeout']);
});

test('the memory canary reports that timeout as detail timeout', async (t) => {
  const base = await silentServer(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-canary-to-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const probe = () => C.localRecall(base, 'b', 'q', 5, 'god', 50);
  const rs = await C.runCanaries({ memory: { plan: 'probe', wing: 'god', search: probe, wakeUp: probe }, kg: null, hook: null, helpers: [], pathDirs: [], launches: new Map(), ledgerPath: path.join(dir, 'l.jsonl') });
  const r = rs.find((x) => x.feature === 'memory-search');
  assert.deepEqual([r.ok, r.detail], [false, 'timeout']);
});

test('a refused connection is still an error, not a timeout', async () => {
  const s = http.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const port = s.address().port;
  await new Promise((r) => s.close(r));
  const r = await C.localRecall(`http://127.0.0.1:${port}`, 'b', 'q', 5, 'god', 50);
  assert.deepEqual([r.ok, r.error], [false, 'error']);
});
