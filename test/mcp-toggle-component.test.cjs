'use strict';

/**
 * T-057, the half nobody tested: the COMPONENT.
 *
 * test/mcp-toggle-state.test.cjs covers the two functions that were extracted
 * out of McpDefaultsSettings. It does not cover McpDefaultsSettings. Comment
 * out the `setMcpDefaults(await applyToggle(...))` line and every one of those
 * tests stays green while the reported bug returns in full. That exact failure
 * mode has shipped here four times, so these tests mount the real component,
 * click the real button, and read the real rendered label.
 *
 * The control under test is a CONSENT control. `hive-memory` is tier `write`
 * with defaultEnabled:false — it is only ever on because a human turned it on.
 * So the property is not "the toggle updates"; it is "the toggle shows what is
 * on disk, and never shows a grant that did not land".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { McpDefaultsSettings } = loadTs('src/renderer/src/components/McpDefaultsSettings.tsx');

// The id under test, written out literally. NOT imported from the catalog: a
// test that asks the implementation which id to check cannot notice the id
// changing, and this one must never change (the T-047 destructive-tool deny
// gate matches `munder-hive-memory` by name).
const HIVE_MEMORY = 'hive-memory';

/** The label the toggle button renders for a catalog id: 'on' | 'off'. */
function buttonLabel(tree, id) {
  const hit = flatten(tree).find((e) => e.key === id && e.node.type === 'button');
  assert.ok(hit, `no toggle button rendered for "${id}"`);
  return text(hit.node).join('');
}

/** Click the toggle button for a catalog id, exactly as a user would. */
function click(tree, id) {
  const hit = flatten(tree).find((e) => e.key === id && e.node.type === 'button');
  assert.ok(hit, `no toggle button rendered for "${id}"`);
  assert.equal(typeof hit.node.props.onClick, 'function', 'the button must be clickable');
  hit.node.props.onClick();
}

/**
 * Stand in for the preload bridge. `disk` is the real subject: updateConfig
 * writes into it (or refuses to), getConfig reads back out of it. Nothing here
 * echoes the caller's intent — that is the whole point.
 */
function fakeBridge({ disk = {}, acceptWrite = true } = {}) {
  const calls = { updateConfig: [], getConfig: 0 };
  const state = { mcpDefaults: { ...disk } };
  global.window = {
    cth: {
      updateConfig: async (patch) => {
        calls.updateConfig.push(patch);
        if (acceptWrite) state.mcpDefaults = { ...patch.mcpDefaults };
        return {};
      },
      getConfig: async () => { calls.getConfig += 1; return { mcpDefaults: { ...state.mcpDefaults } }; }
    }
  };
  return { calls, state };
}

/** Let the click's async chain settle. */
const settle = () => new Promise((r) => setImmediate(r));

test.afterEach(() => { delete global.window; });

// ── 1. the component renders from the resolver, not from nothing ─────────────

test('an unset write-tier server renders off', () => {
  fakeBridge();
  const inst = mount(McpDefaultsSettings, { config: { mcpDefaults: {} } });
  assert.equal(buttonLabel(inst.tree, HIVE_MEMORY), 'off',
    'hive-memory is write tier, defaultEnabled:false — unset must read as NOT granted');
});

test('a stored grant renders on', () => {
  fakeBridge();
  const inst = mount(McpDefaultsSettings, { config: { mcpDefaults: { [HIVE_MEMORY]: { enabled: true } } } });
  assert.equal(buttonLabel(inst.tree, HIVE_MEMORY), 'on');
});

// ── 2. the wiring — this is what the extracted-function tests cannot see ─────

test('clicking the toggle writes the merged map and re-renders from the disk read', async () => {
  const { calls } = fakeBridge({ disk: { 'other-server': { enabled: true } } });
  const inst = mount(McpDefaultsSettings, {
    config: { mcpDefaults: { 'other-server': { enabled: true } } }
  });
  assert.equal(buttonLabel(inst.tree, HIVE_MEMORY), 'off');

  click(inst.tree, HIVE_MEMORY);
  await settle();

  assert.equal(calls.updateConfig.length, 1, 'the click must reach updateConfig');
  assert.deepEqual(calls.updateConfig[0].mcpDefaults, {
    'other-server': { enabled: true },
    [HIVE_MEMORY]: { enabled: true }
  }, 'the patch replaces mcpDefaults wholesale, so it must carry the other entries');
  assert.ok(calls.getConfig >= 1, 'the component must RE-READ after writing, not trust the write');

  assert.equal(buttonLabel(inst.render(), HIVE_MEMORY), 'on',
    'the rendered label must follow the disk read — this is the T-057 symptom');
  assert.ok(text(inst.render()).join('').includes(`${HIVE_MEMORY}: enabled`),
    'the confirmation note must name what was granted');
});

test('the label refuses to show a grant the disk did not accept', async () => {
  // The write is swallowed: updateConfig resolves, disk stays false. An
  // optimistic component renders 'on' here and tells a human they granted a
  // write-tier server that is not armed.
  const { calls } = fakeBridge({ disk: { [HIVE_MEMORY]: { enabled: false } }, acceptWrite: false });
  const inst = mount(McpDefaultsSettings, {
    config: { mcpDefaults: { [HIVE_MEMORY]: { enabled: false } } }
  });

  click(inst.tree, HIVE_MEMORY);
  await settle();

  assert.equal(calls.updateConfig.length, 1);
  assert.equal(buttonLabel(inst.render(), HIVE_MEMORY), 'off',
    'consent control: the disk wins over intent, always');
});

test('a failed write leaves the label alone and says so', async () => {
  global.window = {
    cth: {
      updateConfig: async () => { throw new Error('EACCES'); },
      getConfig: async () => ({ mcpDefaults: { [HIVE_MEMORY]: { enabled: true } } })
    }
  };
  const inst = mount(McpDefaultsSettings, { config: { mcpDefaults: {} } });
  click(inst.tree, HIVE_MEMORY);
  await settle();
  assert.equal(buttonLabel(inst.render(), HIVE_MEMORY), 'off',
    'a throw must never leave the control claiming the grant went through');
  assert.ok(text(inst.render()).join('').includes('could not save'));
});

// ── 3. the reported bug, on REMOUNT ──────────────────────────────────────────

test('the granted state survives closing and reopening the panel', async () => {
  // SettingsModal renders <McpDefaultsSettings config={config} /> only while
  // activeSection === 'Connections', and SettingsModal's own `config` prop is
  // App's, which App loads once at start-up and never refreshes after a save.
  // So switching settings sections and back is a real REMOUNT against a config
  // object that still says the grant never happened.
  const stale = { mcpDefaults: { [HIVE_MEMORY]: { enabled: false } } };
  const { state } = fakeBridge({ disk: { [HIVE_MEMORY]: { enabled: false } } });

  const first = mount(McpDefaultsSettings, { config: stale });
  click(first.tree, HIVE_MEMORY);
  await settle();
  assert.equal(buttonLabel(first.render(), HIVE_MEMORY), 'on');
  assert.equal(state.mcpDefaults[HIVE_MEMORY].enabled, true, 'the grant is on disk');

  // …user switches to another settings section and comes back. Same stale prop.
  const second = mount(McpDefaultsSettings, { config: stale });
  await settle();
  assert.equal(buttonLabel(second.render(), HIVE_MEMORY), 'on',
    'seeding from the prop alone re-runs the exact bug that was reported: '
    + 'the write landed, and the control shows off');
});
