'use strict';

/**
 * An answer or a dismissal on the ASK ME board that the task ledger refused
 * (another writer held it too long, tasks.json is unreadable, the disk failed)
 * must say so on screen with the reason the main process gave, and must leave
 * the human's work where it was: the typed answer and its images stay in the
 * box, a dismissed card comes back. Before, the reason was dropped and the
 * board looked exactly as if nothing had been tried.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { AskMeTab } = loadTs('src/renderer/src/components/AskMeTab.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const BUSY = 'The task list is busy; try again in a moment. (could not lock /h/tasks.json.lock within 250 ms: held by pid 7 on h)';

const task = (id) => ({ id, title: `card ${id}`, status: 'blocked', humanQA: [{ q: 'does it render?' }] });

function fakeBridge({ tasks, patched }) {
  const calls = { patches: [], sends: [] };
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks }),
      hivePatchTask: async (id, patch) => { calls.patches.push({ id, patch }); return patched; },
      hiveSend: async (msg) => { calls.sends.push(msg); return { ok: true }; }
    }
  };
  return calls;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];

async function open() {
  const view = mount(AskMeTab, {});
  mounted.push(view);
  await settle();
  view.render();
  return view;
}

const find = (tree, predicate) => flatten(tree).map((e) => e.node).find(predicate);
const textarea = (tree) => find(tree, (n) => n.type === 'textarea');
const labelled = (tree, label) => find(tree, (n) => n.props && n.props.children === label);
const shown = (tree) => text(tree).join('');

test.afterEach(() => {
  while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.();
  for (const id of ['A-1', 'A-2']) {
    useStore.getState().clearAnswerAttachments(id);
    useStore.getState().setAnswerDraft(id, '');
  }
});

test('an answer the ledger refused says why, keeps the draft and its images, and tells no one', async () => {
  const calls = fakeBridge({ tasks: [task('A-1')], patched: { ok: false, error: BUSY } });
  const view = await open();
  useStore.getState().addAnswerAttachment('A-1', { path: '/hive/asks/attachments/A-1/shot.png', thumb: 'data:image/png;base64,AAAA' });
  textarea(view.tree).props.onChange({ target: { value: 'yes it does' } });
  view.render();

  labelled(view.tree, 'respond & unblock').props.onClick();
  await settle();
  view.render();

  assert.equal(calls.patches.length, 1);
  assert.equal(calls.sends.length, 0, 'an answer that was not saved must not be announced');
  assert.ok(shown(view.tree).includes(BUSY), `the main process's reason must be on screen; got:\n${shown(view.tree)}`);
  assert.ok(shown(view.tree).includes('card A-1'), 'the message names the card');
  assert.equal(useStore.getState().answerDrafts['A-1'], 'yes it does', 'the draft is kept');
  assert.equal(useStore.getState().answerAttachments['A-1'].length, 1, 'the images are kept');
  assert.equal(labelled(view.tree, 'respond & unblock').props.disabled, false, 'the answer can be sent again');
});
