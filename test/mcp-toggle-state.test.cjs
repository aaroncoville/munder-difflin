'use strict';

/**
 * T-057 — MCP toggle must display what is on disk, not what we hoped we wrote.
 *
 * Bug: McpDefaultsSettings.toggle() called updateConfig() then showed the
 * optimistic `next` value. The component never refetched, so the displayed
 * state was what we *intended* to write, not what was *actually persisted*.
 * For a consent control this is dangerous: a human may believe the grant
 * succeeded when it silently reverted.
 *
 * Fix: applyToggle() (extracted from the component) calls updateConfig(),
 * then getConfig(), and returns the mcpDefaults from the live disk read.
 * The component seeds its local state from that return value, so the button
 * re-renders from reality, not from hope.
 *
 * Two assertions that actually bite:
 *
 * 1. Happy path: getConfig confirms the write. The returned state agrees.
 *
 * 2. Critical: getConfig says enabled:false even though next=true.
 *    An optimistic implementation returns true here.
 *    The fix must return false — what is on disk wins.
 *
 * To verify the test actually bites: make applyToggle ignore getConfig and
 * return the optimistic value — assertion 2 must go RED.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { applyToggle, resolveEnabledFor } = loadTs('src/renderer/src/components/mcpToggleLogic.ts');

const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');
// Catalog id (hive-memory) — buildDefaultMcpServers namespaces it to
// munder-hive-memory but the catalog entry itself uses hive-memory.
const HIVE_MEMORY_ID = 'hive-memory';

// ── applyToggle — the state-transition path ──────────────────────────────────

test('applyToggle returns mcpDefaults from getConfig when the write succeeds', async () => {
  const deps = {
    updateConfig: async () => ({}),
    getConfig: async () => ({ mcpDefaults: { [HIVE_MEMORY_ID]: { enabled: true } } })
  };
  const result = await applyToggle(HIVE_MEMORY_ID, true, {}, deps);
  assert.deepEqual(result[HIVE_MEMORY_ID], { enabled: true });
});

test('applyToggle returns disk state even when it contradicts next — the consent property', async () => {
  // getConfig says false, but we passed next=true.
  // Optimistic implementation: returns { enabled: true }  =>  TEST RED
  // Correct implementation:    returns { enabled: false } =>  TEST GREEN
  const deps = {
    updateConfig: async () => ({}),
    getConfig: async () => ({ mcpDefaults: { [HIVE_MEMORY_ID]: { enabled: false } } })
  };
  const result = await applyToggle(HIVE_MEMORY_ID, true, {}, deps);
  assert.deepEqual(result[HIVE_MEMORY_ID], { enabled: false },
    'consent control must show what is on disk, not what we hoped we wrote');
});

test('applyToggle merges the id change into currentDefaults when calling updateConfig', async () => {
  const captured = [];
  const deps = {
    updateConfig: async (patch) => { captured.push(patch); return {}; },
    getConfig: async () => ({ mcpDefaults: { [HIVE_MEMORY_ID]: { enabled: true } } })
  };
  const currentDefaults = { 'some-other-server': { enabled: true } };
  await applyToggle(HIVE_MEMORY_ID, true, currentDefaults, deps);
  assert.equal(captured.length, 1);
  assert.deepEqual(captured[0].mcpDefaults, {
    'some-other-server': { enabled: true },
    [HIVE_MEMORY_ID]: { enabled: true }
  });
});

// ── resolveEnabledFor — catalog fallback path ────────────────────────────────

test('resolveEnabledFor falls back to the catalog defaultEnabled for an unset id', () => {
  const entry = MCP_CATALOG.find((e) => e.id === HIVE_MEMORY_ID);
  assert.ok(entry, `${HIVE_MEMORY_ID} must exist in the catalog`);
  const result = resolveEnabledFor({}, HIVE_MEMORY_ID);
  assert.equal(result, entry.defaultEnabled ?? false);
});

test('resolveEnabledFor returns false for a completely unknown id', () => {
  assert.equal(resolveEnabledFor({}, 'not-a-real-server'), false);
});

test('resolveEnabledFor respects explicit false even when catalog default is true', () => {
  // Fixture catalog: one entry with defaultEnabled:true
  const fixtureCatalog = [{ id: HIVE_MEMORY_ID, defaultEnabled: true, tier: 'safe-readonly', label: 'x', description: '' }];
  const overrides = { [HIVE_MEMORY_ID]: { enabled: false } };
  assert.equal(resolveEnabledFor(overrides, HIVE_MEMORY_ID, fixtureCatalog), false,
    'explicit human opt-out must beat the catalog default');
});

test('resolveEnabledFor uses the injected catalog, not a shared constant', () => {
  // This test uses a FIXTURE catalog with a custom id — never in the real catalog.
  // If resolveEnabledFor shared the catalog constant with the test, this id would
  // not be found and the fallback (false) would mask a wrong catalog lookup.
  const fixtureCatalog = [{ id: 'fixture-server', defaultEnabled: true, tier: 'safe-readonly', label: 'x', description: '' }];
  assert.equal(resolveEnabledFor({}, 'fixture-server', fixtureCatalog), true,
    'catalog param drives the defaultEnabled fallback');
  assert.equal(resolveEnabledFor({}, 'fixture-server'), false,
    'real catalog has no fixture-server, so fallback is false — confirms injection works');
});
