'use strict';
/**
 * Where a commission is drawn, and the one rule that decides it.
 *
 * The house has three surfaces that draw a commission, and each is supposed to
 * say one thing by having it: the card table says nobody has picked this up,
 * a reading desk says who is holding it, the shelf wall says it is finished.
 *
 * The felt did not honour that. It carried EVERY open commission, held or not,
 * so a card somebody was working on was drawn twice — a bold spine in the
 * middle of the parlour and a small volume on a desk across the house. The
 * spine is the one that reads at that size, so work in hand looked like work
 * nobody had started, and when it concluded the spine left the felt and a
 * volume appeared on the wall: a commission that went from the table to the
 * archive without ever visibly being at a desk, and without the page-turn that
 * says a desk is where the work is happening.
 *
 * So: assigned goes to the assignee's desk, unassigned stays on the table, and
 * neither surface draws what the other one has.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { onTheTable, stackBaize } = loadTs('src/renderer/src/scene/study/BaizeStacks.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';

const deep = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) deep(k, pred, out); return out; }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) deep(n.props.children, pred, out);
  if (typeof n.type === 'function') {
    let r; try { r = n.type(n.props); } catch { return out; }
    deep(r, pred, out);
  }
  return out;
};
const settle = () => new Promise((r) => setImmediate(r));
const seats = [];
test.after(() => { for (const s of seats) for (const c of s.cleanups ?? []) c?.(); });

const card = (id, status, assignee = '') => ({
  id, status, title: `card ${id}`, assignee, dependsOn: [], humanQA: []
});

async function house(tasks) {
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    cth: { hiveTasks: async () => ({ tasks }), requestQuit: async () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent({
    id: 'ann', name: 'ANN', character: 'jim', accent: 'sky', description: '',
    project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'working', action: '', progress: 0
  });
  useStore.setState({
    requestCommandCenterTab: () => {}, select: () => {}, openTaskDetail: () => {}
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  seats.push(view);
  await settle();
  view.render();
  return view;
}

/** Every commission drawn on the felt, and every volume drawn at Ann's desk. */
const onFelt = (view) =>
  deep(view.tree, (n) => n.props?.['data-baize-book'] !== undefined)
    .map((n) => n.props['data-baize-book']);
const atDesk = (view) => {
  const place = deep(view.tree, (n) => n.props?.['data-study-place'] === 'ann')[0];
  return deep(place, (n) => n.props?.['data-book-state'] !== undefined)
    .map((n) => [n.props.title, n.props['data-book-state']]);
};

const seated = new Set(['ann']);

test('the felt keeps only what nobody has picked up', () => {
  assert.equal(onTheTable(card('T-1', 'doing', 'ann'), seated), false,
    'work in hand is at a desk, not on the table');
  assert.equal(onTheTable(card('T-2', 'todo', 'ann'), seated), false);
  assert.equal(onTheTable(card('T-3', 'blocked', 'ann'), seated), false);
  assert.equal(onTheTable(card('T-4', 'doing'), seated), true,
    'unclaimed work is on the table');
  assert.equal(onTheTable(card('T-5', 'todo', '   '), seated), true,
    'an assignee of blank space is nobody');
});

test('a commission held by somebody this house cannot seat stays on the felt', () => {
  // An assignee is a name on a hand-edited card, not a desk. The name can
  // belong to an assistant who was dismissed, renamed, or never summoned here,
  // and taking such a card off the felt would draw it on no surface at all —
  // which is worse than the double, because a double is at least visible.
  assert.equal(onTheTable(card('T-1', 'doing', 'ghost-of-nobody'), seated), true);
  assert.equal(onTheTable(card('T-1', 'doing', 'ann'), new Set()), true,
    'and a house that has seated nobody yet keeps everything on the felt');
});

test('a concluded commission still holding a question stays on the felt', () => {
  // The wall is bounded and prints no waiting-on-you mark, so a shelved
  // petition is a question that can fall out of the house entirely. Being
  // assigned does not change that: it is finished, so no desk claims it.
  const asked = { ...card('T-1', 'done', 'ann'), humanQA: [{ q: 'which key?' }] };
  assert.equal(onTheTable(asked), true);
  assert.equal(stackBaize([asked], { left: 0, top: 0, width: 100, height: 40 }).length, 1);
});

test('an assigned commission is at its desk and NOT on the card table', async () => {
  const view = await house([card('T-1', 'doing', 'ann')]);
  assert.deepEqual(atDesk(view), [['card T-1', 'open']],
    'it lies open on the desk, so its pages turn and the room says where the work is');
  assert.deepEqual(onFelt(view), [],
    'and it is not also dealt onto the felt — that is the double that hid the desk');
});

test('an assigned commission waiting its turn is a closed book at that desk', async () => {
  const view = await house([card('T-1', 'todo', 'ann')]);
  assert.deepEqual(atDesk(view), [['card T-1', 'closed']]);
  assert.deepEqual(onFelt(view), []);
});

test('a commission nobody holds is on the card table and on no desk', async () => {
  const view = await house([card('T-1', 'doing')]);
  assert.deepEqual(onFelt(view), ['T-1']);
  assert.deepEqual(atDesk(view), []);
});

test('every open commission is drawn exactly once in the house', async () => {
  // The property behind all three cases: the two surfaces divide the ledger
  // rather than sharing it. A card on both is the reported bug; a card on
  // neither is the same bug's mirror image and would be worse.
  const tasks = [
    card('T-1', 'doing', 'ann'), card('T-2', 'blocked', 'ann'),
    card('T-3', 'todo'), card('T-4', 'blocked'),
    card('T-5', 'doing', 'nobody-here')
  ];
  const view = await house(tasks);
  const felt = onFelt(view);
  const desk = atDesk(view).map(([title]) => title.replace('card ', ''));
  for (const t of tasks) {
    const places = [felt.includes(t.id), desk.includes(t.id)].filter(Boolean).length;
    // T-5 is assigned to somebody the house has no seat for; it is on nobody's
    // desk and so stays on the felt, which is the honest place for it.
    assert.equal(places, 1, `${t.id} is drawn on exactly one surface, not ${places}`);
  }
});
