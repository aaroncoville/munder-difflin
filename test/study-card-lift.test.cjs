'use strict';
/**
 * A reader's card stands clear of the page it is turning.
 *
 * The card's foot used to sit exactly on the painted book's top edge, which was
 * right while the book was still: the portrait stood behind the volume and the
 * volume lay open in front of it. Once that volume turns its pages it stops
 * being right, because a page does not stay inside the book's own rectangle —
 * it rises, and everything it rises into is behind the card.
 *
 * So the foot lifts, and how far is the whole question. Two measured facts
 * bound it. The turn is not one low leaf: it fans the full height of the film's
 * rectangle, so a card that cleared ALL of it would stand two book-heights off
 * the desk and stop reading as somebody sitting at one. And no film is drawn at
 * a desk with nobody reading, so every pixel of the lift is bare desk for most
 * of the time the house is looked at. The lift is therefore a share of the
 * film — enough to show the page coming up, not enough to float the portrait.
 *
 * What these hold is that the lift is the FILM's, not the card's: a desk with a
 * page turn gets it and a desk without one does not, and that decision is made
 * by the place setting rather than by whoever calls it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const S = loadTs(SCENE);
const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');
const { BookTurn } = loadTs('src/renderer/src/scene/study/BookTurn.tsx');

const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');
const manifest = JSON.parse(fs.readFileSync(path.join(ASSETS, 'room.json'), 'utf8'));

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
const views = [];
test.after(() => { for (const v of views) for (const c of v.cleanups ?? []) c?.(); });

const card = (id, status) =>
  ({ id, title: `card ${id}`, status, assignee: 'ann', dependsOn: [], humanQA: [] });

/** One assistant, seated by the projection itself — at a reading desk, or the god's. */
async function house(tasks, { isGod = false } = {}) {
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    cth: { hiveTasks: async () => ({ tasks }), requestQuit: async () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent({
    id: 'ann', name: 'ANN', character: 'jim', accent: 'sky', description: '',
    project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'working', action: '', progress: 0,
    ...(isGod ? { isGod: true } : {})
  });
  useStore.setState({
    requestCommandCenterTab: () => {}, select: () => {}, openTaskDetail: () => {}
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  views.push(view);
  await settle();
  view.render();
  return view;
}

const placeOf = (view, agentId) =>
  deep(view.tree, (n) => n.props?.['data-study-place'] === agentId)[0];
const cardBoxAt = (view, agentId) =>
  deep(placeOf(view, agentId), (n) => n.type === AgentCard)[0]?.props?.box;
const filmBoxAt = (view, agentId) =>
  deep(placeOf(view, agentId), (n) => n.type === BookTurn)[0]?.props?.box;
const drawnBooksAt = (view, agentId) =>
  deep(placeOf(view, agentId), (n) => n.props?.['data-book-state'] !== undefined)
    .map((n) => n.props.box ?? n.props.style);

/* ---- through the house: the lift belongs to the film -------------------- */

test('a reader’s card stands clear of the page its book is turning', async () => {
  const view = await house([card('T-1', 'doing')]);
  const seat = cardBoxAt(view, 'ann');
  const film = filmBoxAt(view, 'ann');
  assert.ok(seat && film, 'the first reading desk draws a card and a film');
  // The painted book is where the open volume is drawn — the desk book takes
  // the painting's own volume, so its top edge IS the edge the foot used to
  // stand on.
  const painted = drawnBooksAt(view, 'ann')[0];
  assert.ok(painted, 'the desk draws the volume the painting put on it');
  const gap = painted.top - (seat.top + seat.height);
  assert.ok(gap > 0,
    `the card's foot is still ${(-gap).toFixed(1)}px down on the book it is meant to show`);
  // Expressed against the film, because the film is the only reason for it.
  // Bounded both ways: too little shows no page, too much floats the portrait.
  const share = gap / film.height;
  assert.ok(share >= 0.1 && share <= 0.2,
    `the card is lifted ${(share * 100).toFixed(1)}% of the film's height — outside 10–20%`);
});

test('the god’s desk has no film, so its card is not lifted off anything', async () => {
  // That painter left the desk bare: no painted volume, no clip, nothing for a
  // page to rise out of. The card's foot therefore stands on the desk surface
  // itself — the same surface the drawn book lies on — and a lift applied to
  // every place setting rather than to the ones with films would put the one
  // seat in the house that has nothing to clear up in the air for no reason.
  const view = await house([card('T-1', 'doing')], { isGod: true });
  const seat = cardBoxAt(view, 'ann');
  assert.ok(seat, 'the god is seated');
  assert.equal(filmBoxAt(view, 'ann'), undefined, 'the god’s desk draws no film');
  const book = drawnBooksAt(view, 'ann')[0];
  assert.ok(book, 'the god’s desk draws a book');
  assert.ok(Math.abs((seat.top + seat.height) - (book.top + book.height)) < 0.01,
    `the god’s card foot is ${((book.top + book.height) - (seat.top + seat.height)).toFixed(1)}px `
    + 'off the desk its own book lies on');
});

/* ---- per berth, in the panel's own pixels ------------------------------- */

/** Every reading seat, and the god's, in its panel's own pixels. */
const seats = manifest.rooms
  .filter((room) => room.kind === 'desk' || room.kind === 'godStudy')
  .flatMap((room) => room.berths.map((berth) => ({ room, berth })));
const panelView = (room) => ({ x: 0, y: 0, w: room.natural.w, h: room.natural.h });
const boxOf = ({ room, berth }) => S.berthToBox(berth, panelView(room));

/**
 * How far the film's page fan actually reaches above the painted book's top
 * edge, in panel pixels, measured off the eight shipped clips: the fan crosses
 * the whole remaining height of the film's rectangle, 63–66px depending on the
 * desk. Clearing all of it is what the bound below refuses.
 */
const FAN_REACH = 63;

test('every desk with a film lifts its card, and by the same visible amount', () => {
  const filmed = seats.filter((s) => s.berth.turn);
  assert.equal(filmed.length, 8, `${filmed.length} desks have a film, not 8`);
  for (const seat of filmed) {
    const desk = boxOf(seat);
    const volume = S.volumeBox(seat.berth, panelView(seat.room));
    const film = S.turnBox(seat.berth, panelView(seat.room));
    assert.ok(volume && film, `${seat.berth.id}: no painted book or no film`);
    const { card: seated } = S.deskLayout(desk, volume, film.box);
    const lift = volume.top - (seated.top + seated.height);
    const where = `${seat.room.id}/${seat.berth.id}`;
    // A real gap, in numbers a reader could measure off the painting: more than
    // half the painted book's own height, so the page coming up is seen...
    assert.ok(lift >= volume.height * 0.5,
      `${where}: lifted ${lift.toFixed(1)}px, under half the book's ${volume.height.toFixed(1)}px`);
    // ...and well short of the fan's full reach, which is the lift that would
    // leave the portrait floating.
    assert.ok(lift <= FAN_REACH * 0.5,
      `${where}: lifted ${lift.toFixed(1)}px of a ${FAN_REACH}px fan — the card is off its desk`);
    // The lift is a translate. Shortening the card instead would clear the same
    // page and shrink every filmed portrait in the house against every other.
    const bare = S.deskLayout(desk, volume).card;
    assert.ok(Math.abs(seated.height - bare.height) < 0.01,
      `${where}: clearing the film cost the card ${(bare.height - seated.height).toFixed(1)}px of height`);
    assert.ok(Math.abs(seated.width - bare.width) < 0.01, `${where}: the lift changed the card's width`);
    // And it does not take the portrait out of its own painting.
    assert.ok(seated.top >= 0, `${where}: the lifted card is off the top of the room`);
    assert.ok(seated.top + seated.height <= seat.room.natural.h + 0.01,
      `${where}: the lifted card is through the floor`);
  }
});

test('a painted book with no film to show leaves the card where it was', () => {
  // The manifest allows a berth to declare a volume and no clip, and a desk
  // like that has nothing rising off it. The foot belongs on the book's edge
  // there, exactly as before.
  const seat = seats.find((s) => s.berth.volume);
  const desk = boxOf(seat);
  const volume = S.volumeBox(seat.berth, panelView(seat.room));
  const { card: seated } = S.deskLayout(desk, volume, null);
  assert.ok(Math.abs((seated.top + seated.height) - volume.top) < 0.01,
    'a desk with no film lifted its card anyway');
});

test('a card sharing a filmed desk is lifted with it, however deep it sits', () => {
  // Everybody at one desk meets the same page turn, and the pile's stagger is
  // what says they are sharing — so the lift has to be the same for all of
  // them, and none of them may be dealt out of the room by it.
  for (const seat of seats.filter((s) => s.berth.turn)) {
    const volume = S.volumeBox(seat.berth, panelView(seat.room));
    const film = S.turnBox(seat.berth, panelView(seat.room)).box;
    const first = S.deskLayout(boxOf(seat), volume, film).card;
    const base = volume.top - (first.top + first.height);
    for (let depth = 0; depth <= S.STACK_DEEPEST; depth++) {
      const { card: seated } = S.deskLayout(
        S.stackedBerth(boxOf(seat), depth), volume, film);
      const where = `${seat.room.id}/${seat.berth.id}#${depth}`;
      assert.ok(Math.abs((volume.top - (seated.top + seated.height)) - base) < 0.01,
        `${where}: dealt back changed the lift`);
      assert.ok(seated.top >= 0, `${where}: the lifted card is off the top of the room`);
    }
  }
});
