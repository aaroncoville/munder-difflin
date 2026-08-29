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
 * the card table draws it — same face, same turned mark, same SIZE — because it
 * is the same thing in the same state, and a reader should not have to learn a
 * second alphabet to cross the room. Taking the size from the desk instead is
 * what squashed them: the place they were fitted into is the painted book's
 * box, a volume lying open at the room's own angle, so an upright spine came
 * out four times flatter there than on the felt.
 *
 * Where they lie is beside the reader, at the end of the desk with no candle
 * burning on it. Not over the painted book — that hides the one thing on that
 * desk the painter drew for us, and it is where the book being READ goes.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const B = loadTs('src/renderer/src/scene/study/BaizeStacks.tsx');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const { studyRoom, volumeBox, containFit, berthToBox, deskLayout } = loadTs(SCENE);

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

test('a volume waiting on a desk is the size the card table deals it', async () => {
  // It was fitted to the box the PAINTING's open book occupies. That box is the
  // room's perspective already worked out — a volume lying on an angled desk is
  // drawn wide and shallow — so squeezing an upright spine into it came out
  // four times flatter than the same component on the felt, and read as a strip
  // of veneer rather than a book. Aaron, of the running house: *"There's like
  // 'books' in front of Marinette but they are too squashed. The books not
  // being worked on should just be the same books that are on the card table."*
  //
  // So the size comes from the card table now, and from nothing on the desk.
  const view = await house([card('T-1', 'todo', 'ann'), card('T-2', 'todo', '')]);
  const drawn = spines(view);
  const desk = drawn['T-1'].props.style;
  const felt = drawn['T-2'].props.style;
  assert.ok(Math.abs(desk.width - felt.width) < 0.01,
    `the desk deals a book ${desk.width} long where the felt deals ${felt.width}`);
  assert.ok(Math.abs(desk.height - felt.height) < 0.01,
    `and ${desk.height} thick where the felt deals ${felt.height}`);

  // Absolutely, as well as by agreement: two surfaces asking one function agree
  // however wrong that function is, so the shape is pinned to the world too. A
  // book lying down is several times longer than it is thick; the painted
  // volume's box is nearer twenty times, which is the squash this replaced.
  const shape = desk.width / desk.height;
  assert.ok(shape > 3 && shape < 6,
    `a waiting volume is ${Math.round(desk.width)}x${Math.round(desk.height)}, `
    + `which is ${shape.toFixed(1)} times longer than thick — not a book lying down`);

  // And it is not the painted volume's shape by coincidence, either.
  const room = studyRoom.rooms.find((r) => r.kind === 'desk');
  const view0 = containFit({ w: room.natural.w, h: room.natural.h }, room.natural);
  const painted = volumeBox(room.berths[0], view0);
  assert.ok(Math.abs(shape - painted.width / painted.height) > 1,
    'the waiting volume is still cut to the painted book\'s proportions');
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

test('the volumes wait beside the reader, on the side without the candle', async () => {
  // They stood in the painted book's own place, covering it. Aaron, on the
  // running house: *"The books not being worked on ... when not being worked on
  // they should be stacked just like on the card table but off to the side of
  // the card where the candle isn't."*
  //
  // Which side that is belongs to the ROOM, not to a constant: every reading
  // room is one painting with a flame somewhere in it, and the pile goes where
  // the flame is not.
  const view = await house([
    card('T-1', 'todo', 'ann'), card('T-2', 'todo', 'ann'), card('T-3', 'todo', 'ann')
  ]);
  const room = studyRoom.rooms.find((r) => r.kind === 'desk');
  const berth = room.berths[0];
  const view0 = containFit({ w: room.natural.w, h: room.natural.h }, room.natural);
  const desk = berthToBox(berth, view0);
  const painted = volumeBox(berth, view0);
  const seat = deskLayout(desk, painted).card;

  const drawn = Object.values(spines(view)).map((n) => n.props.style);
  assert.equal(drawn.length, 3, 'three commissions waiting, three volumes');
  const span = {
    left: Math.min(...drawn.map((b) => b.left)),
    right: Math.max(...drawn.map((b) => b.left + b.width))
  };

  // Beside the card, not under it and not over the book the painter drew.
  assert.ok(span.left >= seat.left + seat.width || span.right <= seat.left,
    `the pile at ${span.left.toFixed(0)}..${span.right.toFixed(0)} is under the card at `
    + `${seat.left.toFixed(0)}..${(seat.left + seat.width).toFixed(0)}`);
  assert.ok(span.left >= painted.left + painted.width || span.right <= painted.left,
    `the pile at ${span.left.toFixed(0)}..${span.right.toFixed(0)} covers the painted book `
    + `at ${painted.left.toFixed(0)}..${(painted.left + painted.width).toFixed(0)}`);

  // And on the unlit side. Read off the painting rather than off the rule: the
  // flames this room marks are where they are, and the test asks only that no
  // book of ours is standing in one, and that the pile went to the far side of
  // the card from the nearest of them.
  const flames = room.lightPoints
    .map((p) => view0.x + p.x * view0.w)
    .filter((x) => x >= desk.left && x <= desk.left + desk.width);
  assert.ok(flames.length > 0, 'this reading room has no candle to keep clear of');
  const nearest = flames.reduce((a, b) =>
    (Math.abs(a - (seat.left + seat.width / 2)) < Math.abs(b - (seat.left + seat.width / 2))
      ? a : b));
  for (const flame of flames) {
    assert.ok(flame <= span.left || flame >= span.right,
      `a candle burns at ${flame.toFixed(0)}, inside the pile`);
  }
  const pileOnLeft = span.right <= seat.left;
  assert.equal(pileOnLeft, nearest > seat.left + seat.width / 2,
    'the books were put down on the candle\'s side of the reader');

  // And they are a PILE: each above the last, leaning, the way the felt stacks,
  // standing on the desk surface rather than floating over it.
  const byHeight = [...drawn].sort((a, b) => b.top - a.top);
  assert.ok(Math.abs((byHeight[0].top + byHeight[0].height) - (desk.top + desk.height)) < 0.01,
    'the bottom volume does not stand on the desk');
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
