'use strict';

/**
 * A Slack message dispatched to the office is also added to the task board as
 * a card, so its thread can be answered when the card is done. That write can
 * be refused (another writer held tasks.json.lock too long, tasks.json is
 * unreadable), and its answer used to be ignored: the card was never created
 * and nothing anywhere said so. The refusal must reach the task board's notice.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any module that reaches react.
require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { ensureSlackCard } = loadTs('src/renderer/src/hooks/slackTaskCard.ts');
const { useStore } = loadTs('src/renderer/src/store/store.ts');

const BUSY = 'The task list is busy; try again in a moment. (could not lock /h/tasks.json.lock within 250 ms: held by pid 7 on h)';
const message = { id: 'm1', text: 'please rotate the staging keys', slack: { channel: 'C1', thread_ts: '171.5' } };

test.afterEach(() => useStore.setState({ taskWriteError: '' }));

test('a Slack card the ledger refused is reported on the task board', async () => {
  const added = [];
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [] }),
      hiveAddTask: async (card) => { added.push(card); return { ok: false, error: BUSY }; }
    }
  };
  await ensureSlackCard(message);
  assert.equal(added.length, 1);
  const shown = useStore.getState().taskWriteError;
  assert.ok(shown.includes(BUSY), `the main process's reason must reach the board; got: ${JSON.stringify(shown)}`);
  assert.ok(shown.includes('please rotate the staging keys'), 'the notice names the message');
});

test('a Slack card whose write threw is reported too, and the promise still resolves', async () => {
  global.window = {
    cth: {
      hiveTasks: async () => ({ tasks: [] }),
      hiveAddTask: async () => { throw new Error('ipc gone'); }
    }
  };
  await ensureSlackCard(message);
  assert.ok(useStore.getState().taskWriteError.includes('ipc gone'));
});

test('a Slack card that was added reports nothing', async () => {
  global.window = { cth: { hiveTasks: async () => ({ tasks: [] }), hiveAddTask: async () => ({ ok: true }) } };
  await ensureSlackCard(message);
  assert.equal(useStore.getState().taskWriteError, '');
});
