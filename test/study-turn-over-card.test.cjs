'use strict';
/**
 * The page a reader is turning crosses the reader.
 *
 * The film is a rectangle of PANEL — desk, chair and wall as well as the book —
 * so where it is painted decides what the desk looks like, and both plain
 * answers are wrong. Under the card, a leaf that rises off the book vanishes
 * behind the portrait. Over the card, the clip's own wall washes across the
 * portrait's lower half and the assistant is behind frosted glass.
 *
 * The third answer is that the clip already knows which pixels are pages: it
 * was generated from the panel, so everything that has not moved IS the panel.
 * Difference the frame against the painting, read the difference as opacity,
 * and only the leaves are drawn. That matte is what makes painting the film
 * over the card safe, and these tests hold the two halves together — the order,
 * and the cut. Either alone is a defect that looks like a feature.
 *
 * And one thing the leaves must not cost: the card is a door. A layer drawn
 * over it that took the pointer would close it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { studyRoom, ROOM_SRC } = loadTs(SCENE);
const { BookTurn } = loadTs('src/renderer/src/scene/study/BookTurn.tsx');
const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');
const { matteId } = loadTs('src/renderer/src/scene/study/TurnMattes.tsx');

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
/** Every ancestor of a node that has an opinion about style, nearest first. */
const trail = (root, want, path = [], out = []) => {
  if (!root || typeof root !== 'object') return out;
  if (Array.isArray(root)) { for (const k of root) trail(k, want, path, out); return out; }
  const here = root.props?.style ? [root, ...path] : path;
  if (want(root)) out.push(here);
  if (root.props?.children !== undefined) trail(root.props.children, want, here, out);
  if (typeof root.type === 'function') {
    let r; try { r = root.type(root.props); } catch { return out; }
    trail(r, want, here, out);
  }
  return out;
};
const reachable = (path) => {
  for (const node of path) {
    const said = node.props?.style?.pointerEvents;
    if (said !== undefined) return said !== 'none';
  }
  return true;
};

const settle = () => new Promise((r) => setImmediate(r));
const views = [];
test.after(() => { for (const v of views) for (const c of v.cleanups ?? []) c?.(); });

const card = (id, status, assignee = 'ann') =>
  ({ id, title: `card ${id}`, status, assignee, dependsOn: [], humanQA: [] });

async function house(tasks, { who = ['ann'] } = {}) {
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    cth: { hiveTasks: async () => ({ tasks }), requestQuit: async () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  for (const id of who) {
    useStore.getState().addAgent({
      id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: 'a reader',
      project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'working', action: '', progress: 0
    });
  }
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

const placeOf = (view, id) => deep(view.tree, (n) => n.props?.['data-study-place'] === id)[0];
const filmAt = (view, id) => deep(placeOf(view, id), (n) => n.type === BookTurn)[0];
const mattes = (view) => deep(view.tree, (n) => n.type === 'filter');

/* ---- the order, and the cut that makes it safe --------------------------- */

test('the turning page crosses the reader, and is cut out of the painting to do it', async () => {
  const view = await house([card('T-1', 'doing')]);
  const order = [];
  deep(view.tree, (n) => {
    if (n.type === BookTurn) order.push('film');
    if (n.type === AgentCard) order.push('card');
    return false;
  });
  assert.deepEqual(order, ['card', 'film'],
    'the film is painted under the portrait, so a page leaving the book goes behind it');

  // ...and it is MATTED. A film over the card and not cut against the painting
  // is the room's wall laid across the assistant: the same defect the old order
  // was avoiding, arrived at from the other side.
  const film = filmAt(view, 'ann');
  assert.ok(film.props.matteId, 'the film names no matte');
  const defined = new Set(mattes(view).map((f) => f.props.id));
  assert.ok(defined.has(film.props.matteId),
    `the film is drawn through ${film.props.matteId}, which the house never defines — `
    + 'an undefined filter is silently ignored, and the whole rectangle lands on the card');
});

test('every matte is cut against its own desk’s painting, at its own patch of it', async () => {
  // A matte cut against the wrong painting, or against the right painting in
  // the wrong place, differences a frame from something it never matched: every
  // pixel then reads as movement and the whole rectangle is drawn again.
  const view = await house([card('T-1', 'doing')]);
  const byId = new Map(mattes(view).map((f) => [f.props.id, f]));
  const berths = studyRoom.rooms.flatMap((r) => r.berths.map((b) => ({ room: r, berth: b })));
  const filmed = berths.filter(({ berth }) => berth.turn);
  assert.equal(filmed.length, 8, `${filmed.length} berths have a film, not 8`);

  for (const { room, berth } of filmed) {
    const f = byId.get(matteId(berth.id));
    assert.ok(f, `${berth.id} has a film and no matte`);
    const painting = deep(f, (n) => n.type === 'feImage')[0];
    assert.ok(painting, `${berth.id}: the matte differences the film against nothing`);
    assert.equal(painting.props.href, ROOM_SRC[room.image],
      `${berth.id}: the matte is cut against another room's painting`);
    const t = berth.turn;
    // The patch, stated as the manifest states it — fractions of the panel — so
    // the matte registers at any window size without being told the size.
    const close = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(close(painting.props.width, 1 / t.w) && close(painting.props.height, 1 / t.h),
      `${berth.id}: the painting is scaled to ${painting.props.width}×${painting.props.height}, `
      + `not ${1 / t.w}×${1 / t.h}`);
    assert.ok(close(painting.props.x, -t.x / t.w) && close(painting.props.y, -t.y / t.h),
      `${berth.id}: the painting is offset to ${painting.props.x},${painting.props.y}, `
      + `not ${-t.x / t.w},${-t.y / t.h} — the matte is registered on the wrong patch`);
    assert.equal(painting.props.preserveAspectRatio, 'none',
      `${berth.id}: the painting keeps its own aspect and lands off the film`);
  }
});

test('the matte keys out the drift the codec adds and keeps a page', () => {
  // The two numbers that decide whether this works at all, checked against
  // things measured off the clips rather than against themselves: the model and
  // codec shift a still frame by 4.1–6.7 of 255, and a cream leaf differs from
  // the wood behind it by around 100 of 255.
  const view = mount(
    loadTs('src/renderer/src/scene/study/TurnMattes.tsx').TurnMattes,
    { rooms: studyRoom.rooms }
  );
  views.push(view);
  const ramp = deep(view.tree, (n) => n.type === 'feFuncA')[0];
  assert.ok(ramp, 'the matte has no ramp from difference to opacity');
  const alpha = (d) => Math.max(0, Math.min(1, ramp.props.slope * d + ramp.props.intercept));
  assert.equal(alpha(6.7 / 255), 0,
    'the drift a still frame already has is drawn, which is the whole rectangle again, faintly');
  assert.equal(alpha(100 / 255), 1,
    'a page against the wood behind it is drawn see-through');
});

/* ---- the card is still a door -------------------------------------------- */

test('the page sweeps over the card without taking the pointer from it', async () => {
  // The film is now drawn OVER the card, so a layer that took the pointer would
  // close the door the card is — everywhere a page might pass, which is the
  // caption and the whole lower third of the portrait.
  //
  // The element itself cannot be reached by walking the house: `BookTurn` takes
  // hooks, so the walker cannot expand it. So it is mounted here with THE PROPS
  // THE HOUSE HANDED IT, read off the rendered tree, rather than with props
  // invented for the occasion.
  const view = await house([card('T-1', 'doing')]);
  const handed = filmAt(view, 'ann').props;
  const film = mount(BookTurn, handed);
  views.push(film);
  assert.equal(film.tree.props.style.pointerEvents, 'none',
    'the film takes the pointer, and it is drawn over the card — the assistant cannot '
    + 'be opened where a page might pass');
  assert.ok(film.tree.props.style.zIndex > 0,
    'the film is not in front of the card, so no leaf ever crosses it');

  const seat = trail(view.tree, (n) => n.props?.['data-study-card'] !== undefined)[0];
  assert.ok(seat, 'no card is drawn to check');
  assert.ok(reachable(seat), 'the card under the film cannot be pressed');
});

/* ---- a shared desk ------------------------------------------------------- */

test('each reader at a shared desk gets their own page over their own card', async () => {
  // The order and the raise are decided per place setting, so a desk with two
  // readers is where a decision made once for the room would show.
  const who = Array.from({ length: 9 }, (_, i) => `r${i}`);
  const view = await house(who.map((id, i) => card(`T-${i}`, 'doing', id)), { who });
  const seen = new Map();
  for (const id of who) {
    const film = filmAt(view, id);
    assert.ok(film, `${id} has no film`);
    const key = film.props.matteId;
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(id);
  }
  const shared = [...seen.values()].filter((desk) => desk.length > 1);
  assert.ok(shared.length > 0,
    `${who.length} readers filled ${seen.size} desks without any of them sharing one`);
  for (const desk of shared) {
    const named = new Set(desk.map((id) => filmAt(view, id).props.src));
    assert.equal(named.size, 1, 'two readers at one desk are shown different films');
  }
});
