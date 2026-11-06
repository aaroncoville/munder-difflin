'use strict';

/**
 * hive:send can answer ok:false, for example when the registry cannot be read. What a person typed is the only copy,
 * so a failed send must leave it in place and say so. These mount the real components and click their real buttons.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten } = require('./render-hooks.cjs');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { ThreadsPanel } = loadTs('src/renderer/src/components/ThreadsPanel.tsx');
const { AskMeTab } = loadTs('src/renderer/src/components/AskMeTab.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const FAILED = { ok: false, code: 'registry-unreadable', error: 'The agent registry could not be read, so this message was not sent.' };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];
const nodes = (tree) => flatten(tree).map((e) => e.node);
const find = (tree, predicate) => nodes(tree).find(predicate);
const shown = (view) => JSON.stringify(nodes(view.tree).map((n) => (n && n.props && typeof n.props.children === 'string' ? n.props.children : typeof n === 'string' ? n : '')));

test.afterEach(() => {
  while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.();
  for (const id of Object.keys(useStore.getState().answerDrafts ?? {})) useStore.getState().setAnswerDraft(id, '');
});

// ---- thread replies ----

const incoming = { id: 'm1', conversation: 'c1', from: 'worker-1', to: 'a', act: 'inform', subject: 'hello', body: 'hi', created_at: '2026-01-01T00:00:00.000Z' };

async function openThread(hiveSend) {
  const calls = [];
  global.window = { cth: {
    hiveInbox: async () => [incoming],
    hiveSend: async (msg, from) => { calls.push({ msg, from }); return hiveSend(); }
  } };
  const view = mount(ThreadsPanel, { agentId: 'a' });
  mounted.push(view);
  await settle();
  view.render();
  const box = find(view.tree, (n) => n?.type === 'textarea');
  assert.ok(box, 'a thread opens to its reply box');
  box.props.onChange({ target: { value: 'my only copy of this reply' } });
  view.render();
  return { view, calls };
}
const replySend = (view) => find(view.tree, (n) => n?.props?.size === 'sm' && n?.props?.onClick && 'disabled' in n.props);
const replyBox = (view) => find(view.tree, (n) => n?.type === 'textarea');

test('a thread reply that fails keeps the draft and says why', async () => {
  const { view, calls } = await openThread(() => FAILED);
  await replySend(view).props.onClick();
  await settle();
  view.render();
  assert.equal(calls.length, 1);
  assert.equal(replyBox(view).props.value, 'my only copy of this reply', 'the typed reply was thrown away');
  assert.match(shown(view), /could not be read/);
});

test('a thread reply whose send rejects keeps the draft and says why', async () => {
  const { view } = await openThread(async () => { throw new Error('bridge gone'); });
  await replySend(view).props.onClick();
  await settle();
  view.render();
  assert.equal(replyBox(view).props.value, 'my only copy of this reply');
  assert.match(shown(view), /bridge gone/);
});

test('a thread reply that goes out clears the draft, and a retry clears the old error', async () => {
  let result = FAILED;
  const { view } = await openThread(() => result);
  await replySend(view).props.onClick();
  await settle();
  view.render();
  result = { ok: true };
  await replySend(view).props.onClick();
  await settle();
  view.render();
  assert.equal(replyBox(view).props.value, '');
  assert.doesNotMatch(shown(view), /failed|could not be read/, 'the old error stays up after a reply that went out');
});

// ---- ask me answers ----

const card = { id: 'T-1', title: 'card', status: 'blocked', humanQA: [{ q: 'does it render?' }] };

async function answer(hiveSend) {
  const patches = [];
  global.window = { cth: {
    hiveTasks: async () => ({ tasks: [card] }),
    hivePatchTask: async (id, patch) => { patches.push({ id, patch }); return { ok: true }; },
    hiveSend
  } };
  const view = mount(AskMeTab, {});
  mounted.push(view);
  await settle();
  view.render();
  find(view.tree, (n) => n?.type === 'textarea').props.onChange({ target: { value: 'yes it does' } });
  view.render();
  await find(view.tree, (n) => n?.props?.children === 'respond & unblock').props.onClick();
  await settle();
  view.render();
  return { view, patches };
}

test('an answer saved on the card but not sent to the orchestrator says exactly that', async () => {
  const { view, patches } = await answer(async () => FAILED);
  assert.equal(patches.length, 1, 'the answer is on the card');
  assert.match(shown(view), /saved on the card/i);
  assert.match(shown(view), /could not be read/);
});

test('an answer that goes out shows no such message', async () => {
  const { view } = await answer(async () => ({ ok: true }));
  assert.doesNotMatch(shown(view), /saved on the card/i);
});

// ---- command center dispatch ----

function liveDispatch(res) {
  const file = path.resolve(__dirname, '..', 'src/renderer/src/components/CommandCenterPanel.tsx');
  const tree = ts.createSourceFile('c.tsx', fs.readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  let found;
  const visit = (n) => {
    if (ts.isVariableStatement(n) && n.declarationList.declarations[0]?.name.getText(tree) === 'dispatch') found = n;
    else if (!found) ts.forEachChild(n, visit);
  };
  visit(tree);
  assert.ok(found, 'dispatch is in CommandCenterPanel');
  const js = ts.transpileModule(`${found.getText(tree)}\n;dispatch`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = { text: 'my only copy of this task', message: null };
  const dispatch = vm.runInNewContext(js, {
    dispatchText: state.text, dispatchTo: '', agents: [], godName: 'G',
    t: (key, vars) => `${key}:${JSON.stringify(vars ?? {})}`,
    setDispatchText: (v) => { state.text = v; },
    setDispatchMsg: (v) => { state.message = v; },
    setTimeout: () => 0, window: { cth: { hiveSend: async () => res } }
  });
  return { dispatch, state };
}

test('a dispatch that fails keeps the typed task and says why', async () => {
  const { dispatch, state } = liveDispatch(FAILED);
  await dispatch();
  assert.equal(state.text, 'my only copy of this task', 'the typed task was thrown away');
  assert.match(state.message, /dispatchFailed.*could not be read/);
});

test('a dispatch that goes out clears the box', async () => {
  const { dispatch, state } = liveDispatch({ ok: true });
  await dispatch();
  assert.equal(state.text, '');
  assert.match(state.message, /sentTo/);
});
