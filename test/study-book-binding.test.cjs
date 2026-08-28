'use strict';
/**
 * A book is bound for the room it lies in.
 *
 * The desk book was drawn once, in gilt on cream, and it was drawn for the two
 * reading rooms on the left of the house: both are warm dark wood, and a gilt
 * volume on a wooden desk is a volume on a desk. The two rooms on the right are
 * not those rooms. One is grey stone under gothic glass, where a gilt board is
 * one more warm smudge among the mullions; the other is dusty rose plaster,
 * where a gilt board is very nearly the wall.
 *
 * So the binding is a property of the ROOM, declared in the floor plan beside
 * everything else the panel decides, rather than a property of the component.
 * A repainted panel changes its binding in the same file it changes its berths
 * in, and no component has to learn a room's name.
 *
 * Three bindings, not four: the two left-hand rooms share the one that was
 * drawn for them.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { DeskBook, BOOK_BINDINGS } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
const { validateRoomManifest } = loadTs('src/renderer/src/scene/study/roomManifest.ts');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const rawManifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

const box = { left: 0, top: 0, width: 40, height: 30 };
const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};

test('every binding is a different book, not the same book renamed', () => {
  const names = Object.keys(BOOK_BINDINGS);
  assert.ok(names.length >= 3, 'the default and the two rooms that needed their own');
  const drawn = new Map();
  for (const binding of names) {
    // The open state, because that is the one a working desk shows and the one
    // with the most surface to tell apart.
    const tree = mount(DeskBook, { state: 'open', box, binding }).tree;
    const shape = JSON.stringify(tree).split(`"data-book-binding":"${binding}"`).join('');
    for (const [other, was] of drawn) {
      assert.notEqual(shape, was, `${binding} is drawn differently from ${other}`);
    }
    drawn.set(binding, shape);
  }
});

test('a binding names no colour of its own — every one is a theme token', () => {
  for (const binding of Object.keys(BOOK_BINDINGS)) {
    for (const state of ['closed', 'open', 'sealed']) {
      const tree = mount(DeskBook, { state, box, binding }).tree;
      const literal = JSON.stringify(tree)
        .match(/"(background|color|boxShadow|borderColor)":"(?!var\()[^"]*"/);
      assert.equal(literal, null,
        `${binding}/${state}: colour outside the token system: ${literal && literal[0]}`);
    }
  }
});

test('a book of no named binding is the one the left-hand rooms were drawn for', () => {
  const plain = mount(DeskBook, { state: 'open', box }).tree;
  const named = mount(DeskBook, { state: 'open', box, binding: 'ledger' }).tree;
  assert.equal(JSON.stringify(plain), JSON.stringify(named),
    'the default IS a binding, so nothing is drawn by a second set of rules');
});

test('the book says which binding it wears, so a room can be checked from outside', () => {
  const el = find(mount(DeskBook, { state: 'open', box, binding: 'attic' }).tree,
    (n) => n.props?.['data-book-state'] !== undefined);
  assert.equal(el.props['data-book-binding'], 'attic');
});

// ─── The floor plan decides ─────────────────────────────────────────────────

test('the two right-hand reading rooms each carry a binding of their own', () => {
  const desks = rawManifest.rooms.filter((r) => r.kind === 'desk');
  const right = desks.filter((r) => (r.col ?? 0) > 0);
  const left = desks.filter((r) => (r.col ?? 0) === 0);
  assert.ok(right.length === 2 && left.length === 2, 'two reading rooms a side');

  const theirs = right.map((r) => r.binding);
  for (const b of theirs) {
    assert.ok(b && BOOK_BINDINGS[b], `a right-hand room names a binding that exists: ${b}`);
  }
  assert.equal(new Set(theirs).size, 2, 'and the two of them are not the same one');
  for (const room of left) {
    assert.equal(room.binding, undefined,
      `${room.id} keeps the binding the desk book was drawn for`);
  }
});

test('a room that names a binding nobody has drawn fails at load, loudly', () => {
  const bent = JSON.parse(JSON.stringify(rawManifest));
  const room = bent.rooms.find((r) => r.kind === 'desk');
  room.binding = 'vellum';
  assert.throws(() => validateRoomManifest(bent), /binding/,
    'a misspelt binding must not quietly become the default');
});

test('a floor plan that names no binding at all still loads', () => {
  const bare = JSON.parse(JSON.stringify(rawManifest));
  for (const room of bare.rooms) delete room.binding;
  const loaded = validateRoomManifest(bare);
  for (const room of loaded.rooms) assert.equal(room.binding, undefined);
});

test('the shipped floor plan is one the loader accepts', () => {
  const loaded = validateRoomManifest(rawManifest);
  const byId = Object.fromEntries(loaded.rooms.map((r) => [r.id, r]));
  for (const room of rawManifest.rooms) {
    assert.equal(byId[room.id].binding, room.binding,
      `${room.id} keeps the binding the file gives it`);
  }
});

// ─── The house handing it down ──────────────────────────────────────────────
// The binding is in the floor plan and the look is in the component. What ties
// them is the scene reading one and handing it to the other — which is exactly
// the wire that a test of either half alone stays green without.

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { studyRoom } = loadTs(SCENE);
const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');

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
const person = (id, over = {}) => ({
  id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'working', action: '', progress: 0, ...over
});
const card = (id, status, assignee) => ({
  id, status, title: `card ${id}`, assignee, dependsOn: []
});

const seats = [];
test.after(() => { for (const s of seats) for (const c of s.cleanups ?? []) c?.(); });

/** One assistant per reading berth, each holding a card of their own — so the
 *  house draws a book in every room that has one. */
async function fillTheHouse(status = 'doing') {
  const berths = deskBerths(studyRoom);
  const agents = berths.map((_, i) => person(`w-${i}`));
  const tasks = agents.map((a, i) => card(`T-${i}`, status, a.id));
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    cth: { hiveTasks: async () => ({ tasks }), requestQuit: async () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  for (const a of agents) useStore.getState().addAgent(a);
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

/** The binding of every book drawn inside one room's panel. */
const bindingsIn = (view, roomId) => {
  const panel = deep(view.tree, (n) => n.props?.['data-study-room'] === roomId)[0];
  return deep(panel, (n) => n.props?.['data-book-binding'] !== undefined)
    .map((n) => n.props['data-book-binding']);
};

test('a book is bound the way the room it lies in says', async () => {
  const view = await fillTheHouse();
  for (const room of studyRoom.rooms.filter((r) => r.kind === 'desk')) {
    const worn = bindingsIn(view, room.id);
    assert.ok(worn.length > 0, `${room.id} draws at least one book`);
    for (const b of worn) {
      assert.equal(b, room.binding ?? 'ledger',
        `${room.id} binds its volumes as its floor plan says`);
    }
  }
  // And the house really does show more than one binding, so the loop above is
  // not passing because every room happens to want the same book.
  const shown = new Set(studyRoom.rooms
    .filter((r) => r.kind === 'desk')
    .flatMap((r) => bindingsIn(view, r.id)));
  assert.ok(shown.size >= 3, `three bindings on the floor, saw ${[...shown].join(', ')}`);
});
