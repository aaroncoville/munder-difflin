'use strict';

/**
 * Removing a card from the task board is a write to the task ledger, and that
 * write can be refused (another writer held tasks.json.lock too long,
 * tasks.json is unreadable). The card then comes back on the next read; the
 * board must also say why, with the reason the main process gave.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { TasksKanban } = loadTs('src/renderer/src/components/TasksKanban.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const BUSY = 'The task list is busy; try again in a moment. (could not lock /h/tasks.json.lock within 250 ms: held by pid 7 on h)';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];
test.afterEach(() => {
  while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.();
  useStore.setState({ taskWriteError: '' });
});

const find = (tree, predicate) => flatten(tree).map((e) => e.node).find(predicate);
const card = (tree, id) => find(tree, (n) => n.props && n.props.task && n.props.task.id === id && n.props.onDismiss);
const shown = (tree) => text(tree).join('');

test('a card the ledger would not remove comes back, and the board says why', async () => {
  const deletes = [];
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [{ id: 'K-1', title: 'ship the thing', status: 'todo' }] }),
      hiveDeleteTask: async (id) => { deletes.push(id); return { ok: false, error: BUSY }; }
    }
  };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  await settle();
  view.render();

  await card(view.tree, 'K-1').props.onDismiss();
  await settle();
  view.render();

  assert.deepEqual(deletes, ['K-1']);
  assert.ok(card(view.tree, 'K-1'), 'the card is back on the board');
  assert.ok(shown(view.tree).includes(BUSY), `the main process's reason must be on screen; got:\n${shown(view.tree)}`);
  assert.ok(shown(view.tree).includes('ship the thing'), 'the message names the card');
});

test('a card that was removed leaves no error behind', async () => {
  useStore.setState({ taskWriteError: 'an earlier failure' });
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [{ id: 'K-2', title: 'old card', status: 'todo' }] }),
      hiveDeleteTask: async () => ({ ok: true })
    }
  };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  await settle();
  view.render();

  await card(view.tree, 'K-2').props.onDismiss();
  await settle();
  view.render();

  assert.ok(!shown(view.tree).includes('an earlier failure'));
});

test('a failure line on the board can be closed by the user', async () => {
  // A Slack message that could not be added: no later edit on the board is bound to clear it.
  useStore.setState({ taskWriteError: 'The Slack message "deploy?" was not added to the board' });
  global.window = { cth: { hiveTasks: async () => ({ tasks: [] }) } };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  await settle();
  view.render();
  assert.ok(shown(view.tree).includes('deploy?'));

  const close = find(view.tree, (n) => n.props && n.props['aria-label'] === 'close this message');
  assert.ok(close, 'the line has a close control, found by its label');
  close.props.onClick();
  view.render();
  assert.ok(!shown(view.tree).includes('deploy?'), `the line must be gone; got:\n${shown(view.tree)}`);
  assert.equal(useStore.getState().taskWriteError, '');
});

test('a removal whose call itself fails brings the card back at once', async () => {
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [{ id: 'K-3', title: 'keep me', status: 'todo' }] }),
      hiveDeleteTask: async () => { throw new Error('the window lost its connection to the app'); }
    }
  };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  await settle();
  view.render();

  await card(view.tree, 'K-3').props.onDismiss();
  await settle();
  view.render();
  assert.ok(card(view.tree, 'K-3'), 'the card is back without waiting for the next poll');
  assert.ok(shown(view.tree).includes('lost its connection'));
});
