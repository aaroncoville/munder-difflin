'use strict';

/**
 * The Add-Agent model picker, mounted for real.
 *
 * A pure-function test of the overlay rule proves nothing about this screen:
 * it stays green when the picker keeps rendering the hardcoded list. So this
 * mounts the actual modal, walks to the Engine section the way a user does,
 * clicks the actual Refresh control, and reads the chips that come back.
 *
 * The static and live labels are deliberately distinguishable — the built-in
 * list spells the model "GPT-5.6 Sol", codex's own catalog spells it
 * "GPT-5.6-Sol" — so an assertion cannot pass by accident on the wrong list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

// The store is a zustand hook and the modal measures its own layout; neither
// is part of what this file tests, so the two extra hooks the ~60-line React
// host does not implement are filled in here.
const React = require('react');
React.useLayoutEffect = React.useEffect;
React.useSyncExternalStore = (_subscribe, getSnapshot) => getSnapshot();
React.useDebugValue = () => {};

const { AddAgentModal } = loadTs('src/renderer/src/components/AddAgentModal.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

/** A codex account's live catalog, shaped as the IPC hands it over. */
const LIVE = {
  models: [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-7-preview', label: 'GPT-7-Preview' }
  ],
  default: 'gpt-5.6-sol'
};

/** A model the built-in list has never heard of — proof the chips came from the
 *  live answer and not from a lucky overlap with the hardcoded list. */
const LIVE_ONLY = 'GPT-7-Preview';
/** A built-in codex label, written out rather than imported: a list read from
 *  the implementation would agree with it however the picker behaved. */
const STATIC_LABEL = 'GPT-5.6 Sol';
const CLI_DEFAULT = 'CLI default';

const CONFIG = {
  onboardingComplete: true,
  harnessHome: '/tmp/harness',
  registeredRepos: ['/tmp/project'],
  autoMode: false,
  defaultCommand: 'codex',
  semanticMemory: false,
  embeddingModel: 'minilm'
};

function fakeBridge(refreshModels) {
  const calls = [];
  global.window = {
    addEventListener() {},
    removeEventListener() {},
    cth: {
      openExternal() {},
      catalogCapableProviders: ['codex'],
      refreshModels: async (provider) => { calls.push(provider); return refreshModels(provider); }
    }
  };
  return calls;
}

/** Open the modal on its Engine section, where the model picker lives. */
function openEngineSection(props = {}) {
  const inst = mount(AddAgentModal, { onClose() {}, config: CONFIG, ...props });
  const nav = flatten(inst.tree).find((e) => e.key === 'engine' && e.node.type === 'button');
  assert.ok(nav, 'the Engine section must be reachable from the sidebar index');
  nav.node.props.onClick();
  inst.render();
  return inst;
}

/** Every clickable chip label currently rendered. */
const chips = (tree) =>
  flatten(tree)
    .filter((e) => e.node.type === 'button' && typeof e.node.props.onClick === 'function')
    .map((e) => text(e.node).join(''));

/** The control that asks the provider for its current list. */
function refreshControl(tree) {
  return flatten(tree).find((e) =>
    typeof e.node.type === 'function' &&
    typeof e.node.props.onClick === 'function' &&
    text(e.node).join('').toLowerCase().includes('refresh'));
}

const settle = () => new Promise((r) => setImmediate(r));

test.beforeEach(() => { useStore.setState({ liveModels: {}, modelErrors: {} }); });
test.afterEach(() => { delete global.window; });

test('before any refresh the picker shows the built-in list and offers a refresh', () => {
  fakeBridge(async () => LIVE);
  const inst = openEngineSection();
  assert.ok(chips(inst.tree).includes(STATIC_LABEL), 'the built-in list is what a cold picker shows');
  assert.ok(refreshControl(inst.tree), 'codex reports a live catalog, so the control must be offered');
});

test('a refresh replaces the chips with the account\'s own models', async () => {
  const calls = fakeBridge(async () => LIVE);
  const inst = openEngineSection();

  refreshControl(inst.tree).node.props.onClick();
  await settle();
  const after = chips(inst.render());

  assert.deepEqual(calls, ['codex'], 'the refresh must ask for the provider on screen');
  assert.ok(after.includes(LIVE_ONLY), 'a model only the live answer knows about must be offered');
  assert.ok(!after.includes(STATIC_LABEL), 'the stale built-in entry must be gone, not shown alongside');
  assert.ok(after.includes(CLI_DEFAULT),
    'the no---model option is a harness choice, not a listed model: a refresh must not remove it');
});

test('the provider\'s own default is marked on the chip', async () => {
  fakeBridge(async () => LIVE);
  const inst = openEngineSection();
  refreshControl(inst.tree).node.props.onClick();
  await settle();
  const marked = chips(inst.render()).filter((c) => c.includes('default') && c.includes('GPT-5.6-Sol'));
  assert.equal(marked.length, 1, 'exactly the model codex flags as its default must say so');
});

test('a failed refresh keeps the built-in list and explains itself', async () => {
  fakeBridge(async () => ({ error: 'Couldn\'t reach codex — showing the built-in list.' }));
  const inst = openEngineSection();

  refreshControl(inst.tree).node.props.onClick();
  await settle();
  const tree = inst.render();

  assert.ok(chips(tree).includes(STATIC_LABEL), 'the picker must never be emptied by a failure');
  assert.ok(text(tree).join(' ').includes('showing the built-in list'),
    'the user must be told why the list did not change');
});

test('a provider with no live catalog is offered no refresh control', () => {
  fakeBridge(async () => LIVE);
  const inst = openEngineSection({ config: { ...CONFIG, defaultCommand: 'claude' } });
  assert.ok(chips(inst.tree).includes('Opus 4.8'), 'sanity: this is the Claude picker');
  assert.equal(refreshControl(inst.tree), undefined,
    'claude has no adapter, so a Refresh button could only ever fail');
});

test('a live list survives closing and reopening the modal', async () => {
  fakeBridge(async () => LIVE);
  const first = openEngineSection();
  refreshControl(first.tree).node.props.onClick();
  await settle();
  assert.ok(chips(first.render()).includes(LIVE_ONLY));

  // Same session, fresh mount: the catalog is session state, so a user who
  // refreshed once should not have to refresh again for the next agent.
  const second = openEngineSection();
  assert.ok(chips(second.tree).includes(LIVE_ONLY),
    'the refreshed list must outlive the modal that fetched it');
});
