'use strict';

// A canary pass can start while the machine is in a brief background wake and finish after it has slept again, or run
// entirely inside such a wake while a local service is frozen. Neither says anything about the service, so such a
// probe is reported as 'host-slept' (ok null) with the rule that said so, not judged. Node's monotonic clock on macOS
// counts time asleep, so these tests move the wall clock and model no clock that stands still.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const C = loadTs('src/main/canaries.ts');

function deps(t, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-canary-slept-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { memory: null, kg: null, hook: null, helpers: [], pathDirs: [], launches: new Map(), ledgerPath: path.join(dir, 'l.jsonl'), ...extra };
}

/** A wall clock, and memory probes that each take `ms` of it and give `result` (after calling `during`, if any). */
function probes(ms, result = { ok: false, output: '', error: 'error' }, during) {
  const c = { wall: 1_800_000_000_000 };
  const probe = async () => { c.wall += ms; during?.(); return result; };
  return { now: () => c.wall, memory: { plan: 'probe', wing: 'god', search: probe, wakeUp: probe } };
}

const run = async (t, extra) => Object.fromEntries((await C.runCanaries(deps(t, extra))).map((r) => [r.feature, r]));
const verdict = (r) => [r.ok, r.detail, r.rule];

test('a probe that ended 15 minutes after it began, past its 20 s limit, slept', async (t) => {
  const r = await run(t, probes(900_000));
  assert.deepEqual(verdict(r['memory-search']), [null, 'host-slept', 'ran past its limit']);
  assert.equal(r['memory-search'].ms, 900_000, 'the wall duration is still recorded');
});

test('a probe that fails well inside its limit is a real failure', async (t) => {
  const r = await run(t, probes(5_000));
  assert.deepEqual(verdict(r['memory-search']), [false, 'error', undefined]);
});

test('the margin is 10 s past the 20 s limit', async (t) => {
  assert.deepEqual(verdict((await run(t, probes(29_999)))['memory-search']), [false, 'error', undefined]);
  assert.deepEqual(verdict((await run(t, probes(30_001)))['memory-search']), [null, 'host-slept', 'ran past its limit']);
});

test('a suspend during a fast-failing probe: host-slept by the suspend flag', async (t) => {
  const power = new C.SuspendFlag();
  const r = await run(t, { ...probes(5_000, undefined, () => power.suspend()), power });
  assert.deepEqual(verdict(r['memory-search']), [null, 'host-slept', 'suspend flag']);
});

test('after a suspend with no resume (a background wake), a failure is not judged; a success clears the flag', async (t) => {
  const power = new C.SuspendFlag();
  power.suspend();
  assert.deepEqual(verdict((await run(t, { ...probes(5_000), power }))['memory-search']), [null, 'host-slept', 'suspend flag']);
  const ok = await run(t, { ...probes(1_000, { ok: true, output: '— hit' }), power });
  assert.equal(ok['memory-search'].ok, true);
  assert.deepEqual(verdict((await run(t, { ...probes(5_000), power }))['memory-search']), [false, 'error', undefined], 'the service answered once, so a later failure counts');
});

test('a resume clears the flag', async (t) => {
  const power = new C.SuspendFlag();
  power.suspend();
  power.clear();
  assert.deepEqual(verdict((await run(t, { ...probes(5_000), power }))['memory-search']), [false, 'error', undefined]);
});

test('a feature that is off stays off while the flag is set', async (t) => {
  const power = new C.SuspendFlag();
  power.suspend();
  const r = await run(t, { power });
  assert.deepEqual(verdict(r['memory-search']), [null, 'off', undefined]);
});

test('canaries that never leave the app do not clear the flag: a second background-wake pass is still not judged', async (t) => {
  const power = new C.SuspendFlag();
  power.suspend();
  // The knowledge graph, helper and launch checks run in the app's own process and pass while the service is frozen.
  const pass = () => run(t, { ...probes(5_000), kg: { search: () => [1] }, power });
  assert.equal((await pass())['kg-search'].ok, true, 'an in-process canary passed during the first pass');
  const second = await pass();
  assert.deepEqual(verdict(second['memory-search']), [null, 'host-slept', 'suspend flag']);
  assert.deepEqual(verdict(second['memory-wakeup']), [null, 'host-slept', 'suspend flag']);
});

test('a suspend while a probe is in flight, cleared again before it ends, still marks that probe', async (t) => {
  const power = new C.SuspendFlag();
  const r = await run(t, { ...probes(5_000, undefined, () => { power.suspend(); power.clear(); }), power });
  assert.deepEqual(verdict(r['memory-search']), [null, 'host-slept', 'suspend flag']);
});
