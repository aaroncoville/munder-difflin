'use strict';
/**
 * Finished work, marked on the shelf wall.
 *
 * An archived thing DARKENS one of the painted volumes. That is the inverse of
 * the usual "light it up" and it is the right way round here: the wall is a lit
 * one, so a hole in it is what the eye finds.
 *
 * The part that has to be held is that the mark lands on a BOOK. Nothing about
 * a rectangle says whether the paint inside it is a spine or a shelf ledge, and
 * the previous version placed its marks at the room's light points — which mark
 * the lamps — so every one of them stood beside a book rather than on one and
 * the whole wall read as smudges. The pixels are the only thing that knows.
 *
 * The bound is the other part, because its failure mode is quiet: a wall that
 * keeps everything looks correct on the day it ships and is an unreadable smear
 * a month later.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const S = loadTs('src/renderer/src/scene/study/shelfBooks.ts');
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const thing = (id, at, kind = 'commission') => ({ id, label: `t${id}`, kind, at });

test('the wall holds what it can hold, and the OLDEST is what falls off', () => {
  // Ordered oldest-first going in, so a bound that kept the wrong end would
  // still return the right COUNT — which is why the ids are asserted, not just
  // the length.
  const many = Array.from({ length: S.ARCHIVE_MAX + 5 },
    (_, i) => thing(`c${i}`, NOW - (S.ARCHIVE_MAX + 5 - i) * 1000));
  const kept = S.shelfBooks(many, NOW);
  assert.equal(kept.length, S.ARCHIVE_MAX);
  const ids = new Set(kept.map((k) => k.id));
  for (let i = 0; i < 5; i++) assert.ok(!ids.has(`c${i}`), `c${i} — the oldest — was kept`);
  assert.ok(ids.has(`c${S.ARCHIVE_MAX + 4}`), 'the newest fell off');
  assert.ok(S.ARCHIVE_MAX > 0 && S.ARCHIVE_MAX <= 64, 'ARCHIVE_MAX is not a bound');
  assert.ok(S.ARCHIVE_WINDOW_DAYS > 0, 'ARCHIVE_WINDOW_DAYS is not a window');
});

test('anything older than the window is off the wall', () => {
  const fresh = thing('fresh', NOW - 1 * DAY);
  const stale = thing('stale', NOW - (S.ARCHIVE_WINDOW_DAYS + 1) * DAY);
  const kept = S.shelfBooks([stale, fresh], NOW);
  assert.deepEqual(kept.map((k) => k.id), ['fresh']);
});

test('a thing with no date is bounded by the count and not by the clock', () => {
  // The ledger is a file edited by hand, so a card can reach the wall with no
  // usable date on it at all. Dropping it for want of one would mean finished
  // work vanishing rather than being archived, which is the opposite of what
  // the wall is for — so the window filters what HAS a date and the count
  // bounds everything.
  const undated = thing('someone', null);
  const stale = thing('stale', NOW - (S.ARCHIVE_WINDOW_DAYS + 9) * DAY);
  assert.deepEqual(S.shelfBooks([stale, undated], NOW).map((k) => k.id), ['someone']);
  // ...but it is still bounded, or the wall fills with them.
  const crowd = Array.from({ length: S.ARCHIVE_MAX * 2 }, (_, i) => thing(`a${i}`, null, 'assistant'));
  assert.equal(S.shelfBooks(crowd, NOW).length, S.ARCHIVE_MAX);
});

test('an empty archive is an empty wall, not a crash', () => {
  assert.deepEqual(S.shelfBooks([], NOW), []);
});

const readPng = require('./read-png.cjs');
const fs = require('node:fs');
const path = require('node:path');
const at = (p) => path.resolve(__dirname, '..', p);
const SHELVES = 'src/renderer/src/scene/study/assets/room-shelves.png';

/**
 * Whether a colour is the shelving rather than a book on it.
 *
 * The carcass, the ledges and the ladder are all the same warm mid-brown, and
 * every volume painted on this wall is either much darker or much bluer than
 * that. Two coarse tests separate them by a wide margin.
 */
const isShelving = ([r, g, b]) => r > b + 30 && r > 62;

test('every volume the wall can mark is a book somebody painted', () => {
  const panel = readPng(at(SHELVES));
  assert.equal(S.SHELF_BOOKS.length, S.ARCHIVE_MAX, 'the wall claims slots it has no books for');
  for (const [i, book] of S.SHELF_BOOKS.entries()) {
    let shelving = 0;
    let sampled = 0;
    for (let y = book.y * panel.height; y < (book.y + book.h) * panel.height; y += 2) {
      for (let x = book.x * panel.width; x < (book.x + book.w) * panel.width; x += 2) {
        sampled++;
        if (isShelving(panel.at(x, y))) shelving++;
      }
    }
    assert.ok(sampled > 0, `volume ${i} covers no paint at all`);
    assert.ok(shelving / sampled < 0.4,
      `volume ${i} is ${Math.round((shelving / sampled) * 100)}% shelving — `
      + 'it is standing on a ledge or a post rather than on a spine');
  }
});

test('finding a book under a mark is a fact about the mark, not about the paint', () => {
  // Without this, a probe loose enough to call every dark pixel a book would
  // pass the test above wherever the marks sat.
  const panel = readPng(at(SHELVES));
  let shelving = 0;
  let sampled = 0;
  for (let y = 0; y < panel.height; y += 3) {
    for (let x = 0; x < panel.width; x += 3) {
      sampled++;
      if (isShelving(panel.at(x, y))) shelving++;
    }
  }
  assert.ok(shelving / sampled > 0.2,
    `only ${Math.round((shelving / sampled) * 100)}% of the wall reads as shelving, `
    + 'so missing it says nothing');
});

test('no two archived things darken the same volume', () => {
  const view = { x: 0, y: 0, w: 800, h: 343 };
  const boxes = Array.from({ length: S.ARCHIVE_MAX }, (_, i) => S.bookSlot(i, view));
  for (const b of boxes) {
    assert.ok(b.left >= 0 && b.top >= 0, 'a volume is off the top or left of the panel');
    assert.ok(b.left + b.width <= view.w + 0.01, 'a volume is off the right of the panel');
    assert.ok(b.top + b.height <= view.h + 0.01, 'a volume is off the bottom of the panel');
    assert.ok(b.width > 0 && b.height > 0);
  }
  for (const a of boxes) {
    for (const b of boxes) {
      if (a === b) continue;
      const apart = a.left + a.width <= b.left || b.left + b.width <= a.left
        || a.top + a.height <= b.top || b.top + b.height <= a.top;
      assert.ok(apart, 'two archived things were given the same painted volume');
    }
  }
});

test('a slot past the last volume is still a volume, not NaN geometry', () => {
  // ARCHIVE_MAX bounds the archive to the wall's capacity, but the count is
  // data: a caller reading past the end must get a book rather than an
  // undefined rectangle that renders as a mark of no size at NaN.
  const view = { x: 0, y: 0, w: 800, h: 343 };
  const b = S.bookSlot(S.ARCHIVE_MAX + 3, view);
  assert.ok(Number.isFinite(b.left) && Number.isFinite(b.top), 'NaN geometry');
  assert.ok(b.width > 0 && b.height > 0);
});

// ─── In the scene ───────────────────────────────────────────────────────────

const { mount } = require('./render-hooks.cjs');
const { useStore } = loadTs('src/renderer/src/store/store.ts');
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const scenes = [];
test.afterEach(() => { while (scenes.length) for (const s of scenes.pop().cleanups) s?.(); });
const settle = () => new Promise((r) => setImmediate(r));
const person = (id, over = {}) => ({
  id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'idle', action: '', progress: 0, ...over
});
const all = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (Array.isArray(n)) { for (const k of n) all(k, pred, out); return out; }
  if (pred(n)) out.push(n);
  if (n.props?.children !== undefined) all(n.props.children, pred, out);
  if (typeof n.type === 'function') {
    let r; try { r = n.type(n.props); } catch { return out; }
    all(r, pred, out);
  }
  return out;
};

const shelfIn = (view) => all(view.tree, (n) => n.props?.['data-shelf-book'] !== undefined);
const baizeIn = (view) => all(view.tree, (n) => n.props?.['data-baize-book'] !== undefined);
/** The layer inside a mark that carries the re-laid painting and its shade. */
const paintOf = (book) => all(book, (n) => n.props?.['data-shelf-paint'] !== undefined)[0];

async function inhabit({ archived = [], tasks = [] }) {
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    cth: { hiveTasks: async () => ({ tasks }) }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent(person('w-1'));
  useStore.setState({
    archivedAgents: archived,
    requestCommandCenterTab: () => {}, select: () => {}, openTaskDetail: () => {}
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  scenes.push(view);
  await settle();
  view.render();
  return view;
}

/**
 * The wall is where CONCLUDED WORK goes, and the table is where open work is.
 *
 * The two surfaces divide the ledger between them and the division is the whole
 * contract: a commission is on exactly one of them, and which one it is on is
 * what tells you whether it is finished. Getting that wrong is not a cosmetic
 * fault — a table of mostly-finished commissions says the House is busy when it
 * is idle, and a wall that darkens for a departed assistant says work was
 * concluded when somebody merely left.
 */
test('an open commission is on the table and not on the wall', async () => {
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'doing', title: 'still reading', dependsOn: [],
      createdAt: new Date().toISOString() }]
  });
  assert.deepEqual(baizeIn(view).map((b) => b.props['data-baize-book']), ['T-1'],
    'the open commission is not the one book on the table');
  assert.equal(shelfIn(view).length, 0, 'open work was shelved as finished');
});

test('a concluded commission leaves the table for the wall', async () => {
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'done', title: 'the seventh folio', dependsOn: [],
      createdAt: new Date().toISOString() }]
  });
  assert.deepEqual(baizeIn(view).map((b) => b.props['data-baize-book']), [],
    'finished work is still piled on the table with the open work');

  const books = shelfIn(view);
  assert.equal(books.length, 1,
    `the wall holds ${books.length} marks for one concluded commission`);
  assert.equal(books[0].props['data-shelf-kind'], 'commission');
  assert.match(String(books[0].props.title), /seventh folio/,
    'the mark does not name the commission it stands for');
});

test('a concluded commission waiting on you is on the table, not yet on the wall', async () => {
  // The wall's marks are pieces of the painting and deliberately not controls,
  // so a question that reaches the wall is a question nobody can answer. A
  // commission is therefore only archived once nothing on it is still waiting.
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'done', title: 'the seventh folio', dependsOn: [],
      createdAt: new Date().toISOString(), humanQA: [{ q: 'which key?' }] }]
  });
  const baize = baizeIn(view);
  assert.deepEqual(baize.map((b) => b.props['data-baize-book']), ['T-1']);
  assert.equal(baize[0].props.role, 'button', 'the commission cannot be opened');
  assert.equal(baize[0].props['data-baize-petition'], '');
  assert.equal(shelfIn(view).length, 0,
    'the question was shelved where nobody can reach it');
});

test('answering the last question sends the concluded commission to the wall', async () => {
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'done', title: 'the seventh folio', dependsOn: [],
      createdAt: new Date().toISOString(),
      humanQA: [{ q: 'which key?', a: 'the staging one',
        answeredAt: new Date().toISOString() }] }]
  });
  assert.equal(baizeIn(view).length, 0, 'answered, and still on the table');
  assert.deepEqual(shelfIn(view).map((b) => b.props['data-shelf-book']), ['T-1']);
});

test('an assistant who left the House does not mark the wall', async () => {
  // The wall was the agent archive and Aaron read it as the finished-work
  // archive, which is the more useful of the two: a departed assistant is
  // already off the floor, and a darkened spine for one is a mark that says
  // "concluded" about somebody who concluded nothing.
  const view = await inhabit({ archived: [person('gone-1', { archived: true })] });
  assert.equal(shelfIn(view).length, 0,
    'a departed assistant still darkens a volume the finished work needs');
});

test('a mark is a piece of the wall itself, lined up by arithmetic', async () => {
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'done', title: 'the seventh folio', dependsOn: [],
      createdAt: new Date().toISOString() }]
  });
  const book = shelfIn(view)[0];
  assert.ok(book, 'no book');
  const paint = paintOf(book);
  assert.ok(paint, 'the mark has no layer of re-laid painting');
  const style = paint.props.style;
  // Not a colour drawn over the painting — the painting, re-laid.
  assert.match(String(style.backgroundImage), /^url\(/,
    'the mark paints something other than the wall it is marking');
  assert.match(String(style.filter), /brightness\(0?\.\d+\)/,
    'the mark does not darken what it lands on');
  // The alignment is the whole point, and it is arithmetic rather than an eye:
  // a window of the panel drawn at the panel's own size, slid back by exactly
  // where the window sits. Any other pair of numbers shows the wrong books.
  const px = (v) => Math.round(parseFloat(String(v)));
  const [bgW, bgH] = String(style.backgroundSize).split(' ').map(px);
  const [offX, offY] = String(style.backgroundPosition).split(' ').map(px);
  assert.ok(bgW > 0 && bgH > 0, `the copy has no size (${style.backgroundSize})`);
  // The window's own position is on the mark; the copy inside it is slid back
  // by exactly that much.
  const where = book.props.style;
  assert.equal(offX, -px(where.left), 'the copy is slid to the wrong column of the wall');
  assert.equal(offY, -px(where.top), 'the copy is slid to the wrong shelf');
  assert.ok(Math.abs(bgW / bgH - 1568 / 672) < 0.01,
    `the copy is drawn at ${bgW}x${bgH}, which is not the panel's shape`);
});

/**
 * The darkening is a LAYER of the mark, not the mark itself.
 *
 * A CSS filter takes the element and everything inside it, so a shade declared
 * on the mark would darken whatever the mark comes to carry — a number, a
 * label, a band — by exactly the amount that makes the painting behind it
 * recede. Anything printed on a spine would then be readable only by accident,
 * and the colour it was given would not be the colour on screen.
 */
test('a mark darkens the paint on a layer of its own, not everything it carries', async () => {
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'done', title: 'the seventh folio', dependsOn: [],
      createdAt: new Date().toISOString() }]
  });
  const book = shelfIn(view)[0];
  assert.ok(book, 'no book');
  assert.ok(!book.props.style?.filter,
    'the shade is on the mark itself, so everything the mark carries is darkened with it');
  const paint = paintOf(book);
  assert.ok(paint, 'the mark has no layer of re-laid painting');
  assert.match(String(paint.props.style.filter), /brightness\(0?\.\d+\)/,
    'the paint layer does not darken');
  assert.equal(all(paint, () => true).length, 1,
    'the darkened layer has something inside it, which is darkened with it');
});

test('the darkening is measured against the wall it actually lands on', () => {
  // Not "it declares a filter" — how far the pixels under a mark actually move.
  // The wall this was first designed for was assumed to be painted pale and is
  // not: room-shelves.png averages a luma of 61 out of 255, and a mid-tone
  // accent multiplied over that moves it a few percent, which is why a marked
  // volume could not be found among the painted spines.
  const png = readPng(at(SHELVES));
  const room = JSON.parse(fs.readFileSync(
    at('src/renderer/src/scene/study/assets/room.json'), 'utf8'))
    .rooms.find((r) => r.id === 'shelves');
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  const src = loadTs('src/renderer/src/scene/study/ShelfArchive.tsx');
  const view = { x: 0, y: 0, w: room.natural.w, h: room.natural.h };
  const box = S.bookSlot(0, view);

  // The kinds come from the archive itself rather than from the shade table's
  // own keys. Reading the table's keys asks it whether it agrees with itself,
  // which any table does; what a volume actually gets is `BOOK_SHADE[kind]` for
  // a kind the projection produced, and a table keyed by some other word
  // answers that with `undefined` — no filter at all.
  const { archiveOf } = loadTs('src/renderer/src/scene/study/useSceneState.ts');
  const shelved = [...new Set(archiveOf([{
    id: 'T-1', title: 'a folio', status: 'done', dependsOn: [],
    createdAt: new Date().toISOString()
  }], Date.now()).map((thing) => thing.kind))];
  assert.deepEqual(shelved.sort(), ['commission'],
    'the archive shelves something this test has never seen');
  for (const kind of shelved) {
    assert.ok(src.BOOK_SHADE[kind],
      `a ${kind} volume has no shade, so it paints as no mark at all`);
  }

  // The darkening itself is asked of every shade the wall declares, not only of
  // the kind the scene happens to send it today: a shade that does not move the
  // paint is a mark nobody can find, whenever it comes to be used.
  for (const kind of Object.keys(src.BOOK_SHADE)) {
    const shade = src.BOOK_SHADE[kind];
    const brightness = Number(/brightness\(([\d.]+)\)/.exec(shade)?.[1]);
    assert.ok(brightness > 0 && brightness < 1, `${kind}'s shade does not darken: ${shade}`);
    let before = 0;
    let after = 0;
    let n = 0;
    for (let y = Math.round(box.top); y < Math.round(box.top + box.height); y++) {
      for (let x = Math.round(box.left); x < Math.round(box.left + box.width); x++) {
        const px = png.at(x, y);
        before += luma(px);
        after += luma(px.map((c) => c * brightness));
        n++;
      }
    }
    assert.ok(n > 0, 'the volume covers no pixels of the painting');
    const drop = 1 - after / before;
    assert.ok(drop >= 0.6,
      `a ${kind} volume darkens its spine by ${(drop * 100).toFixed(0)}% — `
      + 'not enough to pick out among the painted volumes either side of it');
  }

  // ...and the two kinds are told apart, or the wall says only "something
  // finished" where the design says who or what.
  assert.notEqual(src.BOOK_SHADE.assistant, src.BOOK_SHADE.commission,
    'a departed assistant and a concluded commission mark the wall identically');
});
