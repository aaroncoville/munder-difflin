'use strict';

/**
 * Moving a card from its detail view is a write to the task ledger, and that
 * write can be refused (another writer held tasks.json.lock too long,
 * tasks.json is unreadable). The card then snaps back to its old column; the
 * detail must also say why, with the reason the main process gave.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, flatten, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { TaskDetailOverlay } = loadTs('src/renderer/src/components/TaskDetailOverlay.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const BUSY = 'The task list is busy; try again in a moment. (could not lock /h/tasks.json.lock within 250 ms: held by pid 7 on h)';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];
test.afterEach(() => {
  while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.();
  useStore.setState({ taskWriteError: '', taskDetailId: null });
});

/** The overlay renders TaskDetail; render that too, so the test reads what is on screen. */
function screen(view) {
  const detail = flatten(view.tree).map((e) => e.node).find((n) => n.props && n.props.onMove);
  assert.ok(detail, 'the detail is open');
  return { detail, words: text(mount(detail.type, detail.props).tree).join('') };
}

test('a move the ledger refused snaps back, and the detail says why', async () => {
  const patches = [];
  // The overlay logs how long it is open; it needs just enough of a page to ask.
  const listens = { addEventListener() {}, removeEventListener() {} };
  global.document = { visibilityState: 'hidden', hasFocus: () => false, ...listens };
  global.window = {
    ...listens,
    cth: {
      hiveTasks: async () => ({ tasks: [{ id: 'D-1', title: 'write the docs', status: 'todo' }] }),
      hivePatchTask: async (id, patch) => { patches.push({ id, patch }); return { ok: false, error: BUSY }; }
    }
  };
  useStore.getState().openTaskDetail('D-1');
  const view = mount(TaskDetailOverlay, {});
  mounted.push(view);
  await settle();
  view.render();

  screen(view).detail.props.onMove('done');
  await settle();
  await settle();
  view.render();

  assert.deepEqual(patches, [{ id: 'D-1', patch: { status: 'done' } }]);
  const { detail, words } = screen(view);
  assert.equal(detail.props.task.status, 'todo', 'the card is back in its column');
  assert.ok(words.includes(BUSY), `the main process's reason must be on screen; got:\n${words}`);
  assert.ok(words.includes('write the docs'), 'the message names the card');
});

/** Opens the detail of card D-1 with a ledger whose patch answers `answer()`. */
async function openDetail(answer) {
  const listens = { addEventListener() {}, removeEventListener() {} };
  global.document = { visibilityState: 'hidden', hasFocus: () => false, ...listens };
  global.window = {
    ...listens,
    cth: {
      hiveTasks: async () => ({ tasks: [{ id: 'D-1', title: 'write the docs', status: 'todo' }] }),
      hivePatchTask: async () => answer()
    }
  };
  useStore.getState().openTaskDetail('D-1');
  const view = mount(TaskDetailOverlay, {});
  mounted.push(view);
  await settle();
  view.render();
  return view;
}

async function moveTo(view, status) {
  screen(view).detail.props.onMove(status);
  await settle();
  await settle();
  view.render();
}

test('a move that goes through after one that was refused clears the line', async () => {
  let answer = { ok: false, error: BUSY };
  const view = await openDetail(() => answer);
  await moveTo(view, 'done');
  assert.ok(screen(view).words.includes(BUSY), 'the first move was refused and said so');
  answer = { ok: true };
  await moveTo(view, 'done');
  const { words } = screen(view);
  assert.ok(!words.includes(BUSY), `the old failure must be gone; got:\n${words}`);
});

test("the detail does not show a failure from the board, and its own failure goes when it closes", async () => {
  // A card the board could not remove: that line belongs to the board, not to this card's detail.
  useStore.getState().setTaskWriteError('Could not remove "another card" from the board');
  const view = await openDetail(() => ({ ok: false, error: BUSY }));
  assert.ok(!screen(view).words.includes('another card'), `a board failure leaked into the detail:\n${screen(view).words}`);

  await moveTo(view, 'done');
  assert.ok(screen(view).words.includes(BUSY));
  useStore.getState().closeTaskDetail();
  view.render();
  useStore.getState().openTaskDetail('D-1');
  view.render();
  // React cleans up and runs the overlay's effects again because the open card changed; this host does so
  // on request.
  for (const stop of view.cleanups.splice(0)) stop?.();
  view.cleanups.push(...view.runEffects());
  await settle();
  view.render();
  assert.ok(!screen(view).words.includes(BUSY), `the line outlived the detail it was shown in:\n${screen(view).words}`);
});

test("the detail's line and the board's are separate: neither shows or replaces the other", async () => {
  const view = await openDetail(() => ({ ok: false, error: BUSY }));
  // The board fails to remove another card while this detail is open.
  const board = 'Could not remove "another card" from the board';
  useStore.getState().setTaskWriteError(board);
  view.render();
  assert.ok(!screen(view).words.includes('another card'), `the board's line showed in the open detail:\n${screen(view).words}`);

  await moveTo(view, 'done');
  assert.ok(screen(view).words.includes(BUSY), 'the detail says its move was not saved');
  assert.equal(useStore.getState().taskWriteError, board, "the detail's failure did not replace the board's line");
});
