'use strict';
/**
 * A reading desk carries every commission its assistant is holding.
 *
 * The desk used to draw ONE book — the most impeded of an assistant's cards —
 * because a desk that could show one thing had to choose. Everything it did not
 * choose was still visible, on the card table, so choosing lost nothing.
 *
 * Once work in somebody's hands leaves the felt, that stops being true: the
 * cards the desk did not choose would be drawn nowhere in the house at all. So
 * the desk shows them all — the one in hand lying open, the rest stacked behind
 * it on the same desk, the way a reader's other volumes actually sit.
 *
 * Which one lies open changes with it, and for the same reason. Impeded work
 * outranked work in progress while the desk could show one book, because a
 * sealed volume is the thing worth noticing from across the room. Now both are
 * on the desk and the sealed one is seen either way, so the open slot goes to
 * the commission actually being READ — which is the only thing the turning
 * pages can honestly mean.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
// Before any module that calls a React hook is loaded: this is what patches
// them, and a component imported first keeps the real ones.
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { booksFor, deskPile, handHeld, DESK_PILE_MAX } =
  loadTs('src/renderer/src/scene/study/deskPile.ts');
const { projectScene } = loadTs('src/renderer/src/scene/study/useSceneState.ts');

const card = (id, status, over) => ({
  id, title: `card ${id}`, status, assignee: 'ann', humanQA: [], ...over
});

test('a desk holds every open commission its assistant has been given', () => {
  const held = booksFor([
    card('T-1', 'todo'), card('T-2', 'doing'), card('T-3', 'blocked'),
    card('T-4', 'todo', { assignee: 'bob' }), card('T-5', 'todo', { assignee: '' })
  ], 'ann');
  assert.deepEqual(held.map((b) => b.id), ['T-2', 'T-3', 'T-1'],
    "ann's three cards, and nobody else's");
});

test('the book lying open is the one in hand, not the one stuck', () => {
  const held = booksFor([card('T-1', 'blocked'), card('T-2', 'doing')], 'ann');
  assert.equal(held[0].id, 'T-2', 'the commission being worked lies open');
  assert.equal(held[0].state, 'open', 'and it is drawn open, so its pages turn');
  assert.equal(held[1].state, 'sealed', 'the impeded one is stacked behind it, sealed');
});

test('a commission with no work in hand still opens its desk with something', () => {
  const stuck = booksFor([card('T-1', 'todo'), card('T-2', 'blocked')], 'ann');
  assert.equal(stuck[0].id, 'T-2', 'impeded work leads when nothing is in hand');
  assert.equal(stuck[0].state, 'sealed');
  assert.equal(stuck[1].state, 'closed', 'work waiting its turn is a closed book');
});

test('concluded work is not on anybody’s desk — it is on the wall', () => {
  assert.equal(handHeld(card('T-1', 'done')), false);
  assert.deepEqual(booksFor([card('T-1', 'done')], 'ann'), []);
});

test('a commission nobody holds is on no desk', () => {
  assert.equal(handHeld(card('T-1', 'doing', { assignee: '' })), false);
  assert.equal(handHeld(card('T-1', 'doing', { assignee: '   ' })), false,
    'an assignee of blank space is no assignee');
  assert.equal(handHeld(card('T-1', 'doing')), true);
});

test('a commission waiting on the human is held like any other, and marked', () => {
  // An assistant blocked on a question is still the assistant holding that
  // card, so the desk is where the room says so. What must NOT be lost on the
  // way is the mark — the felt prints it at the head of a spine, and a desk
  // book that dropped it would be a sealed volume like any other.
  const asked = card('T-1', 'doing', { humanQA: [{ q: 'which one?' }] });
  assert.equal(handHeld(asked), true);
  assert.equal(booksFor([asked], 'ann')[0].petition, true);
  assert.equal(booksFor([card('T-2', 'doing')], 'ann')[0].petition, undefined,
    'and a commission nobody is waiting on carries no mark');
});

test('a desk piled higher than it can carry stops piling', () => {
  const many = Array.from({ length: 20 }, (_, i) => card(`T-${i}`, 'todo'));
  assert.equal(booksFor(many, 'ann').length, DESK_PILE_MAX + 1,
    'the open slot and the pile behind it, and no more');
});

test('the volumes pile up from the book’s place on the desk', () => {
  const slot = { left: 100, top: 200, width: 40, height: 20 };
  // The size is the card table's, handed in — the slot says only WHERE the pile
  // stands. Handing in a book that is nothing like the slot is the point: a
  // pile that came out slot-shaped anyway would be the squash all over again.
  const spine = { width: 14, height: 3 };
  const pile = deskPile(slot, spine, 3);
  assert.equal(pile.length, 3);
  for (const box of pile) {
    assert.equal(box.width, spine.width, 'the pile was cut to the slot rather than dealt');
    assert.equal(box.height, spine.height);
  }
  // The house is drawn as a flat cross-section, so further UP the panel is
  // further BACK on the desk. With nothing being read, the bottom volume takes
  // the painted book's place and the rest pile up from it.
  const foot = slot.top + slot.height;
  assert.ok(pile[0].top + pile[0].height <= foot + 0.001, 'the first stands where the book is');
  assert.ok(pile[1].top < pile[0].top, 'the next sits on it');
  assert.ok(pile[2].top < pile[1].top);

  // And when a volume IS being read, it keeps that place and the pile starts
  // above it — a reader's other books sit behind the one open in front of them.
  const behind = deskPile(slot, spine, 2, true);
  assert.ok(behind[0].top + behind[0].height <= slot.top + 0.001,
    'the pile clears the open book rather than lying on it');
});

test('the desk pile reaches the scene through the assistant it belongs to', () => {
  const scene = projectScene(
    [{ id: 'ann', name: 'Ann', status: 'working' }],
    [card('T-1', 'doing'), card('T-2', 'todo')]
  );
  assert.deepEqual(scene.agents[0].books.map((b) => [b.id, b.state]),
    [['T-1', 'open'], ['T-2', 'closed']]);
});

/* ---- and the same, drawn: the pile has to reach the panel ------------- */

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { studyRoom } = loadTs(SCENE);

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

/** One assistant at the first reading berth, holding whatever cards are given. */
async function seatOne(tasks) {
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

/**
 * Every volume drawn at one assistant's place setting.
 *
 * Two kinds now, and the difference is the signal: the commission being READ is
 * an open book on the volume the painting drew, and everything else waiting on
 * that desk is a spine beside them — the same object the card table deals.
 */
const openBookAt = (view, agentId) => {
  const place = deep(view.tree, (n) => n.props?.['data-study-place'] === agentId)[0];
  return deep(place, (n) => n.props?.['data-book-state'] !== undefined);
};
const waitingAt = (view, agentId) => {
  const place = deep(view.tree, (n) => n.props?.['data-study-place'] === agentId)[0];
  return deep(place, (n) => n.props?.['data-spine-on'] === 'desk');
};
const volumesAt = (view, agentId) => [...waitingAt(view, agentId), ...openBookAt(view, agentId)];

test('a desk draws all of its assistant’s commissions, not just one', async () => {
  assert.ok(deskBerths(studyRoom).length > 0, 'the house has reading desks to draw on');
  const view = await seatOne([
    card('T-1', 'doing'), card('T-2', 'blocked'), card('T-3', 'todo')
  ].map((c) => ({ ...c, assignee: 'ann' })));
  assert.equal(volumesAt(view, 'ann').length, 3,
    'three cards in hand, three volumes on the desk');
  assert.deepEqual(
    openBookAt(view, 'ann').map((n) => [n.props.title, n.props['data-book-state']]),
    [['card T-1', 'open']], 'only the commission in hand is an open book');
  assert.deepEqual(waitingAt(view, 'ann').map((n) => n.props['data-spine-book']).sort(),
    ['T-2', 'T-3'], 'and the others wait beside the reader as spines');
});

test('every volume on a desk is a door to its own commission', async () => {
  const opened = [];
  const view = await seatOne([
    card('T-1', 'doing'), card('T-2', 'todo')
  ].map((c) => ({ ...c, assignee: 'ann' })));
  useStore.setState({ openTaskDetail: (id) => opened.push(id) });
  view.render();
  const drawn = volumesAt(view, 'ann');
  assert.equal(drawn.length, 2, 'both volumes are on the desk');
  for (const book of drawn) {
    assert.equal(typeof book.props.onClick, 'function', 'the volume can be pressed');
    book.props.onClick({ stopPropagation: () => {} });
  }
  // Each volume opens ITS OWN card. A desk whose books all opened the first
  // commission would look right and be useless, and would pass any check that
  // only counted the presses.
  assert.deepEqual([...opened].sort(), ['T-1', 'T-2']);
});

test('the waiting-on-you mark is drawn on the desk, not merely recorded', async () => {
  const view = await seatOne([{
    ...card('T-1', 'doing'), assignee: 'ann', humanQA: [{ q: 'which api key?' }]
  }]);
  const book = volumesAt(view, 'ann')[0];
  const band = deep(book, (n) => n.props?.['data-book-ribbon'] !== undefined);
  assert.equal(band.length, 1, 'the volume wears a band');
  assert.notEqual(band[0].props['data-book-petition'], undefined,
    'and it is the petition band, not the impeded one');
  // The colour is the felt's own, so the two surfaces cannot drift apart about
  // what a question looks like.
  const { PETITION_EDGE } = loadTs('src/renderer/src/scene/study/BaizeStacks.tsx');
  assert.equal(band[0].props.style.background, PETITION_EDGE);
});

/* ---- the float: the volume the PAINTER drew is the place ---------------- */

const { bookFloat } = loadTs('src/renderer/src/scene/study/deskPile.ts');
const { volumeBox, deskLayout } = loadTs(SCENE);
const { studyRoom: plan } = loadTs(SCENE);

test('a desk book takes the place of the volume the painting drew', () => {
  const painted = { left: 10, top: 20, width: 40, height: 14 };
  const beside = { left: 90, top: 22, width: 30, height: 18 };
  assert.deepEqual(bookFloat(painted, beside), painted,
    'where the painter put a book, that is where the book is');
  assert.deepEqual(bookFloat(null, beside), beside,
    'and where they did not, it lies in the clear desk beside the card');
});

test('the book on a painted desk covers the painted one exactly', async () => {
  // Two things at once. The desk art in these rooms ALREADY has an open book
  // lying on it, so a second book drawn beside it is two books on one desk. And
  // the painted volume is drawn in the room's own perspective — its box is
  // foreshortened, wide and shallow, the way a book on an angled desk is — so
  // a book registered on it is drawn at that angle for free, while one given a
  // box of its own is drawn as if seen from straight above.
  const room = plan.rooms.find((r) => r.kind === 'desk' && r.berths[0]?.volume);
  assert.ok(room, 'some reading room has a painted volume to cover');
  const view = await seatOne([{ ...card('T-1', 'doing'), assignee: 'ann' }]);
  const drawn = volumesAt(view, 'ann');
  assert.equal(drawn.length, 1);
  const laid = drawn[0].props.style;
  // The panel the first berth is drawn in, measured the way the scene measures
  // it — the numbers themselves come from the plan, so this cannot pass by
  // agreeing with the implementation about a coordinate system.
  const berth = room.berths[0];
  assert.ok(laid.width > 0 && laid.height > 0, 'the book has a size');
  // The volume is declared in fractions of its PANEL, and the panel is not
  // square, so the shape on screen is that fraction times the panel's aspect.
  const want = (berth.volume.w / berth.volume.h) * (room.natural.w / room.natural.h);
  assert.ok(Math.abs(laid.width / laid.height - want) < 0.01,
    `the book is the painted volume's shape: wanted ${want}, drew ${laid.width / laid.height}`);
  // And the shape alone is not enough — a box of the right proportions parked
  // somewhere else on the desk would pass that. It has to be in the volume's
  // PLACE, which is what makes it cover the painted book rather than join it.
  const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  assert.equal(deskBerths(plan)[0].id, berth.id, 'ann is seated at this berth');
  const beside = deskLayout(
    { left: laid.left, top: laid.top, width: laid.width, height: laid.height }, null).book;
  assert.notEqual(laid.left, beside.left,
    'it is not the clear-desk box the book used to be given');
});

test('the page lifts off the desk as it turns, rather than spinning flat', () => {
  // A page turning on a book you are looking down at from in front rises
  // towards you as it passes the upright. Rotation alone reads as a page
  // spinning in the plane of the screen, which is what a book seen from
  // directly above would do — and these desks are not seen from above.
  const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
  const open = mount(DeskBook, { state: 'open', box: { left: 0, top: 0, width: 40, height: 14 } });
  const sheets = deep(open.tree, (n) => n.type === 'style')
    .map((n) => String(n.props.children)).join('\n');
  const turn = /@keyframes\s+cth-desk-book-turn\s*\{([^}]*\}[^}]*)*?\}\s*\n/.exec(sheets);
  assert.ok(turn, 'the turn is defined');
  assert.match(turn[0], /translateY\(-/, 'the leaf rises as it goes over');
});

test('a book takes off from the place the desk was drawing it', () => {
  // Two pieces of code work out where a desk book is: the place setting, which
  // draws it, and the flight, which has to know where it was when it left.
  // They are separate functions over the same berth and nothing held them
  // together — so a change to one alone would make books appear out of a patch
  // of desk beside the volume they had been lying on, with every test green.
  const { deskBookInHouse } = loadTs(SCENE);
  const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  for (const berth of deskBerths(plan)) {
    const room = plan.rooms.find((r) => r.berths.some((b) => b.id === berth.id));
    const off = deskBookInHouse({ id: 'ann', berthId: berth.id, stackIndex: 0 });
    assert.ok(off, `${berth.id} has a place to leave from`);
    // Compared as a SHAPE: the sky is the house's frame and the desk is its
    // room's, but both letterbox the same panel, so the painted volume has one
    // shape in either. The clear-desk box the book used to be given does not.
    const want = (berth.volume.w / berth.volume.h) * (room.natural.w / room.natural.h);
    assert.ok(Math.abs(off.box.width / off.box.height - want) < 0.01,
      `${berth.id} takes off as the shape the desk drew: wanted ${want}, `
      + `got ${off.box.width / off.box.height}`);
  }
});
