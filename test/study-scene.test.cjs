'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');

/** Every scene mounted here — the Study polls the task ledger on an interval,
 *  so a mount left running would keep the test runner alive for ever. */
const scenes = [];
test.afterEach(() => {
  while (scenes.length) for (const stop of scenes.pop().cleanups) stop?.();
});

const seedDom = () => {
  global.window = { localStorage: { getItem: () => 'occult', setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
};

test('berthToBox letterboxes correctly', () => {
  const { berthToBox } = loadTs(SCENE);
  // 2:1 backdrop contain-fit inside a 1000x1000 container -> view 1000x500 at y=250
  const view = { x: 0, y: 250, w: 1000, h: 500 };
  assert.deepEqual(
    berthToBox({ id: 'd', x: 0.5, y: 0.5, w: 0.1, h: 0.2 }, view),
    { left: 500, top: 500, width: 100, height: 100 }
  );
});

test('containFit letterboxes on the constraining axis', () => {
  const { containFit } = loadTs(SCENE);
  // A 2:1 image in a square container is limited by width: full width, centred.
  assert.deepEqual(containFit({ w: 1000, h: 1000 }, { w: 200, h: 100 }),
    { x: 0, y: 250, w: 1000, h: 500 });
  // The same image in a very wide container is limited by height: pillarboxed.
  assert.deepEqual(containFit({ w: 1000, h: 200 }, { w: 200, h: 100 }),
    { x: 300, y: 0, w: 400, h: 200 });
  // A zero-sized container (mounted but not laid out yet) must not divide by zero.
  const degenerate = containFit({ w: 0, h: 0 }, { w: 200, h: 100 });
  for (const v of Object.values(degenerate)) assert.ok(Number.isFinite(v), 'finite view box');
});

test('the scene stacks backdrop, ambiance slot, card layer in order', () => {
  seedDom();
  const { StudyScene } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  scenes.push(inst);
  const layers = JSON.stringify(inst.tree);
  const iBackdrop = layers.indexOf('backdrop');
  const iAmbiance = layers.indexOf('data-study-slot');
  const iCards = layers.indexOf('data-study-layer');
  assert.ok(iBackdrop >= 0, 'backdrop present');
  assert.ok(iBackdrop < iAmbiance, 'backdrop below the ambiance slot');
  assert.ok(iAmbiance < iCards, 'ambiance slot below the card layer');
});

test('the ambiance slot is reserved and empty, and never eats a click', () => {
  seedDom();
  const { StudyScene } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  scenes.push(inst);
  const find = (n) => {
    if (!n || typeof n !== 'object') return undefined;
    if (n.props?.['data-study-slot'] === 'ambiance') return n;
    for (const k of [].concat(n.props?.children ?? [])) { const h = find(k); if (h) return h; }
    return undefined;
  };
  const slot = find(inst.tree);
  assert.ok(slot, 'ambiance slot rendered');
  assert.equal(slot.props.children, undefined, 'nothing mounted in it yet');
  assert.equal(slot.props.style.pointerEvents, 'none', 'input belongs to the DOM layer');
});

test('the shipped backdrop exists and matches what the manifest declares', () => {
  const { loadRoomManifest } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const declared = loadRoomManifest().backdrop;
  const file = path.resolve(ASSETS, declared);
  assert.ok(fs.existsSync(file), `manifest backdrop ${declared} is on disk`);
  // The scene must render the file the manifest names — not some other import
  // that happens to be lying around.
  const { BACKDROP_SRC, BACKDROP_NATURAL } = loadTs(SCENE);
  assert.equal(path.basename(BACKDROP_SRC), path.basename(declared));
  // A real PNG, at the aspect the berth coordinates were authored against.
  const head = fs.readFileSync(file).subarray(0, 24);
  assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', 'PNG signature');
  assert.equal(head.readUInt32BE(16), BACKDROP_NATURAL.w, 'declared width matches the file');
  assert.equal(head.readUInt32BE(20), BACKDROP_NATURAL.h, 'declared height matches the file');
});

// ─── The inhabited Study ────────────────────────────────────────────────────
// Everything above proves the shell. These prove the room is actually wired to
// the store: real agents, real cards, real anchors firing the real navigation.

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');
const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
const { SpeechScroll } = loadTs('src/renderer/src/scene/study/SpeechScroll.tsx');
const { berthToBox, containFit, BACKDROP_NATURAL, studyRoom } = loadTs(SCENE);

const settle = () => new Promise((r) => setImmediate(r));

/**
 * Every node in the tree, descending THROUGH the scene's presentational
 * wrappers rather than stopping at them.
 *
 * render-hooks.cjs mounts one component and does not recurse, so without this
 * the card layer is a wall of opaque elements and every assertion below would
 * pass vacuously on an empty room. The wrappers it expands use no hooks, which
 * is what makes calling them here safe; the original element is kept in the
 * results too, so `n.type === AgentCard` still identifies a card.
 */
const all = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) {
    for (const k of n) all(k, pred, out);
    return out;
  }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) all(n.props.children, pred, out);
  if (typeof n.type === 'function') all(n.type(n.props), pred, out);
  return out;
};
const one = (n, pred) => all(n, pred)[0];

const person = (id, over = {}) => ({
  id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'idle', action: '', progress: 0, ...over
});

/** Seed the world, mount the Study, and let its first ledger poll land. */
async function inhabit({ agents = [], tasks = [], cth = {} } = {}) {
  const calls = { tabs: [], selected: [], closed: 0 };
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => { calls.closed++; },
    cth: { hiveTasks: async () => ({ tasks }), ...cth }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  for (const a of agents) useStore.getState().addAgent(a);
  useStore.setState({
    requestCommandCenterTab: (tab) => calls.tabs.push(tab),
    select: (id) => calls.selected.push(id)
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  scenes.push(view);
  await settle();
  view.render();
  return { view, calls };
}

/** The view box the scene falls back to with no layout to measure. */
const VIEW = containFit(BACKDROP_NATURAL, BACKDROP_NATURAL);

test('every assistant is a card, standing on the berth the manifest gives it', async () => {
  const { view } = await inhabit({
    agents: [person('w-1'), person('god-1', { isGod: true }), person('w-2')]
  });
  const cards = all(view.tree, (n) => n.type === AgentCard);
  assert.equal(cards.length, 3, 'three cards for three assistants');
  const byName = Object.fromEntries(cards.map((c) => [c.props.name, c.props]));
  // The god's card is bigger, because his berth is — the layout is the
  // manifest's to decide, never the component's.
  assert.ok(byName['GOD-1'].box.width > byName['W-1'].box.width, "the god's seat is grander");
  const deskOne = berthToBox(studyRoom.deskBerths[0], VIEW);
  assert.ok(byName['W-1'].box.left >= deskOne.left, 'the first worker sits at the first desk');
  assert.ok(byName['W-1'].box.left + byName['W-1'].box.width <= deskOne.left + deskOne.width);
});

test('work in progress is an open book and a scroll of what is being said', async () => {
  const { view } = await inhabit({
    agents: [person('w-1', { status: 'working', action: 'Reading the seventh folio' }),
      person('w-2', { status: 'blocked' })],
    tasks: [
      { id: 't1', assignee: 'w-1', status: 'doing', title: 'Port the loader', dependsOn: [] },
      { id: 't2', assignee: 'w-2', status: 'blocked', title: 'Which key?', dependsOn: [],
        humanQA: [{ q: 'which api key?' }] }
    ]
  });
  const books = all(view.tree, (n) => n.type === DeskBook);
  assert.equal(books.length, 2);
  assert.equal(books.find((b) => b.props.title === 'Port the loader').props.state, 'open');
  assert.equal(books.find((b) => b.props.title === 'Which key?').props.state, 'sealed');

  const scrolls = all(view.tree, (n) => n.type === SpeechScroll);
  const spoken = scrolls.map((s) => s.props.text).filter(Boolean);
  assert.deepEqual(spoken, ['Reading the seventh folio'],
    'only the assistant with something to say gets a scroll');
});

test('clicking an assistant selects it, the same as clicking its desk on the floor', async () => {
  const { view, calls } = await inhabit({ agents: [person('w-1')] });
  one(view.tree, (n) => n.type === AgentCard).props.onClick();
  assert.deepEqual(calls.selected, ['w-1']);
});

test('the props are buttons, and each fires what the office prop fires', async () => {
  const { view, calls } = await inhabit({ agents: [person('god-1', { isGod: true })] });
  const buttons = Object.fromEntries(
    all(view.tree, (n) => n.props?.role === 'button' && n.props?.title)
      .map((n) => [n.props.title, n.props]));
  for (const label of ['Tasks', 'Petitions', 'Triggers', 'Closing Time']) {
    assert.ok(buttons[label], `${label} is a button`);
    assert.equal(buttons[label].tabIndex, 0, `${label} is reachable by keyboard`);
  }
  buttons['Tasks'].onClick();
  buttons['Triggers'].onClick();
  assert.deepEqual(calls.tabs, ['tasks', 'triggers']);

  buttons['Petitions'].onClick();
  assert.deepEqual(calls.tabs, ['tasks', 'triggers', 'human']);
  assert.deepEqual(calls.selected, ['god-1'],
    'the petitions go to the god, so he is who gets selected');

  assert.equal(calls.closed, 0);
  buttons['Closing Time'].onClick();
  assert.equal(calls.closed, 1, 'the hearth closes the house');
});

test('the writing desk carries the count of letters waiting on the human', async () => {
  const waiting = (n) => ({
    id: `t${n}`, assignee: 'w-1', status: 'blocked', title: `q${n}`, dependsOn: [],
    humanQA: [{ q: `question ${n}` }]
  });
  const quiet = await inhabit({ agents: [person('w-1')] });
  const deskOf = (v) => one(v.tree, (n) => n.props?.title === 'Petitions');
  assert.equal(text(deskOf(quiet.view)).join('').trim(), '',
    'no letters, no badge — an empty desk is the resting state');

  const busy = await inhabit({ agents: [person('w-1')], tasks: [waiting(1), waiting(2)] });
  assert.equal(text(deskOf(busy.view)).join('').trim(), '2', 'two letters, shown as two');
});

test('the card table stacks mirror the kanban columns', async () => {
  const card = (id, status) => ({ id, status, title: id, dependsOn: [] });
  const { view } = await inhabit({
    agents: [person('w-1')],
    tasks: [card('a', 'todo'), card('b', 'todo'), card('c', 'doing'),
      card('d', 'blocked'), card('e', 'done')]
  });
  const table = one(view.tree, (n) => n.props?.title === 'Tasks');
  assert.deepEqual(text(table).map(String), ['2', '1', '1', '1'],
    'todo, doing, blocked, done — in the kanban\'s own order');
});

test('an empty house is still a room', async () => {
  const { view } = await inhabit({});
  assert.equal(all(view.tree, (n) => n.type === AgentCard).length, 0);
  assert.ok(one(view.tree, (n) => n.props?.title === 'Tasks'), 'the props are still there');
});

test('a portrait dropped into the pack lands on the cards', async () => {
  // The pack ships empty, so nothing about an empty room can tell whether the
  // scene consults the portrait mapping at all — and a mapping nobody calls
  // fails silently on the day the art arrives. This drops a real file into the
  // real directory, regenerates the real index, and looks at the cards.
  const { execFileSync } = require('node:child_process');
  const packDir = path.join(ASSETS, 'portraits');
  const dropped = path.join(packDir, 'test-portrait.png');
  const regenerate = () => execFileSync(process.execPath, ['make-portrait-index.cjs'], { cwd: packDir });
  const reload = () => {
    loadTs.fresh('src/renderer/src/scene/study/portraits.index.ts');
    loadTs.fresh('src/renderer/src/scene/study/portraits.ts');
    return loadTs.fresh(SCENE);
  };
  try {
    fs.copyFileSync(path.join(ASSETS, 'backdrop-placeholder.png'), dropped);
    regenerate();
    const { StudyScene: Reloaded } = reload();

    global.window = {
      localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
      cth: { hiveTasks: async () => ({ tasks: [] }) }
    };
    global.document = { documentElement: { dataset: {} } };
    useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
    useStore.getState().addAgent(person('w-1'));
    const view = mount(Reloaded, {});
    scenes.push(view);
    await settle();
    view.render();

    const card = one(view.tree, (n) => n.type === AgentCard);
    assert.ok(card, 'a card is on the floor');
    assert.match(String(card.props.portraitSrc), /test-portrait\.png$/,
      'the card wears the portrait that was just added to the pack');
  } finally {
    fs.rmSync(dropped, { force: true });
    regenerate();
    reload(); // leave the shipped (empty) pack loaded for anything after this
  }
});
