'use strict';
/**
 * The painted book turns its pages with the room's own art.
 *
 * It used to turn with shapes of ours: two cream rectangles and a third that
 * swung across them on a keyframe, laid over the volume the painter had already
 * drawn on that desk. Now a few seconds of that very corner of that very panel
 * plays there instead — generated from the panel, one clip per desk.
 *
 * What the tests have to hold is not "a video element exists". It is the three
 * things that make the film mean what a turning page means:
 *
 *   - it plays only when somebody is actually READING at that desk, because
 *     pages that turn for a card nobody is touching say the opposite of the
 *     truth;
 *   - a desk at rest draws no film at all, so the book at rest is the painting
 *     itself rather than a near-miss of it;
 *   - asking the House to hold still pauses it on the frame that IS the
 *     painting, rather than tearing the book out of the room.
 *
 * And one thing about where it may be pressed: the film is scenery. The book
 * stays the door.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { studyRoom, turnBox, containFit } = loadTs(SCENE);
const { TURN_SRC } = loadTs('src/renderer/src/scene/study/bookTurns.ts');
const { BookTurn } = loadTs('src/renderer/src/scene/study/BookTurn.tsx');
const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');

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

const card = (id, status, over = {}) =>
  ({ id, title: `card ${id}`, status, assignee: 'ann', dependsOn: [], humanQA: [], ...over });

/**
 * One assistant, with the House still or moving.
 *
 * `isGod` seats them in the god's study instead of a reading room, which is the
 * only desk in the house whose painter left no book on it — see the god-path
 * test at the bottom. It has to go through THIS, the real projection, because
 * which berth somebody sits at is the projection's decision and a desk mounted
 * by hand has already had that decision made for it.
 */
async function house(tasks, { still = false, isGod = false } = {}) {
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    matchMedia: () => ({ matches: still, addEventListener: () => {}, removeEventListener: () => {} }),
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
  // NOT runEffects() again: mount already ran them once, and a second pass
  // starts the ledger poll twice and the run never exits.
  view.render();
  return view;
}

/**
 * The films a rendered house is drawing.
 *
 * Found by COMPONENT rather than by the mark on the video, because the tree
 * walk cannot run a component that uses hooks — it calls the function outside
 * any host and swallows what comes back. So this asks the question one level
 * up: which desks were handed a film, and with what. What the element itself
 * does with that is `BookTurn`'s own test, mounted properly, below.
 */
const films = (view) => deep(view.tree, (n) => n.type === BookTurn);
const leaves = (view) => deep(view.tree, (n) => n.props?.['data-book-leaf'] !== undefined);

/* ---- the film is only ever the room's own -------------------------------- */

test('every desk the painter put a book on has a film of that desk, and no other does', () => {
  // Totality, both ways. A berth naming a clip nobody imported would draw a
  // black rectangle where the book was; an imported clip no berth names is dead
  // weight in the bundle. Neither shows up by looking at one room.
  const berths = studyRoom.rooms.flatMap((r) => r.berths.map((b) => ({ room: r, berth: b })));
  const named = new Set();
  for (const { room, berth } of berths) {
    if (!berth.turn) continue;
    assert.ok(berth.volume,
      `${berth.id} has a page turn but no painted book to turn — the manifest should have refused it`);
    assert.ok(TURN_SRC[berth.turn.clip],
      `${berth.id} names ${berth.turn.clip}, which nothing imports`);
    named.add(berth.turn.clip);
    const view = containFit({ w: room.natural.w, h: room.natural.h }, room.natural);
    const t = turnBox(berth, view);
    assert.ok(t && t.box.width > 0 && t.box.height > 0, `${berth.id} projects no film box`);
  }
  assert.equal(named.size, Object.keys(TURN_SRC).length,
    'a clip is imported that no berth in the house asks for');
  // Not merely "some": every painted volume in the house is filmed, so no desk
  // is left drawing pages by hand next to one that is not.
  const painted = berths.filter(({ berth }) => berth.volume);
  assert.ok(painted.length > 0, 'no painted volumes at all');
  for (const { berth } of painted) {
    assert.ok(berth.turn, `${berth.id} has a painted book but no film of it`);
  }
});

test('the film covers more of the desk than the book, and is not derived from it', () => {
  // A page has to go somewhere. If the film box were just the volume, a leaf
  // would be clipped at the edge of the book it is lifting off — and the rect
  // is read data per berth rather than arithmetic, because it also has to keep
  // that room's candle out of shot.
  for (const room of studyRoom.rooms) {
    for (const berth of room.berths) {
      if (!berth.turn) continue;
      assert.ok(berth.turn.w > berth.volume.w && berth.turn.h > berth.volume.h,
        `${berth.id}: the film is no bigger than the book`);
      const view = containFit({ w: room.natural.w, h: room.natural.h }, room.natural);
      const flames = room.lightPoints.map((p) => view.x + p.x * view.w);
      const t = turnBox(berth, view);
      for (const flame of flames) {
        assert.ok(flame <= t.box.left || flame >= t.box.left + t.box.width,
          `${berth.id}: a candle at ${flame.toFixed(0)} is inside the film, and the model `
          + 'would animate a second flame beside the one the ambiance layer draws');
      }
    }
  }
});

/* ---- when it plays, and when it does not --------------------------------- */

test('a desk with nobody reading at it draws no film — the book is the painting', async () => {
  // The most important state, and the easiest to get wrong by mounting a paused
  // clip everywhere. The panel underneath IS the book at rest; a first frame of
  // a generated clip is a few parts in 255 away from it, and the way to be
  // exactly right is to draw nothing.
  const view = await house([card('T-1', 'todo'), card('T-2', 'blocked')]);
  assert.equal(films(view).length, 0,
    'a film is playing over a desk where nothing is being read');
});

test('the pages turn only while a commission is actually in hand', async () => {
  const view = await house([card('T-1', 'doing'), card('T-2', 'todo')]);
  const drawn = films(view);
  assert.equal(drawn.length, 1, 'the desk being read at draws exactly one film');
  assert.equal(drawn[0].props.playing, true,
    'the film is on the desk but not turning while somebody is reading');
  // And it is THIS room's film, not just any: a desk playing the room next
  // door's book would look almost right and be a different painting.
  const { deskBerths } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const seat = deskBerths(studyRoom)[0];
  assert.equal(drawn[0].props.src, TURN_SRC[seat.turn.clip],
    `the desk at ${seat.id} is playing somebody else's book`);
});

test('a House asked to hold still keeps the book and stops the pages', async () => {
  // Paused, not removed: somebody who has asked for stillness should still see
  // which book is in that reader's hands.
  const view = await house([card('T-1', 'doing')], { still: true });
  const drawn = films(view);
  assert.equal(drawn.length, 1, 'stillness took the book off the desk entirely');
  assert.equal(drawn[0].props.playing, false,
    'the pages are still turning with reduced motion asked for');
});

test('the film really drives the element, not just an attribute', async () => {
  // The attribute above is what a tree can be asked about; it is not what makes
  // a video play. This mounts the component, hands its ref a stand-in element
  // and runs the effect, so the calls that actually start and stop the clip are
  // the thing under test.
  const { BookTurn } = loadTs('src/renderer/src/scene/study/BookTurn.tsx');
  const box = { left: 0, top: 0, width: 288, height: 162 };
  const calls = [];
  const node = {
    play: () => { calls.push('play'); return Promise.resolve(); },
    pause: () => { calls.push('pause'); },
    set currentTime(v) { calls.push(`seek:${v}`); },
    get currentTime() { return 0; }
  };
  const moving = mount(BookTurn, { src: 'x.mp4', box, playing: true });
  views.push(moving);
  const film = moving.tree;
  assert.equal(film.props['data-book-turn'], 'x.mp4', 'the film is not the element it claims');
  assert.equal(film.props.loop, true, 'the turn stops after one page');
  assert.equal(film.props.muted, true, 'the house has no sound');
  assert.equal(film.props.style.pointerEvents, 'none',
    'the film takes the pointer, so the hit target becomes a patch of desk');
  assert.equal(film.props.onClick, undefined, 'the film is a control');
  assert.match(String(film.props.style.maskImage), /gradient/,
    'the film has a hard rectangle edge, which is where a flat level shift shows');
  film.props.ref.current = node;
  moving.render(); moving.runEffects();
  assert.ok(calls.includes('play'), `nothing started the clip: ${JSON.stringify(calls)}`);

  calls.length = 0;
  const held = mount(BookTurn, { src: 'x.mp4', box, playing: false });
  views.push(held);
  held.tree.props.ref.current = node;
  held.render(); held.runEffects();
  assert.ok(calls.includes('pause'), `nothing stopped the clip: ${JSON.stringify(calls)}`);
  assert.ok(calls.includes('seek:0'),
    'a paused clip was left on whatever frame it stopped on, rather than the painting');
});

/* ---- one book on a desk, and the door is still the book ------------------ */

test('the film is drawn behind the portrait, not over it', async () => {
  // The clip is a patch of the PANEL — desk, chair and wall as well as the book
  // — and the card stands on that desk with its foot on the book's top edge.
  // Painted after the card, the film's own wall washes across the portrait's
  // lower half and the assistant is behind frosted glass. This is the one thing
  // about the arrangement that cannot be seen from the clip alone, because the
  // clip was cut from a room with nobody sitting in it.
  const view = await house([card('T-1', 'doing')]);
  const order = [];
  const walk = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.type === BookTurn) order.push('film');
    if (n.type === AgentCard) order.push('card');
    if (n.props?.children !== undefined) walk(n.props.children);
    if (typeof n.type === 'function') {
      let r; try { r = n.type(n.props); } catch { return; }
      walk(r);
    }
  };
  walk(view.tree);
  assert.deepEqual(order, ['film', 'card'],
    'the film is painted over the portrait, which puts the room’s wall across the card');
});

test('the drawn pages are gone where the film draws them', async () => {
  // Both would be two books on one desk — the exact doubling the painted volume
  // was registered on to avoid.
  const view = await house([card('T-1', 'doing')]);
  assert.equal(films(view).length, 1);
  assert.equal(leaves(view).length, 0,
    'the CSS leaf is still swinging over the film of the same book');
});

test('the film is scenery; the book is still the door', async () => {
  const view = await house([card('T-1', 'doing')]);
  assert.equal(films(view).length, 1, 'no film to check');

  const opened = [];
  useStore.setState({ openTaskDetail: (id) => opened.push(id) });
  view.render();
  const door = deep(view.tree, (n) => n.props?.['data-book-state'] === 'open')[0];
  assert.ok(door, 'the open book is gone from the tree');
  assert.equal(door.props.style.pointerEvents, 'auto', 'the book cannot be pressed');
  door.props.onClick({ stopPropagation: () => {} });
  assert.deepEqual(opened, ['T-1'], 'pressing the book did not open its commission');
});

test('the desk the painter left bare still draws its own book, and it still turns', async () => {
  // THROUGH THE SCENE, not by mounting a book with the answer already handed to
  // it. The god's study is the one seat with no painted volume and so no film,
  // and whether it keeps its drawn turn is decided by two pieces of production
  // wiring — `turnBox`, which must return null for a berth with no clip, and
  // the place setting, which must only set `painted` when it got one. A book
  // mounted by hand exercises neither: it tests that DeskBook can draw a leaf,
  // which was never in doubt.
  const god = studyRoom.rooms.find((r) => r.kind === 'godStudy');
  assert.ok(god && god.berths[0] && !god.berths[0].volume,
    'the god now has a painted volume; this test is about the case where none exists');
  assert.equal(god.berths[0].turn, undefined, 'the god has a film but no book to film');

  const view = await house([card('T-1', 'doing')], { isGod: true });
  const place = deep(view.tree, (n) => n.props?.['data-study-place'] === 'ann')[0];
  assert.ok(place, 'the god is not seated in the house at all');

  assert.equal(films(view).length, 0,
    'a film is playing at the god’s desk, where the painter drew no book to film');
  const open = deep(place, (n) => n.props?.['data-book-state'] === 'open');
  assert.equal(open.length, 1, 'the god’s commission is not an open book');
  assert.equal(leaves(view).length, 1,
    'the god’s book lost its drawn page turn, so that desk cannot say it is being worked at');
  // And it is a real book, not an empty frame with a leaf in it: `painted`
  // strips the boards and the pages, and passing it here would leave the god
  // with a page turning over bare desk.
  assert.ok(deep(open[0], (n) => n.props?.['data-book-page'] === 'left').length === 1,
    'the god’s book has no pages, which is what `painted` does to a book');
});

test('turnBox refuses a berth with no film, which is what protects the bare desk', () => {
  // The other half of the same seam, stated directly: the place setting only
  // sets `painted` when turnBox hands it something.
  const god = studyRoom.rooms.find((r) => r.kind === 'godStudy');
  const view = containFit({ w: god.natural.w, h: god.natural.h }, god.natural);
  assert.equal(turnBox(god.berths[0], view), null,
    'the god’s berth was given a film box out of nothing');
  // A berth that names a clip the build does not carry is the same case: draw
  // nothing rather than a black rectangle where the book was.
  assert.equal(turnBox({ ...god.berths[0], turn: { x: 0, y: 0, w: 0.1, h: 0.1, clip: './nope.mp4' } },
    view), null, 'a berth naming a clip nobody imported still got a film box');
});
