'use strict';

/**
 * MemoryManager.refresh() must not wipe a reachable Hindsight backend's
 * health latch on every status poll.
 *
 * The original bug: refresh() always called resetBinCache() which called
 * HindsightAdapter.resetCaches(), setting healthy=false right before the
 * synchronous available() read.  Because available() only fires a background
 * probe, the result was always false → status.active=false → "Not set up".
 *
 * Tests here reproduce each observable symptom, so the implementation cannot
 * regress without going red.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { MemoryManager } = loadTs('src/main/memory.ts');
const { MemPalaceAdapter } = loadTs('src/main/memPalaceAdapter.ts');

// ─── Stub helpers ────────────────────────────────────────────────────────────

/**
 * Minimal async-probing backend that simulates HindsightAdapter without HTTP.
 * Exposes counters so tests can verify call patterns.
 */
function makeHindsightStub(opts = {}) {
  const serverHealthy = opts.healthy !== false;
  const stub = {
    id: 'hindsight',
    probesAsync: true,
    _healthy: false,
    _probeCalls: 0,
    _resetCacheCalls: 0,

    available() { return this._healthy; },

    init() { void this.probeHealth(); },

    async probeHealth() {
      this._probeCalls++;
      // A real /health fetch is always async; simulate it so the test is not
      // trivially green just because the stub body runs synchronously.
      await Promise.resolve();
      this._healthy = serverHealthy;
      return serverHealthy;
    },

    resetCaches() {
      this._resetCacheCalls++;
      this._healthy = false;   // exact same wipe as HindsightAdapter.resetCaches()
    },

    status(enabled, home) {
      const avail = this._healthy;
      return {
        backend: 'hindsight',
        available: avail,
        enabled,
        active: avail && enabled && home !== null,
        initialized: false,
        location: 'http://example.test · test-bank',
        model: null,           // remote server owns its own model — nothing to name
        bin: null,
      };
    },

    agentEnv() { return {}; },
    async mineAgent() { return { ok: true }; },
    async search() { return { ok: true, output: '' }; },
    async wakeUp() { return { ok: true, output: '' }; },
  };
  return stub;
}

function makeManagerWith(t, stub) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hindsight-status-'));
  const settings = {
    enabled: true,
    backend: 'hindsight',
    mempalace: { model: 'minilm' },
    hindsight: { url: 'http://example.test', bank: 'test-bank' },
  };
  const memory = new MemoryManager(
    () => home,
    () => settings,
    () => stub,
  );
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });
  return memory;
}

// ─── (a) First-poll availability ─────────────────────────────────────────────

test('(a) first refresh() after switching to Hindsight reports available and active', async (t) => {
  const stub = makeHindsightStub({ healthy: true });
  const memory = makeManagerWith(t, stub);

  const status = await memory.refresh();

  assert.equal(status.available, true, 'available must be true on the first poll');
  assert.equal(status.active,    true, 'active must be true with a reachable Hindsight server');
});

// ─── (b) Healthy latch must survive repeated polls ────────────────────────────

test('(b) repeated refresh() calls do not wipe the latched healthy flag', async (t) => {
  const stub = makeHindsightStub({ healthy: true });
  const memory = makeManagerWith(t, stub);

  await memory.refresh();                          // first poll: probe fires, healthy latches
  const resetsBefore = stub._resetCacheCalls;

  await memory.refresh();
  await memory.refresh();

  assert.equal(
    stub._resetCacheCalls, resetsBefore,
    'resetCaches() must NOT be called on an async-probing backend after initial probe',
  );
  assert.equal(stub._healthy, true, 'the latched healthy flag must survive subsequent polls');

  const statusLater = await memory.refresh();
  assert.equal(statusLater.available, true, 'still available after multiple polls');
  assert.equal(statusLater.active,    true, 'still active after multiple polls');
});

// ─── (c) MemPalace sync bin-cache reset is preserved ─────────────────────────

test('(c) MemPalace sync backend still has resetCaches() called on every refresh()', (t) => {
  // Stub out MemPalaceAdapter's bin() so the test does not depend on PATH.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mempalace-preserve-'));
  let calls = 0;
  const settings = {
    enabled: true,
    backend: 'mempalace',
    mempalace: { model: 'minilm' },
    hindsight: { url: 'http://example.test', bank: 'test-bank' },
  };
  const memory = new MemoryManager(
    () => home,
    () => settings,
    () => {
      const adapter = new MemPalaceAdapter(
        () => path.join(home, 'palace'),
        () => 'minilm',
      );
      const origReset = adapter.resetCaches.bind(adapter);
      adapter.resetCaches = () => { calls++; origReset(); };
      return adapter;
    },
  );
  t.after(() => { memory.stop(); fs.rmSync(home, { recursive: true, force: true }); });

  memory.refresh();
  memory.refresh();
  memory.refresh();

  assert.ok(calls >= 3, `resetCaches() must be called on every MemPalace poll; got ${calls}`);
});

// ─── (d) Null server-model must not be coerced to "minilm" ───────────────────

test('(d) Hindsight backend status.model is not "minilm" (it has no local model)', async (t) => {
  const stub = makeHindsightStub({ healthy: true });
  const memory = makeManagerWith(t, stub);

  const status = await memory.refresh();

  assert.notEqual(status.model, 'minilm', 'null server-model must not be coerced to "minilm"');
  assert.equal(status.model, null, 'Hindsight reports no local model');
});

// ─── (e) Direct resetBinCache() must not wipe async-backend health latch ──────
//
// resetBinCache() has a second production caller: the tools:status IPC handler
// (src/main/index.ts). The probesAsync guard must live inside resetBinCache()
// itself, not only in refresh(), so both call sites are protected.

test('(e) resetBinCache() on an async-probing backend does not clear the health latch', async (t) => {
  const stub = makeHindsightStub({ healthy: true });
  const memory = makeManagerWith(t, stub);

  // Arm the backend first so the health latch is set.
  await memory.refresh();
  assert.equal(stub._healthy, true, 'precondition: health must be latched true before direct call');

  // Simulate the tools:status handler calling resetBinCache() directly —
  // without going through refresh().
  memory.resetBinCache();

  assert.equal(
    stub._resetCacheCalls, 0,
    'resetCaches() must NOT be called on an async-probing backend by resetBinCache()',
  );
  assert.equal(stub._healthy, true, 'the health latch must survive a direct resetBinCache() call');

  const status = memory.status();
  assert.equal(status.available, true, 'backend must still report available after resetBinCache()');
});
