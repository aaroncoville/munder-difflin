'use strict';
/**
 * A commission leaving a desk is shown leaving it.
 *
 * The house already draws a commission on every surface it belongs to — a book
 * at the desk working it, a spine on the felt, a darkened volume on the wall
 * when it is done. What it never showed was the MOVE. A card changed status and
 * three surfaces silently redrew, so the one moment worth noticing in a room
 * full of steady state went by with nothing to see.
 *
 * Two moves are worth drawing and only two: work that becomes impeded goes back
 * to the table, and work that concludes goes to the shelf. Everything else is a
 * commission staying where it is.
 *
 * The launch rule is the delicate part, and it is delicate in one direction:
 * the FIRST sighting of the ledger must launch nothing. A house that has just
 * been opened has no idea which cards were blocked a minute ago and which were
 * blocked last month, so treating every card it finds as a card that just
 * changed empties every desk into the air at once, every time the Study is
 * opened. Nothing flies until the house has seen the card in an earlier state
 * with its own eyes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  flightsFor, houseSlot, seenStatuses
} = loadTs('src/renderer/src/scene/study/flight.ts');

const card = (id, status, over = {}) => ({
  id, status, title: `card ${id}`, assignee: 'w-1', dependsOn: [], ...over
});

test('the first sighting of the ledger launches nothing', () => {
  const now = [card('T-1', 'blocked'), card('T-2', 'done'), card('T-3', 'doing')];
  assert.deepEqual(flightsFor(null, now), [],
    'an opened house does not empty every desk into the air');
});

test('work that becomes impeded flies to the table, from whatever it was', () => {
  for (const was of ['todo', 'doing']) {
    const flights = flightsFor(seenStatuses([card('T-1', was)]), [card('T-1', 'blocked')]);
    assert.deepEqual(flights.map((f) => [f.taskId, f.to, f.agentId]), [['T-1', 'table', 'w-1']],
      `${was} → blocked flies to the table`);
  }
});

test('work that concludes flies to the shelf, from whatever it was', () => {
  for (const was of ['todo', 'doing', 'blocked']) {
    const flights = flightsFor(seenStatuses([card('T-1', was)]), [card('T-1', 'done')]);
    assert.deepEqual(flights.map((f) => [f.taskId, f.to]), [['T-1', 'shelf']],
      `${was} → done flies to the shelf`);
  }
});

test('a commission that has not moved does not fly', () => {
  for (const status of ['todo', 'doing', 'blocked', 'done']) {
    const same = [card('T-1', status)];
    assert.deepEqual(flightsFor(seenStatuses(same), same), [], `${status} stays put`);
  }
  // Nor does a move between two states that are both still open work.
  assert.deepEqual(flightsFor(seenStatuses([card('T-1', 'todo')]), [card('T-1', 'doing')]), []);
});

test('a commission nobody is holding has no desk to fly from', () => {
  const flights = flightsFor(
    seenStatuses([card('T-1', 'doing', { assignee: '' })]),
    [card('T-1', 'done', { assignee: '' })]);
  assert.deepEqual(flights, []);
});

test('a commission that appears already finished did not fly there', () => {
  // Raised and concluded between two polls, or simply added to the file in its
  // final state. The house never saw it on a desk, so nothing leaves one.
  assert.deepEqual(flightsFor(seenStatuses([card('T-1', 'doing')]), [
    card('T-1', 'doing'), card('T-9', 'done')
  ]), []);
});

test('each flight carries what it needs to be drawn and to be told apart', () => {
  const [flight] = flightsFor(seenStatuses([card('T-1', 'doing')]), [card('T-1', 'done')]);
  assert.equal(flight.taskId, 'T-1');
  assert.equal(flight.agentId, 'w-1');
  assert.equal(flight.title, 'card T-1');
  assert.ok(flight.id && flight.id !== flight.taskId,
    'a flight has its own key — the same commission can fly twice');
});

test('the same commission making the same move twice gets two different keys', () => {
  // The key is what the sky is a list OF. Deriving it from the commission and
  // the move it made means a card that is blocked, freed, and blocked again
  // launches a second flight wearing the first one's name — and then landing
  // either one takes both out of the air, because the list is filtered by that
  // name. Nothing about the id may be a function of the move alone.
  const seen = seenStatuses([card('T-1', 'doing')]);
  const [first] = flightsFor(seen, [card('T-1', 'blocked')]);
  const [second] = flightsFor(seen, [card('T-1', 'blocked')]);
  assert.notEqual(first.id, second.id,
    'two launches of one move are two books, not one book counted twice');
});

// ─── Where the rooms actually are ───────────────────────────────────────────
// A book flying from a desk in one room to the table in another crosses two
// panels, so for the first time in this scene something has to know where a
// room's panel lands inside the whole building. The house is laid out by flex
// and never computed one, which is why this arithmetic exists.

const storeys = [
  { height: 100, rooms: [{ id: 'a', width: 200 }, { id: 'b', width: 300 }] },
  { height: 50, rooms: [{ id: 'c', width: 400 }] }
];
const BAND = 10;
const INNER = 510; // 200 + 10 + 300

test('a room sits where the house draws it: after the wall, inside the padding', () => {
  const a = houseSlot(storeys, BAND, INNER, 'a');
  const b = houseSlot(storeys, BAND, INNER, 'b');
  assert.deepEqual(a, { x: BAND, y: BAND, w: 200, h: 100 });
  assert.equal(b.x, a.x + a.w + BAND, 'exactly one wall between two rooms');
  assert.equal(b.y, a.y, 'and both stand on the same storey');
});

test('a storey below is dropped by its neighbours and one band of masonry', () => {
  const c = houseSlot(storeys, BAND, INNER, 'c');
  assert.equal(c.y, BAND + 100 + BAND, 'below the first storey and its band');
  assert.equal(c.h, 50);
  // A storey narrower than the house is CENTRED, which is what the layout does.
  assert.equal(c.x, BAND + (INNER - 400) / 2);
});

test('a room the house does not hold has no slot', () => {
  assert.equal(houseSlot(storeys, BAND, INNER, 'nowhere'), null);
});

// ─── A machine that asked for stillness ─────────────────────────────────────

test('nothing flies on a machine that asked for less movement', () => {
  const moved = [card('T-1', 'done')];
  const seen = seenStatuses([card('T-1', 'doing')]);
  assert.equal(flightsFor(seen, moved).length, 1, 'it would otherwise fly');
  assert.deepEqual(flightsFor(seen, moved, true), [],
    'prefers-reduced-motion is taken literally, not damped');
});

// ─── The book in the air ────────────────────────────────────────────────────

const { mount } = require('./render-hooks.cjs');
const { FlyingBooks } = loadTs('src/renderer/src/scene/study/FlyingBooks.tsx');

const nodes = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) nodes(k, pred, out); return out; }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) nodes(n.props.children, pred, out);
  return out;
};
const flying = (inst) => nodes(inst.tree, (n) => n.props?.['data-book-flight'] !== undefined);

const path = (over = {}) => ({
  flight: { id: 'f1', taskId: 'T-1', agentId: 'w-1', title: 'Port the loader', to: 'shelf' },
  from: { left: 100, top: 200, width: 40, height: 30 },
  land: { left: 500, top: 20, width: 10, height: 20 },
  ...over
});

test('a book in the air is drawn at where it lands, offset back to where it left', () => {
  const inst = mount(FlyingBooks, { paths: [path()] });
  const [book] = flying(inst);
  assert.ok(book, 'one book, one flight');
  assert.equal(book.props['data-book-flight'], 'f1');
  assert.equal(book.props['data-flight-to'], 'shelf');
  // Drawn at the LANDING box, because that is the size and place it has to end
  // at exactly — a flight that ends a pixel off its berth is a flight that
  // jumps at the last frame.
  assert.equal(book.props.style.left, 500);
  assert.equal(book.props.style.top, 20);
  assert.equal(book.props.style.width, 10);
  assert.equal(book.props.style.height, 20);
  // ...and displaced back to the desk it left, as the animation's starting pose.
  const vars = book.props.style;
  assert.equal(vars['--cth-fly-x'], '-400px', 'left 100 is 400px back from left 500');
  assert.equal(vars['--cth-fly-y'], '180px', 'top 200 is 180px below top 20');
  assert.equal(vars['--cth-fly-w'], 4, '40 wide shrinking onto a 10-wide berth');
  assert.equal(vars['--cth-fly-h'], 1.5);
});

test('every keyframe the flight names is one the layer itself defines', () => {
  const inst = mount(FlyingBooks, { paths: [path()] });
  const sheet = nodes(inst.tree, (n) => n.type === 'style')
    .map((n) => String(n.props.children)).join('\n');
  const named = nodes(inst.tree, (n) => typeof n.props?.style?.animation === 'string')
    .map((n) => String(n.props.style.animation).trim().split(/\s+/)[0]);
  assert.ok(named.length, 'something is animated');
  for (const name of named) {
    assert.match(sheet, new RegExp(`@keyframes\\s+${name}\\s*\\{`), `${name} is defined`);
  }
});

test('a book in the air is scenery — it catches no click meant for the room', () => {
  const inst = mount(FlyingBooks, { paths: [path()] });
  // Through the nested components too, which is where the book itself is: the
  // desk book takes the pointer back on purpose so its tooltip works, and the
  // one in the air is the case that must NOT.
  const through = (n, out = []) => {
    if (!n || typeof n !== 'object') return out;
    if (Array.isArray(n)) { for (const k of n) through(k, out); return out; }
    if (n.props?.style?.pointerEvents !== undefined) out.push(n);
    if (n.props?.children !== undefined) through(n.props.children, out);
    if (typeof n.type === 'function') {
      let r; try { r = n.type(n.props); } catch { return out; }
      through(r, out);
    }
    return out;
  };
  const layers = through(inst.tree);
  assert.ok(layers.length >= 3, 'the layer, the carry, and the book itself');
  for (const n of layers) assert.equal(n.props.style.pointerEvents, 'none');
  const layer = nodes(inst.tree, (n) => n.props?.['data-study-flights'] !== undefined)[0];
  assert.ok(layer, 'the flights have a layer of their own');
  assert.equal(layer.props.style.pointerEvents, 'none');
});

test('a book that has landed says so, so it can be taken out of the air', () => {
  const landed = [];
  const inst = mount(FlyingBooks, { paths: [path()], onLanded: (id) => landed.push(id) });
  const [book] = flying(inst);
  book.props.onAnimationEnd({
    target: book, currentTarget: book, animationName: 'cth-book-fly-across'
  });
  assert.deepEqual(landed, ['f1']);
});

test('the fall finishing is not the flight finishing, however it arrives', () => {
  // The arc is two animations on two nested elements, and `animationend`
  // BUBBLES: the inner fall's event reaches the carry's own handler. Both
  // tracks currently run for the same duration, so which of the two events the
  // handler sees first is a race — and taking the book out of the air on the
  // inner one cuts the outer fade off mid-landing.
  const landed = [];
  const inst = mount(FlyingBooks, { paths: [path()], onLanded: (id) => landed.push(id) });
  const [book] = flying(inst);
  const carry = nodes(book, (n) => n.props?.['data-flight-carry'] !== undefined)[0];
  assert.ok(carry, 'the fall is a track of its own, on a child of the carry');
  book.props.onAnimationEnd({
    target: carry, currentTarget: book, animationName: 'cth-book-fly-down'
  });
  assert.deepEqual(landed, [], 'the fall bubbling up does not end the flight');
  // Nor does anything else that happens to end on an element underneath.
  book.props.onAnimationEnd({
    target: carry, currentTarget: book, animationName: 'cth-book-fly-across'
  });
  assert.deepEqual(landed, [], 'nor does a namesake ending on a child');
  book.props.onAnimationEnd({
    target: book, currentTarget: book, animationName: 'cth-book-fly-across'
  });
  assert.deepEqual(landed, ['f1'], 'the carry itself finishing is the landing');
});

test('an empty sky draws nothing at all', () => {
  const inst = mount(FlyingBooks, { paths: [] });
  assert.equal(inst.tree, null);
});

// ─── The house actually launching one ───────────────────────────────────────
// Everything above is arithmetic. This is the part that cannot be proved by
// arithmetic: that the house WATCHES the ledger, notices the move on the poll
// after it happens, and puts the book in the air over the right two rooms.

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { SKY_MAX, studyRoom, HOUSE_NATURAL_WIDTH, HOUSE_NATURAL_HEIGHT } = loadTs(SCENE);

const settle = () => new Promise((r) => setImmediate(r));
const person = (id, over = {}) => ({
  id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'working', action: '', progress: 0, ...over
});

/**
 * Mount the Study and walk it through a series of ledgers, one poll each.
 *
 * The house compares each poll against the one before it, so a flight needs at
 * least two — which is itself one of the properties under test: the first
 * ledger it ever sees launches nothing.
 *
 * Every round tears the previous round's effects down before running the next.
 * This host re-runs every effect on demand and ignores deps, so a round that
 * skipped the teardown would leave the ledger's poll timer behind and stack one
 * more on each turn.
 */
async function watchLedger(agents, ledgers, { reducedMotion = false, stillness } = {}) {
  let poll = 0;
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    // `stillness` is the same preference, read at ASK time rather than fixed at
    // mount, so a case can turn it on and off under a house that is already
    // running — which is what the real media query does.
    matchMedia: (query) => ({
      matches: (stillness ? stillness.reduced : reducedMotion)
        && /prefers-reduced-motion/.test(query),
      addEventListener: () => {},
      removeEventListener: () => {}
    }),
    cth: {
      hiveTasks: async () => ({ tasks: ledgers[Math.min(poll++, ledgers.length - 1)] }),
      requestQuit: async () => {}
    }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  for (const a of agents) useStore.getState().addAgent(a);
  useStore.setState({
    requestCommandCenterTab: () => {}, select: () => {}, openTaskDetail: () => {}
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  let cleanups = view.cleanups;
  for (let i = 0; i < ledgers.length; i++) {
    await settle();
    view.render();
    for (const c of cleanups) c?.();
    cleanups = view.runEffects();
  }
  view.render();
  for (const c of cleanups) c?.();
  return view;
}

/** Through the nested components as well — the sky is a component of its own,
 *  and a walker that only follows `children` never reaches inside it. */
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

const inTheAir = (view) =>
  deep(view.tree, (n) => n.props?.['data-book-flight'] !== undefined);

test('the house puts nothing in the air over the ledger it opens on', async () => {
  const view = await watchLedger([person('w-1')], [[card('T-1', 'blocked')]]);
  assert.deepEqual(inTheAir(view), []);
});

test('a commission that concludes between two polls flies to the shelf', async () => {
  const view = await watchLedger([person('w-1')], [
    [card('T-1', 'doing')],
    [card('T-1', 'done', { updatedAt: new Date().toISOString() })]
  ]);
  const air = inTheAir(view);
  assert.equal(air.length, 1, 'one book left one desk');
  assert.equal(air[0].props['data-flight-to'], 'shelf');
  const style = air[0].props.style;
  assert.ok(style.width > 0 && style.height > 0, 'it lands on something with a size');
  // The shelf wall is the top storey and every desk is below it, so the book
  // travels UP the building — which the starting offset is what says. A flight
  // computed against one room's panel instead of the whole house could not
  // produce a displacement of a storey's worth.
  assert.match(String(style['--cth-fly-y']), /^\d/, 'it starts below where it lands');
  assert.ok(parseFloat(style['--cth-fly-y']) > style.height,
    'and by more than the height of the volume it lands on');
});

test('the sky covers the whole building, walls included', async () => {
  // An absolutely positioned child is placed against its parent's PADDING box,
  // and the house is padded by a band of masonry — so a sky at `inset: 0`
  // would start one wall in, and every flight in it would land one band short
  // of the room it was aimed at. Nothing about a book landing 18px high looks
  // like a coordinate-space bug, which is why it is asserted rather than
  // eyeballed.
  const view = await watchLedger([person('w-1')], [[card('T-1', 'doing')]]);
  const sky = deep(view.tree, (n) => n.props?.['data-study-sky'] !== undefined)[0];
  assert.ok(sky, 'the house has a sky');
  const band = studyRoom.bandThickness;
  assert.ok(band > 0, 'the house has walls to be inset by');
  assert.equal(sky.props.style.left, -band);
  assert.equal(sky.props.style.top, -band);
  assert.equal(sky.props.style.width, HOUSE_NATURAL_WIDTH);
  assert.equal(sky.props.style.height, HOUSE_NATURAL_HEIGHT);
});

test('a commission that becomes impeded flies to the table', async () => {
  const view = await watchLedger([person('w-1')], [
    [card('T-1', 'doing')],
    [card('T-1', 'blocked')]
  ]);
  const air = inTheAir(view);
  assert.equal(air.length, 1);
  assert.equal(air[0].props['data-flight-to'], 'table');
});

test('a second flight of the same move is a second book, and lands alone', async () => {
  // Blocked, freed, blocked again, faster than a flight lasts: the first book
  // is still crossing the house when the second sets off. Two books, two keys —
  // and catching one of them out of the air must leave the other flying, which
  // a shared key cannot do.
  const view = await watchLedger([person('w-1')], [
    [card('T-1', 'doing')],
    [card('T-1', 'blocked')],
    [card('T-1', 'doing')],
    [card('T-1', 'blocked')]
  ]);
  const air = inTheAir(view);
  assert.equal(air.length, 2, 'the first book is still up there when the second leaves');
  const [one, two] = air.map((n) => n.props['data-book-flight']);
  assert.notEqual(one, two, 'two flights, two keys');
  air[0].props.onAnimationEnd({
    target: air[0], currentTarget: air[0], animationName: 'cth-book-fly-across'
  });
  view.render();
  assert.deepEqual(inTheAir(view).map((n) => n.props['data-book-flight']), [two],
    'the one that landed left the sky, and only it');
});

test('a book that lands leaves the sky', async () => {
  const view = await watchLedger([person('w-1')], [
    [card('T-1', 'doing')],
    [card('T-1', 'blocked')]
  ]);
  const [book] = inTheAir(view);
  book.props.onAnimationEnd({
    target: book, currentTarget: book, animationName: 'cth-book-fly-across'
  });
  view.render();
  assert.deepEqual(inTheAir(view), [], 'the flourish does not stay on the screen');
});

test('a machine that asked for stillness is given a house that never flies', async () => {
  // The refusal is made where the flights are launched, not where they are
  // drawn — so this is the assertion that the scene actually ASKS. A house that
  // launched them and then declined to draw them would pass every other test
  // here and still be keeping a list of things in the air.
  const view = await watchLedger([person('w-1')], [
    [card('T-1', 'doing')],
    [card('T-1', 'blocked')]
  ], { reducedMotion: true });
  assert.deepEqual(inTheAir(view), []);
  // And the same ledger without the request does fly, so the emptiness above
  // is the preference and not a broken fixture.
  const moving = await watchLedger([person('w-1')], [
    [card('T-1', 'doing')],
    [card('T-1', 'blocked')]
  ]);
  assert.equal(inTheAir(moving).length, 1);
});

test('stillness switched on mid-flight empties the sky, and keeps it empty', async (t) => {
  // The refusal to launch is not enough on its own. Books already in the air
  // when the preference turns on are hit by the media rule, which sets
  // `animation: none` — so they never fire animationend, never leave the list,
  // and sit there invisible. Turn the preference off again and every one of
  // them starts animating, late and out of nowhere, having meanwhile eaten the
  // sky's budget.
  const stillness = { reduced: false };
  const ledgers = [[card('T-1', 'doing')], [card('T-1', 'blocked')]];
  const view = await watchLedger([person('w-1')], ledgers, { stillness });
  assert.equal(inTheAir(view).length, 1, 'a book is in the air to be caught out');

  let cleanups = [];
  const round = async () => {
    await settle();
    view.render();
    for (const c of cleanups) c?.();
    cleanups = view.runEffects();
  };
  const rounds = async (n) => { for (let i = 0; i < n; i++) await round(); };
  // A failed assertion must not leave the ledger's poll timer running, or the
  // runner never exits and the failure is a hang instead of a report.
  t.after(() => { for (const c of cleanups) c?.(); });

  stillness.reduced = true;
  await rounds(2); // one to read the preference, one to act on it
  view.render();
  assert.deepEqual(inTheAir(view), [], 'the still house is not holding hidden books');

  // The house must keep WATCHING while it is still, or a move made during the
  // quiet is a move it thinks it has yet to see — and flies once it can move
  // again, minutes after it happened.
  ledgers.push([card('T-1', 'done')]);
  await rounds(2);

  stillness.reduced = false;
  await rounds(2);
  view.render();
  assert.deepEqual(inTheAir(view), [],
    'the move made during the quiet is not flown retrospectively');

  // ...and the house still flies, so the emptiness above is the fix and not a
  // scene that has stopped watching the ledger.
  ledgers.push([card('T-1', 'done'), card('T-2', 'doing')]);
  await rounds(2);
  ledgers.push([card('T-1', 'done'), card('T-2', 'done')]);
  await rounds(2);
  view.render();
  assert.equal(inTheAir(view).length, 1, 'a move made after the quiet still flies');
});

test('the sky is bounded, so a window nobody watches cannot fill it', async () => {
  // An animation in a window nobody is looking at never ends, so nothing ever
  // leaves the sky on its own. The bound is what keeps that from becoming a
  // list that grows for as long as the Study is left open behind something.
  const many = Array.from({ length: SKY_MAX + 5 }, (_, i) => `T-${i}`);
  const view = await watchLedger([person('w-1')], [
    many.map((id) => card(id, 'doing')),
    many.map((id) => card(id, 'blocked'))
  ]);
  assert.equal(inTheAir(view).length, SKY_MAX,
    'the sky holds its bound and no more');
});

test('a book in the air is still bound for the room it left', async () => {
  // The bindings exist so a volume is legible against ITS room's paint. A book
  // that changed binding the moment it took off would be a different book
  // arriving than the one that left, which is the one thing an animation
  // between two places must not be.
  const { studyRoom: house } = loadTs(SCENE);
  const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const berths = deskBerths(house);
  const bound = house.rooms.find((r) => r.kind === 'desk' && r.binding);
  assert.ok(bound, 'some reading room binds its volumes its own way');
  // Whoever is seated at that room's first berth: seating fills berths in the
  // manifest's own order, so this is the assistant who lands there.
  const seat = berths.findIndex((b) => bound.berths.some((x) => x.id === b.id));
  const agents = berths.map((_, i) => person(`w-${i}`));
  const holder = agents[seat].id;
  const ledger = (status) => [card('T-1', status, { assignee: holder })];

  const view = await watchLedger(agents, [ledger('doing'), ledger('blocked')]);
  const [book] = inTheAir(view);
  assert.ok(book, 'the book left the desk');
  const worn = deep(book, (n) => n.props?.['data-book-binding'] !== undefined)
    .map((n) => n.props['data-book-binding']);
  assert.deepEqual(worn, [bound.binding],
    `it keeps ${bound.id}'s binding all the way across the house`);
});
