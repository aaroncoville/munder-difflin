'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const MANIFEST = 'src/renderer/src/scene/study/roomManifest.ts';
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
  // A 2:1 panel contain-fit inside a 1000x1000 box -> view 1000x500 at y=250
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

// ─── The house ──────────────────────────────────────────────────────────────

const { houseRows, deskBerths, deskRooms } = loadTs(MANIFEST);

/**
 * Every node in the tree, descending THROUGH the scene's presentational
 * wrappers rather than stopping at them.
 *
 * render-hooks.cjs mounts one component and does not recurse, so without this
 * the card layer is a wall of opaque elements and every assertion below would
 * pass vacuously on an empty house. The wrappers it expands use no hooks, which
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
const panelOf = (tree, roomId) => one(tree, (n) => n.props?.['data-study-room'] === roomId);

test('the rooms are stacked in reading order, with masonry between the storeys', () => {
  seedDom();
  const { StudyScene, studyRoom } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  scenes.push(inst);

  const rows = houseRows(studyRoom);
  const panels = all(inst.tree, (n) => n.props?.['data-study-room'] !== undefined);
  assert.deepEqual(
    panels.map((p) => p.props['data-study-room']),
    rows.flat().map((r) => r.id),
    'every room is drawn once, top storey first and each storey left to right'
  );

  const bands = all(inst.tree, (n) => n.props?.['data-study-band'] !== undefined);
  assert.equal(bands.length, rows.length - 1, 'one band between each pair of storeys');
  for (const b of bands) {
    assert.equal(b.props.style.height, studyRoom.bandThickness,
      'the band is as thick as the manifest says');
    assert.ok(b.props.style.background, 'the masonry is painted');
  }
});

test('the house scrolls vertically when it is taller than the window', () => {
  seedDom();
  const { StudyScene } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  scenes.push(inst);
  const host = one(inst.tree, (n) => n.props?.['data-study-scene'] !== undefined);
  assert.ok(host, 'the scene host is there');
  assert.equal(host.props.style.overflowY, 'auto', 'the storeys below the fold are reachable');
  assert.equal(host.props.style.overflowX, 'hidden', 'and the house never scrolls sideways');
});

test('each room stacks its panel, its ambiance slot and its cards in that order', () => {
  seedDom();
  const { StudyScene, studyRoom } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  scenes.push(inst);
  for (const room of studyRoom.rooms) {
    const panel = JSON.stringify(panelOf(inst.tree, room.id));
    const iImage = panel.indexOf('data-study-panel');
    const iAmbiance = panel.indexOf('data-study-slot');
    const iCards = panel.indexOf('data-study-layer');
    assert.ok(iImage >= 0, `${room.id} paints a panel`);
    assert.ok(iImage < iAmbiance, `${room.id}: panel below the ambiance slot`);
    assert.ok(iAmbiance < iCards, `${room.id}: ambiance slot below the card layer`);
  }
});

test('every room reserves an ambiance slot, empty and never eating a click', () => {
  seedDom();
  const { StudyScene, studyRoom } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  scenes.push(inst);
  const slots = all(inst.tree, (n) => n.props?.['data-study-slot'] === 'ambiance');
  assert.equal(slots.length, studyRoom.rooms.length, 'one slot per room');
  for (const slot of slots) {
    assert.equal(slot.props.children, undefined, 'nothing mounted in it yet');
    assert.equal(slot.props.style.pointerEvents, 'none', 'input belongs to the DOM layer');
  }
});

test('every panel the manifest names is on disk at the size it declares, and imported', () => {
  const { ROOM_SRC } = loadTs(SCENE);
  for (const room of studyRoom.rooms) {
    const file = path.resolve(ASSETS, room.image);
    assert.ok(fs.existsSync(file), `${room.id}'s panel ${room.image} is on disk`);
    // The scene must render the file the manifest names — an image with no
    // import behind it resolves to nothing and the room paints as a hole.
    assert.ok(ROOM_SRC[room.image], `${room.image} has an import behind it`);
    assert.equal(path.basename(String(ROOM_SRC[room.image])), path.basename(room.image));
    const head = fs.readFileSync(file).subarray(0, 24);
    assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', `${room.image} is a PNG`);
    assert.equal(head.readUInt32BE(16), room.natural.w, `${room.image} width matches natural.w`);
    assert.equal(head.readUInt32BE(20), room.natural.h, `${room.image} height matches natural.h`);
  }
});

// ─── The inhabited Study ────────────────────────────────────────────────────
// Everything above proves the shell. These prove the house is actually wired to
// the store: real agents, real cards, real rooms firing the real navigation.

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');
const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
const { SpeechScroll } = loadTs('src/renderer/src/scene/study/SpeechScroll.tsx');
const { berthToBox, containFit, studyRoom } = loadTs(SCENE);

const settle = () => new Promise((r) => setImmediate(r));

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

/** The view box a room's panel falls back to with no layout to measure. */
const viewOf = (room) => containFit(room.natural, room.natural);

test('every assistant is a card, in the room the manifest gives its berth', async () => {
  const { view } = await inhabit({
    agents: [person('w-1'), person('god-1', { isGod: true }), person('w-2')]
  });
  const cards = all(view.tree, (n) => n.type === AgentCard);
  assert.equal(cards.length, 3, 'three cards for three assistants');
  const byName = Object.fromEntries(cards.map((c) => [c.props.name, c.props]));
  // The god's card is bigger, because his berth is — the layout is the
  // manifest's to decide, never the component's.
  assert.ok(byName['GOD-1'].box.width > byName['W-1'].box.width, "the god's seat is grander");

  // ...and it is positioned against ITS OWN room's panel, not the whole house.
  const firstDeskRoom = deskRooms(studyRoom)[0];
  const deskOne = berthToBox(deskBerths(studyRoom)[0], viewOf(firstDeskRoom));
  assert.ok(byName['W-1'].box.left >= deskOne.left, 'the first worker sits at the first desk');
  assert.ok(byName['W-1'].box.left + byName['W-1'].box.width <= deskOne.left + deskOne.width);

  // The card is a CHILD of that room's panel. A card positioned right but drawn
  // in another room would satisfy every coordinate assertion above.
  const inFirstDesk = all(panelOf(view.tree, firstDeskRoom.id), (n) => n.type === AgentCard);
  assert.deepEqual(inFirstDesk.map((c) => c.props.name), ['W-1'],
    'the first worker is drawn inside the first reading room and nobody else is');
  const study = studyRoom.rooms.find((r) => r.kind === 'godStudy');
  assert.deepEqual(
    all(panelOf(view.tree, study.id), (n) => n.type === AgentCard).map((c) => c.props.name),
    ['GOD-1'], "the god is drawn in the god's study");
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

test('the prop rooms are the buttons, and each fires what the office prop fires', async () => {
  const { view, calls } = await inhabit({ agents: [person('god-1', { isGod: true })] });
  const buttons = Object.fromEntries(
    all(view.tree, (n) => n.props?.role === 'button' && n.props?.title)
      .map((n) => [n.props.title, n.props]));
  for (const [label, kind] of [['Tasks', 'cardTable'], ['Petitions', 'writingDesk'],
    ['Triggers', 'almanac'], ['Closing Time', 'hearth']]) {
    assert.ok(buttons[label], `${label} is a button`);
    assert.equal(buttons[label].tabIndex, 0, `${label} is reachable by keyboard`);
    // Clicking the ROOM is clicking the prop — the button IS the room panel.
    assert.equal(buttons[label]['data-study-kind'], kind, `${label} is the ${kind} room itself`);
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

test('the archive is a room you can read but not press', async () => {
  const { view } = await inhabit({ agents: [person('w-1')] });
  const shelves = one(view.tree, (n) => n.props?.['data-study-kind'] === 'shelves');
  assert.equal(shelves.props.title, 'The Archive', 'it is labelled');
  assert.equal(shelves.props.role, undefined,
    'and offers no control, because pressing it would do nothing yet');
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

/**
 * The band of card `under` that `over`, drawn after it, leaves clear — the part
 * of it a pointer can still reach. `Infinity` when they do not overlap at all.
 */
const exposedBand = (under, over) => {
  const meets = over.left < under.left + under.width && under.left < over.left + over.width
    && over.top < under.top + under.height && under.top < over.top + over.height;
  if (!meets) return Infinity;
  return Math.max(
    over.left - under.left,
    over.top - under.top,
    (under.left + under.width) - (over.left + over.width),
    (under.top + under.height) - (over.top + over.height)
  );
};

/** A pointer target this thin is not a pointer target. */
const GRABBABLE = 6;

test('assistants sharing a desk are dealt out, not stacked out of sight', async () => {
  const crowd = Array.from({ length: deskBerths(studyRoom).length + 3 },
    (_, i) => person(`w-${i}`));
  const { view, calls } = await inhabit({ agents: crowd });
  assert.equal(all(view.tree, (n) => n.type === AgentCard).length, crowd.length,
    'everybody in the house is drawn');

  // Card boxes are normalized to the panel each card is drawn in, so two cards
  // in different rooms share coordinates without sharing a place on screen.
  // Crowding is therefore only ever a question WITHIN one room.
  let crowded = 0;
  for (const room of studyRoom.rooms) {
    const cards = all(panelOf(view.tree, room.id), (n) => n.type === AgentCard);
    if (cards.length > 1) crowded++;
    const boxes = cards.map((c) => c.props.box);
    const spots = new Set(boxes.map((b) => `${b.left},${b.top}`));
    assert.equal(spots.size, boxes.length, `${room.id}: no two cards in the same place`);

    // Distinct is only half of it. Cards later in the layer paint over earlier
    // ones, so a card covered edge to edge cannot be clicked however different
    // its coordinates are.
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        assert.ok(exposedBand(boxes[i], boxes[j]) >= GRABBABLE,
          `${room.id}: ${cards[i].props.name} keeps a grabbable edge clear of `
          + `${cards[j].props.name} (${exposedBand(boxes[i], boxes[j])}px)`);
      }
    }
  }
  assert.ok(crowded > 0, 'a crowd this size really does put two people at one desk');

  // And the card each assistant is drawn on still selects that assistant.
  for (const card of all(view.tree, (n) => n.type === AgentCard)) card.props.onClick();
  assert.deepEqual([...calls.selected].sort(), crowd.map((a) => a.id).sort(),
    'every card in the crowd selects its own assistant');
});

test('a crowded house keeps every card inside the room it is drawn in', async () => {
  // Three times the desks: whatever the seating does with the overflow, a card
  // dealt off the edge of its own panel is clipped away by the panel's
  // `overflow: hidden` — invisible and unclickable, which is the bug the stack
  // offset exists to prevent, one step further along.
  const crowd = Array.from({ length: deskBerths(studyRoom).length * 3 },
    (_, i) => person(`w-${i}`));
  const { view } = await inhabit({ agents: crowd });

  let checked = 0;
  for (const room of studyRoom.rooms) {
    const panel = panelOf(view.tree, room.id);
    const { width, height } = panel.props.style;
    for (const card of all(panel, (n) => n.type === AgentCard)) {
      const box = card.props.box;
      const where = `${card.props.name} in ${room.id}`;
      assert.ok(box.left >= 0 && box.left + box.width <= width + 0.5,
        `${where} stays within the panel across (${box.left}..${box.left + box.width} of ${width})`);
      assert.ok(box.top >= 0 && box.top + box.height <= height + 0.5,
        `${where} stays within the panel down (${box.top}..${box.top + box.height} of ${height})`);
      checked++;
    }
  }
  assert.equal(checked, crowd.length, 'every card in the crowd was checked');
});

test('an empty house is still a house', async () => {
  const { view } = await inhabit({});
  assert.equal(all(view.tree, (n) => n.type === AgentCard).length, 0);
  assert.ok(one(view.tree, (n) => n.props?.title === 'Tasks'), 'the rooms are still there');
  assert.equal(
    all(view.tree, (n) => n.props?.['data-study-room'] !== undefined).length,
    studyRoom.rooms.length, 'an empty house has all its rooms');
});

test('a portrait dropped into the pack lands on the cards', async () => {
  // The pack ships empty, so nothing about an empty house can tell whether the
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
    fs.copyFileSync(path.join(ASSETS, 'room-desk.png'), dropped);
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
    assert.ok(card, 'a card is in the house');
    assert.match(String(card.props.portraitSrc), /test-portrait\.png$/,
      'the card wears the portrait that was just added to the pack');
  } finally {
    fs.rmSync(dropped, { force: true });
    regenerate();
    reload(); // leave the shipped (empty) pack loaded for anything after this
  }
});
