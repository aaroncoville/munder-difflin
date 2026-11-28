'use strict';

// The memory canary probes the server from the app's own process, which no sandbox confines. Agents reach it through
// the hive-memory shim inside their seat's OS sandbox, which refuses a direct connection to loopback, so a healthy
// server can still be out of every sandboxed agent's reach. A canary pass starts no process, so it cannot run the shim
// there: it judges that path from the seat settings the app generates, and a judged result is never a failure.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/canaries.ts');
const { seatSandboxSettings } = loadTs('src/main/hive.ts');
const D = loadTs('src/core/usageDigest.ts');

function deps(t, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-canary-sbx-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { memory: null, kg: null, hook: null, helpers: [], pathDirs: [], launches: new Map(), ledgerPath: path.join(dir, 'l.jsonl'), ...extra };
}
const ok = async () => ({ ok: true, output: '— hit' });
const loopback = { plan: 'probe', wing: 'god', search: ok, wakeUp: ok };
const sbx = async (t, extra) => (await C.runCanaries(deps(t, extra))).find((r) => r.feature === 'memory-from-sandbox');
const TEXT = 'not reachable from a sandboxed seat (judged from seat settings, not measured)';

test('settings that sandbox a seat: not reachable, as a judged result (ok null), while the app reaches the server', async (t) => {
  for (const scoped of [false, true]) {
    const rs = await C.runCanaries(deps(t, { memory: loopback, seatSettings: seatSandboxSettings(['/h/agents/a'], scoped) }));
    const by = Object.fromEntries(rs.map((r) => [r.feature, r]));
    assert.equal(by['memory-search'].ok, true, 'the app itself reaches the server');
    assert.deepEqual([by['memory-from-sandbox'].ok, by['memory-from-sandbox'].detail, by['memory-from-sandbox'].note],
      [null, 'judged-unreachable-from-sandbox', TEXT], `scoped=${scoped}`);
  }
});

test('settings that leave a seat unsandboxed let it reach the server: ok, judged from seat settings', async (t) => {
  const r = await sbx(t, { memory: loopback, seatSettings: seatSandboxSettings([], false) });
  assert.deepEqual([r.ok, r.detail], [true, 'judged-from-seat-settings']);
  const off = await sbx(t, { memory: loopback, seatSettings: { sandbox: { enabled: false, filesystem: { allowWrite: ['/x'] } } } });
  assert.deepEqual([off.ok, off.detail], [true, 'judged-from-seat-settings']);
});

test('memory off, or a server that is not probed, gives the same not-checked status as the memory probes', async (t) => {
  const seatSettings = seatSandboxSettings(['/x'], false);
  const off = await sbx(t, { seatSettings });
  assert.deepEqual([off.ok, off.detail], [null, 'off']);
  const r = await sbx(t, { memory: { ...loopback, plan: 'not-probed-remote' }, seatSettings });
  assert.deepEqual([r.ok, r.detail], [null, 'not-probed-remote']);
});

test('the weekly digest shows it as not judged, never as a failure', () => {
  const start = Date.parse('2026-11-02T00:00:00Z');
  const log = [JSON.stringify({ ts: start + 3600_000, kind: 'canary', feature: 'memory-from-sandbox', ok: null, detail: 'judged-unreachable-from-sandbox', note: TEXT })];
  const s = D.summarize({ log, ledger: [], usage: [], cards: new Set(), start, end: start + 7 * 86400_000 });
  assert.deepEqual(s.canaryCounts['memory-from-sandbox'], { passed: 0, failed: 0, notJudged: 1, details: [], notJudgedDetails: ['judged-unreachable-from-sandbox'] });
  assert.match(D.renderDigest(s, 'W'), /\*\*memory-from-sandbox\*\*: 0 passed, 1 not judged \(judged-unreachable-from-sandbox\)/);
});
