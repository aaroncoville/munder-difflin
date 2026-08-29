'use strict';
/**
 * The volumes waiting on a desk are the same object as the books on the felt,
 * and they lie beside the reader rather than on top of what they are waiting
 * for.
 *
 * They were drawn as bound volumes of their own, centred on the place the
 * painting had already put an open book — so a working desk showed a small
 * stack of flat planks squatting on the painted book, hiding the one thing on
 * that desk the painter drew for us. The desk next door, with nobody holding
 * anything, showed the book plainly and looked better for it.
 *
 * The rule that comes out of that: a commission NOT in hand is drawn the way
 * the card table draws it — same face, same turned mark, same sizing — because
 * it is the same thing in the same state, and a reader should not have to learn
 * a second alphabet to cross the room.
 *
 * Where they lie is the painted book's own place. A closed volume covering the
 * painted open book is right: the painting put a book on that desk, and what
 * the House has to say is which book is there now. What was wrong was the
 * DRAWING — bare boards where the felt deals bound volumes — and, when an
 * assistant holds more than one, that they did not stack the way a pile of
 * books on a table stacks.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const B = loadTs('src/renderer/src/scene/study/BaizeStacks.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { studyRoom, volumeBox, containFit } = loadTs(SCENE);

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

const card = (id, status, assignee = 'ann') => ({
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

/** Every spine drawn anywhere in the house, by the commission it stands for. */
const spines = (view) =>
  Object.fromEntries(deep(view.tree, (n) => n.props?.['data-spine-book'] !== undefined)
    .map((n) => [n.props['data-spine-book'], n]));

test('a volume waiting on a desk is the same object as one on the felt', async () => {
  // One commission held, one not, both waiting their turn. They are in the same
  // state and should therefore be drawn identically — the only difference is
  // which surface they are standing on.
  const view = await house([card('T-1', 'todo', 'ann'), card('T-2', 'todo', '')]);
  const drawn = spines(view);
  assert.ok(drawn['T-1'], 'the held commission is a spine on its desk');
  assert.ok(drawn['T-2'], 'the unheld one is a spine on the felt');
  for (const key of ['background', 'borderRadius', 'display', 'boxSizing', 'cursor']) {
    assert.equal(drawn['T-1'].props.style[key], drawn['T-2'].props.style[key],
      `the desk volume and the felt spine agree about ${key}`);
  }
  // The head band and the hairline are sized FROM the box, so two spines of
  // different sizes carry different numbers of pixels — the same rule, not the
  // same measurement. What has to match is the rule and the colours in it.
  const shape = (s) => s.boxShadow.replace(/[\d.]+px/g, 'Npx');
  assert.equal(shape(drawn['T-1'].props.style), shape(drawn['T-2'].props.style),
    'both wear the same head band and hairline, in the same tokens');
  assert.match(drawn['T-1'].props.style.boxShadow, /var\(--cth-/,
    'and they are tokens, not colours of their own');

  const mark = (n) => deep(n, (x) => x.props?.['data-spine-number'] !== undefined)[0];
  assert.ok(mark(drawn['T-1']), 'the desk volume carries its handle');
  for (const key of ['transform', 'fontFamily', 'color']) {
    assert.equal(mark(drawn['T-1']).props.style[key], mark(drawn['T-2']).props.style[key],
      `the handle is printed the same way on both — ${key}`);
  }
  assert.equal(mark(drawn['T-1']).props.children, 1, 'and it is this commission’s handle');
  // Absolutely, not merely the same as its neighbour: the two surfaces render
  // one component now, so every claim of the form "these two agree" survives
  // any change that breaks them BOTH. At least one thing has to be pinned to
  // the world instead.
  assert.match(String(mark(drawn['T-1']).props.style.transform), /rotate\(90deg\)/,
    'the handle is turned the quarter a book lying down turns its title');
});

test('an impeded volume on a desk wears the felt’s impeded face', async () => {
  const view = await house([card('T-1', 'blocked', 'ann'), card('T-2', 'blocked', '')]);
  const drawn = spines(view);
  assert.equal(drawn['T-1'].props.style.background, drawn['T-2'].props.style.background);
  const shape = (s) => s.boxShadow.replace(/[\d.]+px/g, 'Npx');
  assert.equal(shape(drawn['T-1'].props.style), shape(drawn['T-2'].props.style),
    'the impeded head band is the same on both surfaces');
  // And it really is the impeded face, not merely the same as its neighbour.
  assert.equal(drawn['T-1'].props.style.background, B.SPINE_FACES.blocked.background);
});

test('the volumes lie where the painting put a book', async () => {
  // Not beside it. The painting drew a book on that desk and the House says
  // which book is there now, so a volume of ours stands in its place — and
  // when several are held they pile up from it, the way books pile on a table.
  const view = await house([
    card('T-1', 'todo', 'ann'), card('T-2', 'todo', 'ann'), card('T-3', 'todo', 'ann')
  ]);
  const room = studyRoom.rooms.find((r) => r.kind === 'desk');
  const berth = room.berths[0];
  const view0 = containFit({ w: room.natural.w, h: room.natural.h }, room.natural);
  const painted = volumeBox(berth, view0);

  const drawn = Object.values(spines(view)).map((n) => n.props.style);
  assert.equal(drawn.length, 3, 'three commissions waiting, three volumes');
  const bottom = drawn.reduce((a, b) => (a.top > b.top ? a : b));
  assert.ok(Math.abs(bottom.left - painted.left) < painted.width * 0.12
    && Math.abs((bottom.top + bottom.height) - (painted.top + painted.height))
       < painted.height * 0.4,
  `the volume on the desk stands where the painted book is: `
  + `drawn ${bottom.left.toFixed(1)},${(bottom.top + bottom.height).toFixed(1)} `
  + `vs painted ${painted.left.toFixed(1)},${(painted.top + painted.height).toFixed(1)}`);

  // And they are a PILE: each above the last, leaning, the way the felt stacks.
  const byHeight = [...drawn].sort((a, b) => b.top - a.top);
  assert.ok(byHeight[1].top < byHeight[0].top, 'the second volume sits on the first');
  assert.ok(byHeight[2].top < byHeight[1].top, 'and the third on the second');
  assert.ok(new Set(drawn.map((s) => s.left)).size > 1,
    'the pile leans rather than standing perfectly flush, as a hand-made pile does');
});

test('the volume in hand lies exactly on the book the painting drew', async () => {
  // Its home, to the pixel. The overlay is the painting's book replaced, not a
  // second book near it — a few pixels out and the desk has two books on it
  // again, which is the whole fault this was drawn to fix.
  const view = await house([card('T-1', 'doing', 'ann')]);
  const place = deep(view.tree, (n) => n.props?.['data-study-place'] === 'ann')[0];
  const open = deep(place, (n) => n.props?.['data-book-state'] === 'open')[0];
  assert.ok(open, 'the commission in hand is an open book');

  const room = studyRoom.rooms.find((r) => r.kind === 'desk');
  const berth = room.berths[0];
  const view0 = containFit({ w: room.natural.w, h: room.natural.h }, room.natural);
  const painted = volumeBox(berth, view0);
  for (const key of ['left', 'top', 'width', 'height']) {
    assert.equal(open.props.style[key], painted[key],
      `the open book takes the painted volume's ${key} exactly`);
  }
});

test('the page turns small, the way a page on a small book does', async () => {
  // The house is letterboxed whole, so a painted volume is a few dozen pixels
  // across. A leaf sweeping the full page there is a shutter banging, not
  // somebody reading. What moves is a narrow sheet, and it barely leaves the
  // desk.
  const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
  const open = mount(DeskBook, { state: 'open', box: { left: 0, top: 0, width: 40, height: 14 } });
  const leaf = deep(open.tree, (n) => n.props?.['data-book-leaf'] !== undefined)[0];
  const page = deep(open.tree, (n) => n.props?.['data-book-page'] === 'right')[0];
  assert.ok(leaf && page, 'there is a leaf and a page for it to lift off');
  const pct = (v) => Number(String(v).replace('%', ''));
  assert.ok(pct(leaf.props.style.width) < pct(page.props.style.width),
    `the leaf is narrower than the page it lifts off `
    + `(${leaf.props.style.width} of ${page.props.style.width})`);

  const sheet = deep(open.tree, (n) => n.type === 'style')
    .map((n) => String(n.props.children)).join('\n');
  const rises = [...sheet.matchAll(/translateY\(-([\d.]+)%\)/g)].map((m) => Number(m[1]));
  assert.ok(rises.length > 0, 'the leaf still lifts as it goes');
  assert.ok(Math.max(...rises) <= 8,
    `the lift is ${Math.max(...rises)}% of the book, which is a page being thrown`);
});
