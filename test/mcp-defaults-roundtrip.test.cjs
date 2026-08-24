'use strict';

/**
 * T-057, thesis 1: the existing tests mock BOTH `updateConfig` and `getConfig`,
 * and together those two ARE persistence. If the round-trip they stand in for
 * were broken, every one of those tests would still be green and the toggle
 * would still lie. So this file uses NO mocks: the real writeConfig, the real
 * readConfig, a real config.json in a temp userData dir, and the real
 * buildDefaultMcpServers that turns the stored map into armed servers.
 *
 * What it pins:
 *
 *  - the grant genuinely survives the disk (the fix's premise);
 *  - readConfig merges one level deep (`{ ...DEFAULTS, ...parsed }`,
 *    config.ts:595), so a PARTIAL stored map replaces the 11-entry default map
 *    wholesale rather than being filled back in;
 *  - what that costs, in both directions: it can never arm a server (both
 *    readers fall back to the catalog default, and consent tiers need an
 *    explicit true), but it DOES discard an explicit opt-out;
 *  - the toggle path never causes that loss, because it merges over what it
 *    read from disk.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// config.ts and hive.ts reach `app` for the userData path; outside Electron the
// resolve yields a path string, so seed the cache with just the surface they
// touch — pointed at a temp dir this file owns. (Same trick as
// test/harness-home-tilde.test.cjs.)
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-roundtrip-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: {
    app: { getPath: () => userData, getAppPath: () => process.cwd(), isPackaged: false },
    ipcMain: { handle() {}, on() {} },
    BrowserWindow: class {}
  }
};

const loadTs = require('./load-ts.cjs');
const { readConfig, writeConfig } = loadTs('src/main/config.ts');
const { applyToggle, resolveEnabledFor } = loadTs('src/renderer/src/components/mcpToggleLogic.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

// `private` in TypeScript is erased at run time. Reach the REAL method rather
// than restating its rules in the test — a reimplemented call site is exactly
// the mistake that has shipped defects here before. It reads no `this`.
const buildDefaultMcpServers = HiveManager.prototype.buildDefaultMcpServers;

// Written out, never imported. A test that asks the implementation which name
// to check cannot notice that name changing — and this one must not change:
// control.ts keys the destructive-tool deny gate off it (T-047).
const HIVE_MEMORY = 'hive-memory';
const HIVE_MEMORY_SERVER = 'munder-hive-memory';

const configFile = () => path.join(userData, 'config.json');
const reset = () => fs.rmSync(configFile(), { force: true });

test.beforeEach(reset);
test.after(() => { fs.rmSync(userData, { recursive: true, force: true }); });

/** The renderer's two IPC calls, wired to the real main-process functions. */
const realBridge = {
  updateConfig: async (patch) => writeConfig(patch),
  getConfig: async () => readConfig()
};

// ── the round-trip the existing tests mock away ──────────────────────────────

test('a grant written through applyToggle really comes back off the disk', async () => {
  const seeded = readConfig().mcpDefaults;
  assert.equal(resolveEnabledFor(seeded, HIVE_MEMORY), false, 'write tier starts un-granted');

  const returned = await applyToggle(HIVE_MEMORY, true, seeded, realBridge);

  assert.equal(returned[HIVE_MEMORY].enabled, true, 'applyToggle reports the grant');
  assert.equal(
    JSON.parse(fs.readFileSync(configFile(), 'utf8')).mcpDefaults[HIVE_MEMORY].enabled,
    true,
    'and it is in config.json — read from the file, not from the API that wrote it'
  );
  assert.equal(resolveEnabledFor(readConfig().mcpDefaults, HIVE_MEMORY), true,
    'a fresh readConfig serves it back');
});

test('revoking a grant survives the disk too', async () => {
  // Deliberately a safe-readonly server, whose catalog default is ON. Revoking
  // hive-memory back to false would assert a value the defaults also produce,
  // so the test would stay green on a revoke that never persisted at all.
  const defaultOn = MCP_CATALOG.find((e) => e.tier === 'safe-readonly');
  assert.equal(defaultOn.defaultEnabled, true, 'this test needs a default-ON server');

  const after = await applyToggle(defaultOn.id, false, readConfig().mcpDefaults, realBridge);

  assert.equal(after[defaultOn.id].enabled, false);
  assert.equal(resolveEnabledFor(readConfig().mcpDefaults, defaultOn.id), false,
    'a revoke that does not persist is worse than a grant that does not');
});

// ── the shallow spread, characterized ────────────────────────────────────────

test('a partial stored mcpDefaults replaces the default map wholesale', () => {
  assert.equal(Object.keys(readConfig().mcpDefaults).length, MCP_CATALOG.length,
    'with no file, DEFAULTS supplies an entry per catalog id');

  fs.writeFileSync(configFile(), JSON.stringify({ mcpDefaults: { [HIVE_MEMORY]: { enabled: true } } }));

  assert.deepEqual(readConfig().mcpDefaults, { [HIVE_MEMORY]: { enabled: true } },
    'readConfig merges one level deep, so the stored map is served verbatim — '
    + 'the other 10 entries are NOT filled back in from DEFAULTS');
});

test('an id missing from a partial map can never arm a consent-tier server', () => {
  // The dangerous reading of "the stored map replaces the defaults": an id
  // vanishes, and something downstream treats absence as permission.
  const partial = { 'some-unrelated-server': { enabled: true } };
  const armed = Object.keys(buildDefaultMcpServers.call({}, '/tmp/agent-cwd', partial));

  assert.ok(!armed.includes(HIVE_MEMORY_SERVER),
    'hive-memory is write tier: absent must mean NOT granted. If this ever goes '
    + 'green with the server armed, a partial or hand-edited config silently '
    + 'hands an agent the bank that the T-047 gate exists to police.');
  for (const entry of MCP_CATALOG.filter((e) => e.tier !== 'safe-readonly')) {
    assert.ok(!armed.includes(`munder-${entry.id}`),
      `${entry.id} is ${entry.tier} tier and must need an explicit true`);
  }
});

test('a consent-tier server needs literal true, not merely something truthy', () => {
  // The other half of the same defence, and the half absence alone cannot
  // exercise: config.json is a plain file a human can edit, so `enabled` can
  // arrive as 1, or "true", or {}. Only `=== true` is consent. Without this
  // case the explicit-consent guard can be deleted outright and the suite
  // stays green, because an ABSENT id is already stopped by the tier default.
  for (const truthy of [1, 'true', 'false', {}, []]) {
    const armed = Object.keys(
      buildDefaultMcpServers.call({}, '/tmp/agent-cwd', { [HIVE_MEMORY]: { enabled: truthy } })
    );
    assert.ok(!armed.includes(HIVE_MEMORY_SERVER),
      `enabled:${JSON.stringify(truthy)} is not a human saying yes`);
  }
  const granted = Object.keys(
    buildDefaultMcpServers.call({}, '/tmp/agent-cwd', { [HIVE_MEMORY]: { enabled: true } })
  );
  assert.ok(granted.includes(HIVE_MEMORY_SERVER),
    'and a real grant must still arm it, or this test would pass by refusing everything');
});

test('an explicit opt-out is what a partial map actually costs', () => {
  // The honest downside. A safe-readonly server defaults ON, so dropping its
  // entry is not neutral — it re-enables something a human turned off.
  const optedOut = MCP_CATALOG.find((e) => e.tier === 'safe-readonly');
  assert.ok(optedOut, 'the catalog must have a safe-readonly server');

  const kept = buildDefaultMcpServers.call({}, '/tmp/agent-cwd', { [optedOut.id]: { enabled: false } });
  assert.ok(!Object.keys(kept).includes(`munder-${optedOut.id}`),
    'while the entry is present, the opt-out holds');

  const dropped = buildDefaultMcpServers.call({}, '/tmp/agent-cwd', {});
  assert.ok(Object.keys(dropped).includes(`munder-${optedOut.id}`),
    `dropping ${optedOut.id}'s entry re-arms it — a partial write costs opt-outs, `
    + 'not grants. This is why the toggle must merge over the DISK, never over a '
    + 'possibly-stale in-memory map.');
});

// ── and the toggle does not pay that cost ────────────────────────────────────

test('toggling one server preserves every other entry through a real write', async () => {
  const optedOut = MCP_CATALOG.find((e) => e.tier === 'safe-readonly');
  // A human turns a default-on server off, then grants hive-memory.
  await applyToggle(optedOut.id, false, readConfig().mcpDefaults, realBridge);
  await applyToggle(HIVE_MEMORY, true, readConfig().mcpDefaults, realBridge);

  const onDisk = readConfig().mcpDefaults;
  assert.equal(onDisk[HIVE_MEMORY].enabled, true, 'the new grant landed');
  assert.equal(onDisk[optedOut.id].enabled, false,
    'and the earlier opt-out was not collateral — writeConfig replaces mcpDefaults '
    + 'wholesale, so the patch has to carry everything the disk already held');
  assert.equal(Object.keys(onDisk).length, MCP_CATALOG.length,
    'no catalog entry was dropped along the way');

  const armed = Object.keys(buildDefaultMcpServers.call({}, '/tmp/agent-cwd', onDisk));
  assert.ok(armed.includes(HIVE_MEMORY_SERVER), 'the granted server is armed for the next spawn');
  assert.ok(!armed.includes(`munder-${optedOut.id}`), 'the opted-out server stays dark');
});
