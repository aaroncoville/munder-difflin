'use strict';

// T-068 — an UNCAPPED ephemeral worker must now inherit a 10,000,000-token
// default so that running a worker uncapped is a DECISION (`defaultWorkerTokenCap: 0`)
// rather than an omission.
//
// These tests deliberately do NOT read the expected cap out of the config they are
// checking. Asserting `cap === cfg.defaultWorkerTokenCap` would pass at ANY value —
// including the old 0 — and that exact defect has shipped in this repo. Every
// expectation below is an independent literal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// config.ts resolves its file through Electron's app.getPath(). Point that one
// dependency at a throwaway userData root so this test never touches the real
// application config.
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-worker-cap-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const {
  resolveDefaultWorkerTokenCap,
  effectiveWorkerTokenCap
} = loadTs('src/shared/tokenCaps.ts');

const REPO_ROOT = path.resolve(__dirname, '..');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a worker with no cap of its own inherits the 10M shipped default', () => {
  // No config.json written: this is the shipped default a fresh install gets.
  fs.rmSync(path.join(userData, 'config.json'), { force: true });
  const shipped = readConfig().defaultWorkerTokenCap;

  assert.equal(effectiveWorkerTokenCap(undefined, shipped), 10_000_000);
  assert.equal(effectiveWorkerTokenCap(0, shipped), 10_000_000);
  assert.equal(effectiveWorkerTokenCap(null, shipped), 10_000_000);
});

test("an explicit positive worker cap wins over the default — the default never overrides a deliberate choice", () => {
  fs.rmSync(path.join(userData, 'config.json'), { force: true });
  const shipped = readConfig().defaultWorkerTokenCap;

  // Below the default…
  assert.equal(effectiveWorkerTokenCap(250_000, shipped), 250_000);
  // …and above it. Both keep the worker's own number.
  assert.equal(effectiveWorkerTokenCap(75_000_000, shipped), 75_000_000);
  // A per-worker cap also wins when the config default is explicitly unlimited.
  assert.equal(effectiveWorkerTokenCap(250_000, 0), 250_000);
});

test('defaultWorkerTokenCap: 0 still means UNLIMITED — the escape hatch survives', () => {
  writeConfig({ defaultWorkerTokenCap: 0 });

  const stored = readConfig().defaultWorkerTokenCap;
  assert.equal(stored, 0, 'an explicit 0 must persist, not be replaced by the default');
  // 0 = no cap: the reaper treats a non-positive effective cap as "never throttle".
  assert.equal(effectiveWorkerTokenCap(undefined, stored), 0);
  assert.equal(resolveDefaultWorkerTokenCap(stored), 0);
});

test('a malformed defaultWorkerTokenCap cannot produce a nonsense cap', () => {
  for (const bad of [-1, -10_000_000, Number.NaN, Infinity, -Infinity, '10000000', '', null, undefined, {}, [], true]) {
    const resolved = resolveDefaultWorkerTokenCap(bad);
    assert.equal(resolved, 0, `expected ${String(bad)} to resolve to 0 (unlimited), got ${String(resolved)}`);
    assert.equal(Number.isFinite(resolved), true);
    assert.equal(resolved >= 0, true);
  }
  // …and the same garbage stored in config must not reach a worker as a cap.
  writeConfig({ defaultWorkerTokenCap: -5 });
  assert.equal(effectiveWorkerTokenCap(undefined, readConfig().defaultWorkerTokenCap), 0);
  // A worker's OWN malformed cap falls back to the default rather than to garbage.
  assert.equal(effectiveWorkerTokenCap(Number.NaN, 10_000_000), 10_000_000);
  assert.equal(effectiveWorkerTokenCap(-1, 10_000_000), 10_000_000);
});

test('the worker controller and the workers tab both resolve caps through the shared helper', () => {
  // Guards the wiring: if a call site re-inlines its own `cfg.defaultWorkerTokenCap > 0`
  // check, the behaviour above stops describing what the app actually does.
  const src = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf8');
  const calls = src.match(/effectiveWorkerTokenCap\(/g) ?? [];
  assert.equal(calls.length, 2, 'both the reaper tick and workers:list must call the shared helper');
  assert.equal(
    /defaultWorkerTokenCap\s*(===|!==|>|<)/.test(src),
    false,
    'no call site may re-implement the default-cap resolution inline'
  );
});
