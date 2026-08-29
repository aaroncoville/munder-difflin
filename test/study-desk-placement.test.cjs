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

const { stackBaize, concluded } = loadTs('src/renderer/src/scene/study/BaizeStacks.tsx');
const { placeOpenWork, DESK_PILE_MAX } = loadTs('src/renderer/src/scene/study/deskPile.ts');
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
/** What the felt is given for one ledger — the other half of the same split. */
const feltFor = (tasks, who = seated) => placeOpenWork(tasks, who).felt.map((t) => t.id);

test('the felt keeps only what nobody has picked up', () => {
  const tasks = [
    card('T-1', 'doing', 'ann'), card('T-2', 'todo', 'ann'), card('T-3', 'blocked', 'ann'),
    card('T-4', 'doing'), card('T-5', 'todo', '   ')
  ];
  assert.deepEqual(feltFor(tasks), ['T-4', 'T-5'],
    'work in hand is at a desk; unclaimed work, and an assignee of blank space, is not');
});

test('a commission held by somebody this house cannot seat stays on the felt', () => {
  // An assignee is a name on a hand-edited card, not a desk. The name can
  // belong to an assistant who was dismissed, renamed, or never summoned here,
  // and taking such a card off the felt would draw it on no surface at all —
  // which is worse than the double, because a double is at least visible.
  assert.deepEqual(feltFor([card('T-1', 'doing', 'ghost-of-nobody')]), ['T-1']);
  assert.deepEqual(feltFor([card('T-1', 'doing', 'ann')], new Set()), ['T-1'],
    'and a house that has seated nobody yet keeps everything on the felt');
});

test('a concluded commission still holding a question stays on the felt', () => {
  // The wall is bounded and prints no waiting-on-you mark, so a shelved
  // petition is a question that can fall out of the house entirely. No desk
  // takes it either — it is finished — so the felt is the only place left, and
  // being held by somebody the house HAS seated must not change that.
  const asked = { ...card('T-1', 'done', 'ann'), humanQA: [{ q: 'which key?' }] };
  assert.equal(concluded(asked), false, 'the wall does not consider it finished');
  assert.deepEqual(feltFor([asked]), ['T-1']);
  assert.equal(stackBaize([asked], { left: 0, top: 0, width: 100, height: 40 }).length, 1,
    'and the felt draws what it is given');
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
  //
  // Read off the RENDERED house, and with enough cards to reach both bounds.
  // A version of this that asked the predicates instead, with two cards and a
  // seated assistant, agreed with itself and missed both ways a card can fall
  // between the surfaces.
  const tasks = [
    // One assistant holding more open work than a desk will draw.
    ...Array.from({ length: DESK_PILE_MAX + 3 }, (_, i) => card(`H-${i}`, 'todo', 'ann')),
    card('T-1', 'doing', 'ann'), card('T-2', 'blocked', 'ann'),
    card('T-3', 'todo'), card('T-4', 'blocked'),
    card('T-5', 'doing', 'nobody-here'),
    // Concluded, but still holding a question — the wall will not take it, and
    // being held by a seated assistant must not make it disappear either.
    { ...card('T-6', 'done', 'ann'), humanQA: [{ q: 'which key?' }] }
  ];
  const view = await house(tasks);
  const felt = onFelt(view);
  const desk = atDesk(view).map(([title]) => title.replace('card ', ''));
  for (const t of tasks) {
    const places = [felt.includes(t.id), desk.includes(t.id)].filter(Boolean).length;
    assert.equal(places, 1, `${t.id} is drawn on exactly one surface, not ${places}`);
  }
  // Named, so a regression reads as itself rather than as an arithmetic slip.
  assert.ok(felt.includes(`H-${DESK_PILE_MAX + 2}`),
    'the open work a desk has no room for goes back onto the felt');
  assert.ok(felt.includes('T-6'),
    'a concluded commission still holding a question stays on the felt, held or not');
  assert.ok(felt.includes('T-5'),
    'work held by somebody the house cannot seat stays on the felt');
});

test('a desk draws no more than it can, and the rest is not lost', () => {
  const held = Array.from({ length: DESK_PILE_MAX + 3 }, (_, i) => card(`H-${i}`, 'todo', 'ann'));
  const { desks, felt } = placeOpenWork(held, new Set(['ann']));
  assert.equal(desks.get('ann').length, DESK_PILE_MAX + 1, 'the desk takes its fill');
  assert.deepEqual(felt.map((t) => t.id), ['H-5', 'H-6'],
    'and the overflow is dealt onto the felt rather than dropped');
});

test('the partition is total over open work, by construction', () => {
  // Not a restatement of the rendered test above: this one is over the FUNCTION
  // that decides, so it can be given shapes the scene cannot easily be put in.
  const seatedSet = new Set(['ann', 'bob']);
  const tasks = [
    ...Array.from({ length: 9 }, (_, i) => card(`A-${i}`, 'todo', 'ann')),
    ...Array.from({ length: 2 }, (_, i) => card(`B-${i}`, 'doing', 'bob')),
    card('U-1', 'todo'), card('U-2', 'blocked', '  '),
    card('G-1', 'doing', 'ghost'),
    { ...card('Q-1', 'done', 'ann'), humanQA: [{ q: 'well?' }] },
    card('D-1', 'done', 'ann'), card('D-2', 'done')
  ];
  const { desks, felt } = placeOpenWork(tasks, seatedSet);
  const drawn = [...felt.map((t) => t.id), ...[...desks.values()].flat().map((b) => b.id)];
  assert.equal(new Set(drawn).size, drawn.length, 'nothing is drawn twice');
  for (const t of tasks) {
    const want = concluded(t) ? 0 : 1;
    assert.equal(drawn.filter((id) => id === t.id).length, want,
      `${t.id} (${t.status}) belongs on ${want} surface below the wall`);
  }
  assert.deepEqual([...desks.keys()].sort(), ['ann', 'bob'],
    'only assistants the house seats are given desks');
});
