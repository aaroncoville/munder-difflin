'use strict';
/**
 * The ring that says which book is under your hand.
 *
 * The shelf wall had it first. It is now shared with the card table's felt, the
 * piles waiting on a desk, and the open book somebody is reading — one
 * implementation, because four rings would diverge the first time anybody tuned
 * one of them.
 *
 * Two things have to hold for that to be a refactor rather than a redesign: the
 * wall must be drawn exactly as it was, and the rule that generalises the ring
 * must be a no-op there rather than a coincidence nobody checked.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const P = loadTs('src/renderer/src/scene/study/pulledBooks.ts');
const { bookSlot } = loadTs('src/renderer/src/scene/study/shelfBooks.ts');

/* ---- the rule the ring is measured by ------------------------------------ */

test('the ring is measured from the book’s smaller side', () => {
  // A spine standing on a shelf is narrow and tall; a book lying open on a desk
  // is wide and shallow. Measuring from the smaller side gives both the same
  // ring for the same apparent thickness — measuring from the width would put a
  // ring a third of the way across an open book.
  const standing = P.pullRing({ width: 20, height: 90 });
  const lying = P.pullRing({ width: 90, height: 20 });
  assert.equal(standing, lying, 'a book gets a different ring for lying down');
  assert.match(standing, /^0 0 0 [\d.]+px var\(--cth-gilt\)$/, standing);
  // Outset, not inset: an inset ring is drawn under whatever the piece carries.
  assert.ok(!standing.includes('inset'), 'the ring is drawn under the book’s own art');
});

test('the ring never vanishes on a book drawn very small', () => {
  // The house is letterboxed, so a proportional ornament can round to nothing.
  assert.match(P.pullRing({ width: 2, height: 1 }), /^0 0 0 1px /);
});

test('the shelf wall is drawn exactly as it was', () => {
  // The generalisation is only a refactor if it changes no shelf mark. Every
  // slot on the wall is narrower than it is tall, so the smaller side IS the
  // width the wall always used — asserted here rather than assumed, because it
  // is a fact about the shelf geometry that a future re-shelving could break.
  const view = { x: 0, y: 0, w: 1568, h: 672 };
  let checked = 0;
  for (let i = 0; i < 200; i++) {
    const box = bookSlot(i, view);
    if (!box || !(box.width > 0)) continue;
    checked++;
    assert.ok(box.width < box.height,
      `shelf slot ${i} is ${box.width}×${box.height} — wider than it is tall, so the ring `
      + 'the wall used to draw and the one it draws now are no longer the same');
    assert.equal(
      P.pullRing(box),
      `0 0 0 ${Math.max(1, box.width * 0.14)}px var(--cth-gilt)`,
      `shelf slot ${i} would be ringed differently than before`,
    );
  }
  assert.ok(checked >= 100, `only ${checked} shelf slots checked`);
});

/* ---- the two hands ------------------------------------------------------- */

test('a hand only ever lets go of the book it was on', () => {
  // The pointer crossing from one spine to the next fires the leave of the old
  // and the enter of the new, in an order nothing here controls.
  const on1 = P.pullBook(P.NOTHING_PULLED, 'T-1', 'hover', true);
  const moved = P.pullBook(P.pullBook(on1, 'T-2', 'hover', true), 'T-1', 'hover', false);
  assert.ok(P.bookIsPulled(moved, 'T-2'), 'a stale leave cleared the book just entered');
  assert.ok(!P.bookIsPulled(moved, 'T-1'));
});

test('the pointer and the keyboard hold books independently', () => {
  const both = P.pullBook(P.pullBook(P.NOTHING_PULLED, 'T-1', 'focus', true), 'T-1', 'hover', true);
  assert.ok(P.bookIsPulled(P.pullBook(both, 'T-1', 'hover', false), 'T-1'),
    'letting go with the pointer dropped a book the keyboard still holds');
});

test('a surface that tracks no hands is given no handlers', () => {
  // A volume in flight is scenery. It should not be reporting where the
  // pointer is, and it should not be a hand's business that it exists.
  assert.deepEqual(Object.keys(P.pullHands('T-1', P.NOTHING_PULLED)), []);
  const hands = Object.keys(P.pullHands('T-1', P.NOTHING_PULLED, () => {}));
  assert.deepEqual(hands.sort(), ['onBlur', 'onFocus', 'onMouseEnter', 'onMouseLeave'],
    'the keyboard does not reach the ring on the same terms as the pointer');
});

/* ---- through the house: every surface books stand on ---------------------- */

const { mount } = require('./render-hooks.cjs');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const { BookTurn } = loadTs('src/renderer/src/scene/study/BookTurn.tsx');

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

const card = (id, status, assignee = 'ann') =>
  ({ id, title: `card ${id}`, status, assignee, dependsOn: [], humanQA: [] });

async function house(tasks) {
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    cth: { hiveTasks: async () => ({ tasks }), requestQuit: async () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent({
    id: 'ann', name: 'ANN', character: 'jim', accent: 'sky', description: 'a reader',
    project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'working', action: '', progress: 0
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

/** Every book-shaped surface the house draws, by the mark each one carries. */
const surfaces = (view) => ({
  felt: deep(view.tree, (n) => n.props?.['data-spine-on'] === 'felt'),
  desk: deep(view.tree, (n) => n.props?.['data-spine-on'] === 'desk'),
  open: deep(view.tree, (n) => n.props?.['data-book-state'] === 'open')
});
const ringed = (node) => String(node?.props?.style?.boxShadow ?? '').includes('--cth-gilt');
const allBooks = (view) => {
  const s = surfaces(view);
  return [...s.felt, ...s.desk, ...s.open];
};

/**
 * The four assignments that put a book on each surface at once: one in hand
 * (the open book), two more held by the same assistant (the desk pile), and one
 * nobody has picked up (the felt).
 */
const aHouseful = () => [
  card('T-1', 'doing'), card('T-2', 'todo'), card('T-3', 'blocked'),
  card('T-4', 'todo', '')
];

for (const kind of ['felt', 'desk', 'open']) {
  test(`a book on the ${kind} wears the ring when a hand arrives, and only that book`, async () => {
    const view = await house(aHouseful());
    const before = surfaces(view)[kind];
    assert.ok(before.length > 0, `the house drew no book on the ${kind} to check`);
    assert.ok(!before.some(ringed), `a ${kind} book was ringed before anything touched it`);

    // Through the house: the handler the element itself carries, which is what
    // a pointer would reach. Constructing the state by hand would prove that
    // the ring CAN be drawn, which was never in doubt — the question is whether
    // this surface is wired to the hands at all.
    before[0].props.onMouseEnter();
    view.render();

    const after = surfaces(view)[kind];
    assert.ok(ringed(after[0]), `a hand on a ${kind} book drew no ring`);
    assert.equal(allBooks(view).filter(ringed).length, 1,
      'more than one book in the house is ringed at once');

    after[0].props.onMouseLeave();
    view.render();
    assert.ok(!surfaces(view)[kind].some(ringed), `the ring stayed after the hand left the ${kind}`);
  });

  test(`a book on the ${kind} is reached by the keyboard on the same terms`, async () => {
    const view = await house(aHouseful());
    const book = surfaces(view)[kind][0];
    assert.equal(book.props.tabIndex, 0, `a ${kind} book is not a tab stop`);
    assert.equal(typeof book.props.onFocus, 'function', `focus does not reach the ${kind} ring`);
    book.props.onFocus();
    view.render();
    assert.ok(ringed(surfaces(view)[kind][0]), `tabbing to a ${kind} book drew no ring`);
  });
}

test('the ring on the open book is drawn over the film turning its pages', async () => {
  // The page-turn film draws OVER the reader's card, and the open book is drawn
  // after it with no layer of its own. A ring left in place would sit under the
  // very thing that makes the book worth pointing at.
  const view = await house(aHouseful());
  const film = deep(view.tree, (n) => n.type === BookTurn)[0];
  assert.ok(film, 'no film is drawn to be layered against');
  surfaces(view).open[0].props.onMouseEnter();
  view.render();
  const book = surfaces(view).open[0];
  assert.ok(ringed(book), 'the open book drew no ring');
  const filmZ = mount(BookTurn, film.props).tree.props.style.zIndex;
  assert.ok(book.props.style.zIndex > filmZ,
    `the ring is at z ${book.props.style.zIndex}, under the film at z ${filmZ}`);
});

test('the ring does not take the pointer away from anything', async () => {
  // Visual only. A held book that started swallowing presses — or stopped
  // answering them — would be a behaviour change wearing an affordance's
  // clothes.
  const view = await house(aHouseful());
  const before = allBooks(view).map((n) => [n.props.style.pointerEvents, typeof n.props.onClick]);
  surfaces(view).felt[0].props.onMouseEnter();
  view.render();
  const after = allBooks(view).map((n) => [n.props.style.pointerEvents, typeof n.props.onClick]);
  assert.deepEqual(after, before, 'holding a book changed what can be pressed');
});
