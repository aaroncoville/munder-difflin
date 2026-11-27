'use strict';

/**
 * When the app's own cost rows cannot be written to cost-ledger.jsonl (a linked ledger, a volume without hard links,
 * a lock that never frees), the task board says so on its notice line, with the reason the main process gave, from
 * the moment it opens and as the status changes, and the line goes when the rows are written again. The board
 * listens before it asks for the status, and keeps whichever status is newest by its sequence number, so an answer
 * to its opening question never overwrites a newer event, whichever arrives first.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, text, flatten } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { TasksKanban } = loadTs('src/renderer/src/components/TasksKanban.tsx');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];
test.afterEach(() => { while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.(); });

const REASON = 'ELOOP: too many symbolic links encountered, open \'/h/cost-ledger.jsonl\'';
const NOTICE = /Cost rows are not being written to cost-ledger\.jsonl/;

/** A board whose opening status answer resolves when the test says (`answer(s)`), and whose live events the test
 *  sends (`push(s)`). */
function board() {
  let push = null;
  let answer = null;
  const opening = new Promise((resolve) => { answer = resolve; });
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [] }),
      hiveCostLedgerStatus: () => opening,
      onHiveCostLedgerStatus: (cb) => { push = cb; return () => { push = null; }; },
    }
  };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  return { view, push: (s) => push(s), answer: async (s) => { answer(s); await settle(); await settle(); } };
}

/** The board's text after it has re-rendered with what its effects set. */
const shown = (view) => { view.render(); return text(view.tree).join(''); };

test('a failure already under way when the board opens is shown, with its reason', async () => {
  const b = board();
  await b.answer({ failing: REASON, seq: 1 });
  assert.match(shown(b.view), NOTICE);
  assert.ok(shown(b.view).includes(REASON));
});

test('a failure that starts while the board is open is shown, and the line goes when the rows are written again', async () => {
  const b = board();
  await b.answer({ failing: null, seq: 0 });
  assert.doesNotMatch(shown(b.view), NOTICE);
  b.push({ failing: REASON, seq: 1 });
  assert.match(shown(b.view), NOTICE);
  b.push({ failing: null, seq: 2 });
  assert.doesNotMatch(shown(b.view), NOTICE);
});

test('a failure heard before the opening answer arrives is not erased by that older answer', async () => {
  const b = board();
  b.push({ failing: REASON, seq: 1 });
  await b.answer({ failing: null, seq: 0 });
  assert.match(shown(b.view), NOTICE);
});

test('a recovery heard before the opening answer arrives is not undone by that older answer', async () => {
  const b = board();
  b.push({ failing: null, seq: 2 });
  await b.answer({ failing: REASON, seq: 1 });
  assert.doesNotMatch(shown(b.view), NOTICE);
});

test('an opening answer that arrives first is replaced by a newer event', async () => {
  const b = board();
  await b.answer({ failing: REASON, seq: 1 });
  b.push({ failing: null, seq: 2 });
  assert.doesNotMatch(shown(b.view), NOTICE);
});

test('the notice gives no count of waiting rows, which would go stale as more rows queue', async () => {
  const b = board();
  await b.answer({ failing: REASON, seq: 1 });
  assert.doesNotMatch(shown(b.view), /waiting|\(\d+/);
});

test('the reason is set apart in a <bdi> element, so it keeps its own direction inside a right-to-left sentence', async () => {
  const b = board();
  await b.answer({ failing: REASON, seq: 1 });
  b.view.render();
  const bdi = flatten(b.view.tree).map((e) => e.node).find((n) => n && n.type === 'bdi');
  assert.ok(bdi, 'a bdi element is rendered');
  assert.equal(bdi.props.dir, 'ltr');
  assert.equal(text(bdi).join(''), REASON);
});

test('the board subscribes before it asks: an event sent while the question is on its way is not lost', async () => {
  let push = null;
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [] }),
      // Main answers with the status as it was, and a change happens while that answer is on its way.
      hiveCostLedgerStatus: () => { push?.({ failing: REASON, seq: 1 }); return Promise.resolve({ failing: null, seq: 0 }); },
      onHiveCostLedgerStatus: (cb) => { push = cb; return () => { push = null; }; },
    }
  };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  await settle(); await settle();
  assert.match(shown(view), NOTICE);
});
