'use strict';

/**
 * The `hive-memory` shim is a standalone script: it learns which backend to
 * talk to, and on whose behalf, entirely from its environment. If nothing sets
 * those variables the shim takes its "no backend" path and every agent's
 * `hive-memory search` prints the unavailable line, however healthy the backend
 * actually is. These tests pin the two ends of that wire.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { MemPalaceAdapter } = loadTs('src/main/memPalaceAdapter.ts');
const { HindsightAdapter } = loadTs('src/main/hindsightAdapter.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const SHIM = require.resolve('../resources/hive-memory.cjs');

test('every backend tells a spawned agent which one it is', () => {
  const mempalace = new MemPalaceAdapter(() => '/tmp/palace', () => 'minilm');
  mempalace.bin = () => '/fake/bin/mempalace'; // the real one probes this machine's PATH
  assert.equal(mempalace.agentEnv().HIVE_MEMORY_BACKEND, 'mempalace');

  const hindsight = new HindsightAdapter(() => ({ url: 'http://x', bank: 'b1' }), () => '/tmp/home');
  assert.equal(hindsight.agentEnv().HIVE_MEMORY_BACKEND, 'hindsight');
});

test('the name each backend reports is one the shim actually recognises', () => {
  // A backend id the shim does not know is indistinguishable from none at all.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-env-'));
  const fake = path.join(dir, 'mempalace');
  fs.writeFileSync(fake, '#!/bin/sh\necho REACHED "$@"\n');
  fs.chmodSync(fake, 0o755);

  const mempalace = new MemPalaceAdapter(() => '/tmp/palace', () => 'minilm');
  mempalace.bin = () => fake;
  const out = execFileSync(process.execPath, [SHIM, 'search', 'q'], {
    env: { ...process.env, ...mempalace.agentEnv(), PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.match(out, /REACHED search q/);
  assert.doesNotMatch(out, /unavailable/);
});

test('a spawned agent is told which agent the shim is recalling for', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-env-hive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const injected = await hive.ensureAgent({ id: 'pam', name: 'Pam', provider: 'claude', cwd: home }, {});

  assert.equal(injected.env.HIVE_MEMORY_AGENT, 'pam');
});
