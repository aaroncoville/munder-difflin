'use strict';

/**
 * When the app's own cost rows cannot be written to cost-ledger.jsonl (a linked ledger, a volume without hard links,
 * a lock that never frees), the task board says so on its notice line, with the reason the main process gave and how
 * many rows wait, from the moment it opens and as the status changes, and the line goes when the rows are written
 * again.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { TasksKanban } = loadTs('src/renderer/src/components/TasksKanban.tsx');

const settle = () => new Promise((resolve) => setImmediate(resolve));
const mounted = [];
test.afterEach(() => { while (mounted.length) for (const stop of mounted.pop().cleanups) stop?.(); });

const REASON = 'ELOOP: too many symbolic links encountered, open \'/h/cost-ledger.jsonl\'';

function board(initial) {
  let push = null;
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [] }),
      hiveCostLedgerStatus: async () => initial,
      onHiveCostLedgerStatus: (cb) => { push = cb; return () => { push = null; }; },
    }
  };
  const view = mount(TasksKanban, {});
  mounted.push(view);
  return { view, push: (s) => push(s) };
}

/** The board's text after it has re-rendered with what its effects set. */
const shown = (view) => { view.render(); return text(view.tree).join(''); };

test('a failure already under way when the board opens is shown, with its reason and the rows waiting', async () => {
  const b = board({ failing: REASON, queued: 3 });
  await settle(); await settle();
  assert.match(shown(b.view), /Cost rows are not being written to cost-ledger\.jsonl \(3 waiting\)/);
  assert.ok(shown(b.view).includes(REASON));
});

test('a failure that starts while the board is open is shown, and the line goes when the rows are written again', async () => {
  const b = board({ failing: null, queued: 0 });
  await settle(); await settle();
  assert.doesNotMatch(shown(b.view), /Cost rows are not being written/);
  b.push({ failing: REASON, queued: 1 });
  await settle();
  assert.match(shown(b.view), /Cost rows are not being written/);
  b.push({ failing: null, queued: 0 });
  await settle();
  assert.doesNotMatch(shown(b.view), /Cost rows are not being written/);
});
