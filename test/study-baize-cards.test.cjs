'use strict';
/**
 * The commissions dealt onto the card table, and picking one up.
 *
 * The card table already opened the Tasks board when you clicked the ROOM. What
 * it did not do was let you reach one commission: the numbers on the baize were
 * column totals, so the only thing a click could mean was "show me all of it".
 * These are the cards themselves, and clicking one opens that card.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const B = loadTs('src/renderer/src/scene/study/BaizeCards.tsx');
const BAIZE = { left: 100, top: 50, width: 240, height: 90 };
const task = (id, status = 'todo', over = {}) =>
  ({ id, title: `card ${id}`, status, dependsOn: [], priority: 3, ...over });

test('the table is dealt, and never dealt more than it holds', () => {
  const many = Array.from({ length: B.BAIZE_MAX * 3 }, (_, i) => task(`T-${i + 1}`));
  const dealt = B.dealBaize(many, BAIZE);
  assert.equal(dealt.length, B.BAIZE_MAX, 'the baize took an unbounded pile');
  assert.ok(B.BAIZE_MAX > 0 && B.BAIZE_MAX <= 16, 'BAIZE_MAX is not a bound');
});

test('every card lands on the baize, and none on the parlour wall', () => {
  const dealt = B.dealBaize(Array.from({ length: B.BAIZE_MAX }, (_, i) => task(`T-${i}`)), BAIZE);
  for (const { box } of dealt) {
    assert.ok(box.left >= BAIZE.left - 0.01, 'a card slid off the left of the table');
    assert.ok(box.top >= BAIZE.top - 0.01, 'a card slid off the top');
    assert.ok(box.left + box.width <= BAIZE.left + BAIZE.width + 0.01, 'off the right');
    assert.ok(box.top + box.height <= BAIZE.top + BAIZE.height + 0.01, 'off the bottom');
    assert.ok(box.width > 0 && box.height > 0, 'a card with no size');
  }
});

test('what is stuck is dealt first — that is what you cross the room to see', () => {
  const dealt = B.dealBaize(
    [task('T-1', 'done'), task('T-2', 'todo'), task('T-3', 'blocked'), task('T-4', 'doing')],
    BAIZE
  );
  assert.deepEqual(dealt.map((d) => d.task.id), ['T-3', 'T-4', 'T-2', 'T-1']);
});

test('a card is numbered as the board numbers it', () => {
  // The card on the table and the card on the board have to be recognisably
  // the same card, and the number is the only thing small enough to say so.
  const dealt = B.dealBaize([task('T-7'), task('task-19'), task('whoosh')], BAIZE);
  assert.equal(dealt[0].n, 7);
  assert.equal(dealt[1].n, 19);
  // No number in the id at all: fall back to its place on the table rather than
  // printing nothing, so every card still carries a handle.
  assert.equal(dealt[2].n, 3);
});

// ─── In the scene ───────────────────────────────────────────────────────────

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const scenes = [];
test.afterEach(() => { while (scenes.length) for (const s of scenes.pop().cleanups) s?.(); });
const settle = () => new Promise((r) => setImmediate(r));
const person = (id, over = {}) => ({
  id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'idle', action: '', progress: 0, ...over
});

const all = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) all(k, pred, out); return out; }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) all(n.props.children, pred, out);
  if (typeof n.type === 'function') {
    let r; try { r = n.type(n.props); } catch { return out; }
    all(r, pred, out);
  }
  return out;
};

async function inhabit(tasks) {
  const calls = { tabs: [], opened: [] };
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    cth: { hiveTasks: async () => ({ tasks }) }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent(person('w-1'));
  useStore.setState({
    requestCommandCenterTab: (tab) => calls.tabs.push(tab),
    select: () => {},
    openTaskDetail: (id) => calls.opened.push(id)
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  scenes.push(view);
  await settle();
  view.render();
  return { view, calls };
}

const cardsIn = (view) => all(view.tree, (n) => n.props?.['data-baize-card'] !== undefined);

test('the commissions on the ledger are dealt onto the table', async () => {
  const { view } = await inhabit([task('T-1'), task('T-2', 'doing'), task('T-3', 'blocked')]);
  const cards = cardsIn(view);
  assert.equal(cards.length, 3, 'three commissions, three cards');
  for (const c of cards) {
    assert.equal(c.props.role, 'button', 'a card you cannot press is a decoration');
    assert.ok(String(c.props.title).length > 0, 'a card with no title tells you nothing');
  }
  // The number is what ties it to the board.
  assert.deepEqual(cards.map((c) => text(c).join('').trim()).sort(), ['1', '2', '3']);
});

test('picking up a card opens that card, and not the board behind it', async () => {
  const { view, calls } = await inhabit([task('T-1'), task('T-9', 'blocked')]);
  const cards = cardsIn(view);
  const nine = cards.find((c) => text(c).join('').trim() === '9');
  assert.ok(nine, 'the ninth commission is not on the table');

  let roomFired = false;
  nine.props.onClick({ stopPropagation: () => { roomFired = true; } });

  assert.deepEqual(calls.opened, ['T-9'], 'it opened the wrong card, or none');
  // The card sits INSIDE the card-table room, which is itself a button that
  // opens the board. Without stopPropagation a click would do both, and the
  // detail you just opened would be behind the board that opened over it.
  assert.ok(roomFired, 'the click was never stopped from reaching the room');
  assert.deepEqual(calls.tabs, [], 'the room fired as well as the card');
});

test('a card answers Enter and Space, the way the assistants cards do', async () => {
  const { view, calls } = await inhabit([task('T-4')]);
  const card = cardsIn(view)[0];
  const press = (key) => {
    let stopped = false;
    card.props.onKeyDown({
      key, target: 1, currentTarget: 1,
      preventDefault: () => {}, stopPropagation: () => { stopped = true; }
    });
    return stopped;
  };
  assert.ok(press('Enter'), 'Enter did nothing');
  assert.ok(press(' '), 'Space did nothing');
  assert.deepEqual(calls.opened, ['T-4', 'T-4']);
  press('a');
  assert.equal(calls.opened.length, 2, 'any key at all opened the card');
});

test('an empty ledger leaves an empty table, not an empty card', async () => {
  const { view } = await inhabit([]);
  assert.equal(cardsIn(view).length, 0);
});
