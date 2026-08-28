'use strict';
/**
 * The commissions piled on the card table, and picking one up.
 *
 * They stood on the felt as a spread hand of cards, which at table size read as
 * a row of tokens balanced on their edges — and the more commissions there
 * were, the thinner each one got. They are books lying flat now: up to four
 * piles, each growing a spine at a time until it is full and the next one
 * starts. What the table has to say across a room is how much work there is,
 * and a pile says it before a single number is read.
 *
 * The interaction is unchanged and is checked here as such: one spine is one
 * commission, and pressing it opens that commission rather than the board.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const B = loadTs('src/renderer/src/scene/study/BaizeStacks.tsx');
const BAIZE = { left: 100, top: 50, width: 240, height: 90 };
const task = (id, status = 'todo', over = {}) =>
  ({ id, title: `card ${id}`, status, dependsOn: [], priority: 3, ...over });

test('the table is piled, and never piled higher than it holds', () => {
  const many = Array.from({ length: B.BAIZE_MAX * 3 }, (_, i) => task(`T-${i + 1}`));
  const piled = B.stackBaize(many, BAIZE);
  assert.equal(piled.length, B.BAIZE_MAX, 'the baize took an unbounded pile');
  assert.equal(B.BAIZE_MAX, B.STACKS * B.STACK_HIGH, 'the bound is not what the table holds');
  assert.ok(B.STACKS > 1 && B.STACKS <= 4, 'the table carries an implausible number of piles');
  assert.ok(B.STACK_HIGH >= 4 && B.STACK_HIGH <= 8, 'a pile that high is a column');
});

test('a pile grows upward, and the next one starts when it is full', () => {
  // The whole shape of the drawing: one commission is one spine, a spine sits
  // on the one below it, and a pile that has reached its height sends the next
  // commission to the pile beside it rather than growing for ever.
  const piled = B.stackBaize(
    Array.from({ length: B.STACK_HIGH + 2 }, (_, i) => task(`T-${i + 1}`)), BAIZE);
  assert.deepEqual(
    piled.map((s) => `${s.stack}:${s.level}`).slice(-3),
    [`0:${B.STACK_HIGH - 1}`, '1:0', '1:1'],
    'the pile kept growing past its height, or started a new one early');

  const first = piled.filter((s) => s.stack === 0);
  for (let i = 1; i < first.length; i++) {
    const under = first[i - 1].box;
    const over = first[i].box;
    assert.ok(Math.abs((under.top - over.top) - over.height) < 0.01,
      `book ${i} floats above the one under it, or is drawn through it`);
    assert.ok(over.width === under.width, 'the books in one pile are not the same book');
  }
  // Not perfectly flush: books stacked by hand do not line up, and a pile with
  // every edge in true is a bar chart.
  const lefts = new Set(first.map((s) => Math.round(s.box.left)));
  assert.ok(lefts.size > 1, 'every book in the pile is squared up with the last');
});

test('one pile stands in the middle of the table, not at the end of a row', () => {
  const alone = B.stackBaize([task('T-1')], BAIZE)[0].box;
  const middle = alone.left + alone.width / 2;
  assert.ok(Math.abs(middle - (BAIZE.left + BAIZE.width / 2)) < 0.01,
    'a lone pile sits off to one side, in the space three absent piles would take');

  // And a full table spreads: four piles across the felt rather than four in
  // one place.
  const full = B.stackBaize(
    Array.from({ length: B.BAIZE_MAX }, (_, i) => task(`T-${i + 1}`)), BAIZE);
  const columns = [...new Set(full.map((s) => s.stack))];
  assert.equal(columns.length, B.STACKS, 'the full table does not use every pile');
  const feet = full.filter((s) => s.level === 0).map((s) => s.box.left).sort((a, b) => a - b);
  assert.ok(feet[feet.length - 1] - feet[0] > BAIZE.width * 0.5, 'the piles are not spread');
});

test('every book lands on the baize, and none on the parlour wall', () => {
  for (const count of [1, 3, B.STACK_HIGH + 1, B.BAIZE_MAX]) {
    const piled = B.stackBaize(Array.from({ length: count }, (_, i) => task(`T-${i}`)), BAIZE);
    for (const { box } of piled) {
      assert.ok(box.left >= BAIZE.left - 0.01, `with ${count}: a book slid off the left`);
      assert.ok(box.top >= BAIZE.top - 0.01, `with ${count}: a book slid off the top`);
      assert.ok(box.left + box.width <= BAIZE.left + BAIZE.width + 0.01,
        `with ${count}: off the right`);
      assert.ok(box.top + box.height <= BAIZE.top + BAIZE.height + 0.01,
        `with ${count}: off the bottom`);
      assert.ok(box.width > 0 && box.height > 0, 'a book with no size');
    }
  }
});

test('what is stuck is piled first — that is what you cross the room to see', () => {
  const piled = B.stackBaize(
    [task('T-2', 'todo'), task('T-3', 'blocked'), task('T-4', 'doing')],
    BAIZE
  );
  assert.deepEqual(piled.map((d) => d.task.id), ['T-3', 'T-4', 'T-2']);
});

test('the table carries OPEN work only — a concluded commission is off it', () => {
  // The table says how much work the House is carrying. A pile that keeps every
  // commission ever finished says "busy" for ever, and the piles it reads as
  // are mostly of things nobody has to do: Aaron's note was that a whole table
  // of mostly-done work does not make sense. Concluded work has the shelf wall.
  const piled = B.stackBaize(
    [task('T-1', 'done'), task('T-2', 'todo'), task('T-3', 'done'), task('T-4', 'doing')],
    BAIZE
  );
  assert.deepEqual(piled.map((d) => d.task.id), ['T-4', 'T-2']);

  // And the bound is over the open work, not over the ledger: a house with a
  // long history still deals its whole backlog onto the felt.
  const history = Array.from({ length: B.BAIZE_MAX }, (_, i) => task(`D-${i}`, 'done'));
  const open = Array.from({ length: B.BAIZE_MAX }, (_, i) => task(`T-${i}`, 'todo'));
  assert.equal(B.stackBaize([...history, ...open], BAIZE).length, B.BAIZE_MAX,
    'finished work took the places the open work needed');
});

test('a book is numbered as the board numbers it', () => {
  // The book on the table and the card on the board have to be recognisably
  // the same commission, and the number is the only thing small enough to say so.
  const piled = B.stackBaize([task('T-7'), task('task-19'), task('whoosh')], BAIZE);
  assert.equal(piled[0].n, 7);
  assert.equal(piled[1].n, 19);
  // No number in the id at all: a handle out of the id itself rather than
  // nothing, because a blank spine is worse than an approximate handle.
  assert.equal(piled[2].n, 'WH');
});

/**
 * A commission's mark comes out of the commission, never out of where it is.
 *
 * The fallback for an id with no digits in it used to be the book's PLACE — its
 * index in whatever list it had been dealt into. Two surfaces deal into
 * different lists: the table's index is a position among sorted open work, and
 * the shelf's is a slot in the archive. So one commission was numbered `3` on
 * the felt and `1` on the wall, and either number changed the moment a
 * neighbour was added, finished or answered. A handle that moves is not a
 * handle — it says two books are the same commission, or that one commission
 * is two.
 */
test('a commission with no digits in its id keeps one mark wherever it is dealt', () => {
  const mark = (tasks, at) => B.stackBaize(tasks, BAIZE)[at].n;
  const alone = mark([task('whoosh')], 0);
  assert.equal(mark([task('T-7'), task('task-19'), task('whoosh')], 2), alone,
    'the mark changed with the book\'s place on the table');
  assert.equal(mark([task('whoosh'), task('T-7')], 0), alone,
    'the mark changed when a neighbour arrived');
  assert.equal(B.spineMark({ id: 'whoosh' }), alone,
    'the rule and the table disagree about the same commission');
  assert.notEqual(alone, 1, 'the mark is still the book\'s place, wearing another name');
});

test('a commission with no usable id at all still carries something', () => {
  // The ledger is a file edited by hand. A blank spine is worse than a mark
  // that admits it does not know, and `undefined` printed on a book is worse
  // than either.
  for (const id of ['', '---', null, undefined]) {
    const m = B.spineMark({ id });
    assert.ok(String(m).length > 0 && String(m) !== 'undefined',
      `an id of ${JSON.stringify(id)} marks a spine ${JSON.stringify(m)}`);
  }
});

// ─── In the scene ───────────────────────────────────────────────────────────

const { useStore } = loadTs('src/renderer/src/store/store.ts');
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

async function inhabit(tasks) {
  const calls = { tabs: [], opened: [] };
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    cth: { hiveTasks: async () => ({ tasks }) }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  useStore.getState().addAgent(person('w-1'));
  useStore.setState({
    requestCommandCenterTab: (tab) => calls.tabs.push(tab),
    select: () => {},
    openTaskDetail: (id) => calls.opened.push(id)
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  scenes.push(view);
  await settle();
  view.render();
  return { view, calls };
}

const booksIn = (view) => all(view.tree, (n) => n.props?.['data-baize-book'] !== undefined);

test('the commissions on the ledger are piled onto the table', async () => {
  const { view } = await inhabit([task('T-1'), task('T-2', 'doing'), task('T-3', 'blocked')]);
  const books = booksIn(view);
  assert.equal(books.length, 3, 'three commissions, three books');
  for (const c of books) {
    assert.equal(c.props.role, 'button', 'a book you cannot press is a decoration');
    assert.ok(String(c.props.title).length > 0, 'a book with no title tells you nothing');
  }
  // The number is what ties it to the board.
  assert.deepEqual(books.map((c) => text(c).join('').trim()).sort(), ['1', '2', '3']);
});

test('picking up a book opens that commission, and not the board behind it', async () => {
  const { view, calls } = await inhabit([task('T-1'), task('T-9', 'blocked')]);
  const books = booksIn(view);
  const nine = books.find((c) => text(c).join('').trim() === '9');
  assert.ok(nine, 'the ninth commission is not on the table');

  let roomFired = false;
  nine.props.onClick({ stopPropagation: () => { roomFired = true; } });

  assert.deepEqual(calls.opened, ['T-9'], 'it opened the wrong commission, or none');
  // The book sits INSIDE the card-table room, which is itself a button that
  // opens the board. Without stopPropagation a click would do both, and the
  // detail you just opened would be behind the board that opened over it.
  assert.ok(roomFired, 'the click was never stopped from reaching the room');
  assert.deepEqual(calls.tabs, [], 'the room fired as well as the book');
});

test('a book answers Enter and Space, the way the assistants cards do', async () => {
  const { view, calls } = await inhabit([task('T-4')]);
  const book = booksIn(view)[0];
  const press = (key) => {
    let stopped = false;
    book.props.onKeyDown({
      key, target: 1, currentTarget: 1,
      preventDefault: () => {}, stopPropagation: () => { stopped = true; }
    });
    return stopped;
  };
  assert.ok(press('Enter'), 'Enter did nothing');
  assert.ok(press(' '), 'Space did nothing');
  assert.deepEqual(calls.opened, ['T-4', 'T-4']);
  press('a');
  assert.equal(calls.opened.length, 2, 'any key at all opened the commission');
});

/**
 * A commission waiting on the human, marked where the commission is.
 *
 * The parlour printed the number of waiting letters on the stack of petitions
 * — which the painting puts on the right-hand bookcase, so what a reader saw
 * was a bare digit floating on a shelf of books with nothing to attach it to.
 * Aaron: *"The 3 on the right bookshelf is still there and looks out of place."*
 *
 * The number was also a second count of things already drawn: every commission
 * it counted is a book on the felt three feet away. So the count comes off the
 * shelf and the mark goes onto the spines themselves — the same lilac the
 * board's own "?" badge wears, on the head of the book that is waiting.
 */
test('a commission waiting on the human is marked on its own spine', async () => {
  const { view } = await inhabit([
    task('T-1', 'blocked', { humanQA: [{ q: 'which key?' }] }),
    task('T-2', 'blocked')
  ]);
  const books = booksIn(view);
  const marked = books.filter((b) => b.props['data-baize-petition'] !== undefined);
  assert.deepEqual(marked.map((b) => b.props['data-baize-book']), ['T-1'],
    'the waiting commission is not the marked one');
  assert.match(String(marked[0].props.title), /awaiting you/i,
    'the mark says nothing about why the book is marked');
  assert.match(String(marked[0].props.style.boxShadow), /--cth-lilac/,
    'the marked spine wears the same head as every other book');
  assert.doesNotMatch(
    String(books.find((b) => b.props['data-baize-book'] === 'T-2').props.style.boxShadow),
    /--cth-lilac/, 'a commission nobody asked about wears the petition mark');
});

/**
 * A commission can be finished and still be waiting on you, and that state has
 * nowhere else in the Study to live.
 *
 * The wall does not take it — the wall is bounded by an age window and by the
 * number of volumes the painting has, so a question shelved is a question the
 * wall can drop, and nothing on the wall says which volume is waiting on you —
 * and the board's own predicate did not even recognise it, because it asked for
 * `blocked` as well as an open question. An unanswered question is unanswered
 * whatever column the card is in, so the commission stays on the felt, marked
 * and pressable, until the question is resolved.
 */
test('a concluded commission still waiting on you keeps its place on the table', async () => {
  const { view, calls } = await inhabit([
    task('T-1', 'done', { humanQA: [{ q: 'which key?' }] })
  ]);
  const books = booksIn(view);
  assert.deepEqual(books.map((b) => b.props['data-baize-book']), ['T-1'],
    'the finished commission was shelved with its question unanswered');
  assert.equal(books[0].props['data-baize-petition'], '',
    'it is on the table unmarked, so nothing says why it is still there');
  assert.match(String(books[0].props.style.boxShadow), /--cth-lilac/);
  books[0].props.onClick({ stopPropagation: () => {} });
  assert.deepEqual(calls.opened, ['T-1'], 'the spine no longer opens its commission');
});

test('waiting on the human is an unanswered question, whatever column it is in', () => {
  const { waitsOnHuman } = loadTs('src/renderer/src/components/TasksKanban.tsx');
  const open = { q: 'which key?' };
  assert.equal(waitsOnHuman(task('T-1', 'done', { humanQA: [open] })), true);
  assert.equal(waitsOnHuman(task('T-2', 'blocked', { humanQA: [open] })), true);
  assert.equal(waitsOnHuman(task('T-3', 'doing', { humanQA: [open] })), true);
  assert.equal(waitsOnHuman(task('T-4', 'done', { humanQA: [{ q: 'q', a: 'a' }] })), false);
  assert.equal(waitsOnHuman(task('T-5', 'blocked')), false);
});

test('a concluded commission waiting on you is never crowded off the table', () => {
  // The bound is the reason this matters. Open work cut by the bound is still
  // on the board, and the table says so; a concluded commission cut by it
  // would be on NEITHER surface of the Study, because the wall will not take
  // it while the question stands. So it is dealt first, where the bound cannot
  // reach it.
  const crowd = Array.from({ length: B.BAIZE_MAX * 2 }, (_, i) => task(`T-${i}`, 'blocked'));
  const piled = B.stackBaize(
    [...crowd, task('ASK-1', 'done', { humanQA: [{ q: 'which key?' }] })], BAIZE);
  assert.equal(piled.length, B.BAIZE_MAX);
  assert.equal(piled[0].task.id, 'ASK-1',
    'a concluded commission waiting on the human was dealt behind the open work');
});

test('an answered question leaves no mark on the spine', async () => {
  const { view } = await inhabit([
    task('T-1', 'blocked', { humanQA: [{ q: 'which key?', a: 'the staging one' }] })
  ]);
  assert.equal(booksIn(view)[0].props['data-baize-petition'], undefined);
});

test('an empty ledger leaves an empty table, not an empty book', async () => {
  const { view } = await inhabit([]);
  assert.equal(booksIn(view).length, 0);
});

// ─── Readable at the size the house is actually drawn ───────────────────────

/** One colour token, resolved out of the occult stylesheet. */
const occultToken = (() => {
  const fs = require('node:fs');
  const path = require('node:path');
  const css = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/src/design/occult/occult-tokens.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return (name) => {
    const m = css.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(m, `${name} is not declared in the occult theme`);
    return m[1];
  };
})();

const luminance = (hex) => {
  const ch = (c) => (c / 255 <= 0.03928 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The card table's dealing area, in the panel's OWN pixels — which is the
 *  only frame in which "big enough to read" means anything, because the whole
 *  house is drawn at natural size and then scaled into the window as one
 *  drawing. A book measured in CSS px here is a book measured before the scale
 *  that shrinks it. */
function piledOnTheShippedTable() {
  const { loadRoomManifest, roomOfKind } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const load = loadRoomManifest();
  assert.equal(load.ok, true, 'room.json does not validate');
  const room = roomOfKind(load.manifest, 'cardTable');
  const berth = room.berths[0];
  const baize = {
    left: berth.x * room.natural.w,
    top: berth.y * room.natural.h,
    width: berth.w * room.natural.w,
    height: berth.h * room.natural.h
  };
  return B.stackBaize(Array.from({ length: B.BAIZE_MAX }, (_, i) => task(`T-${i + 1}`)), baize);
}

test('a spine is piled big enough to press once the house is scaled', () => {
  // The house is laid out at its natural size and then letterboxed into the
  // window as ONE scaled drawing, so every size inside it is divided by that
  // scale — around 0.3 on a normal window. A spine is thin by nature, and what
  // keeps it findable by a pointer through that scale is its length.
  for (const { box } of piledOnTheShippedTable()) {
    assert.ok(box.width >= 80, `a spine is ${Math.round(box.width)} panel px long`);
    assert.ok(box.height >= 14, `a spine is ${Math.round(box.height)} panel px thick`);
  }
});

test('a book lies down: every spine is far longer than it is thick', () => {
  // The whole point of the change. A commission standing on its edge is the
  // card this replaced; a book on a table is a long, thin spine.
  for (const { box } of piledOnTheShippedTable()) {
    assert.ok(box.width > box.height * 2.5,
      `a spine is ${Math.round(box.width)}×${Math.round(box.height)}, which is standing up`);
  }
});

test('the number is printed sideways on the spine, and sized from it', () => {
  // A fixed `--cth-text-display-sm` is 12px BEFORE the house scale, which is
  // about three pixels after it. Type inside the house has to be a fraction of
  // the thing it is printed on, or it does not survive the letterbox. And it is
  // turned a quarter, the way a book lying down carries its title.
  const piled = piledOnTheShippedTable();
  const { BaizeStacks } = B;
  const rendered = BaizeStacks({
    tasks: piled.map((d) => d.task),
    baize: { left: 0, top: 0, width: 600, height: 300 },
    onOpen: () => {}
  });
  const books = rendered.props.children;
  assert.ok(books.length > 0, 'nothing was piled');
  for (const book of books) {
    const spine = book.props.style;
    const number = book.props.children;
    assert.equal(number.props['data-baize-number'], '', 'the spine carries no number');
    const { fontSize, transform } = number.props.style;
    assert.equal(typeof fontSize, 'number',
      `the number is still a CSS token (${String(fontSize)}) the house scale then shrinks`);
    assert.match(String(transform), /rotate\(90deg\)/,
      'the number is printed the way a standing card prints it, not the way a book does');
    assert.ok(fontSize >= spine.height * 0.3,
      `the number is ${fontSize} on a spine ${spine.height} thick`);
  }
});

test('a long number is set smaller rather than run off its own book', () => {
  // Printed sideways, what has to fit across the thickness of a spine is the
  // number's LENGTH — so a three-figure commission cannot be set at the size a
  // one-figure one is.
  const box = { left: 0, top: 0, width: 100, height: 20 };
  const one = B.spineType(box, 7).fontSize;
  const three = B.spineType(box, 128).fontSize;
  assert.ok(three < one, 'a three-figure number is set as large as a one-figure one');
  for (const n of [7, 42, 128]) {
    const { fontSize } = B.spineType(box, n);
    assert.ok(fontSize * 0.62 * String(n).length <= box.height,
      `${n} is set at ${fontSize} and runs off a spine ${box.height} thick`);
  }
});

test('every spine is legible on its own colour', () => {
  const FACES = B.SPINE_FACES;
  assert.ok(FACES, 'the faces are not reachable to be checked');
  for (const [status, face] of Object.entries(FACES)) {
    const bg = occultToken(face.background.replace(/^var\(|\)$/g, ''));
    const fg = occultToken(face.color.replace(/^var\(|\)$/g, ''));
    assert.ok(contrast(bg, fg) >= 4.5,
      `${status} prints ${fg} on ${bg} — ${contrast(bg, fg).toFixed(2)}:1`);
  }
});

// ─── On the table, rather than in the air above it ──────────────────────────

/**
 * Whether a colour is the painted baize.
 *
 * The felt is the only green in the parlour — the walls are red, the wood is
 * brown, and the chandeliers are gold — so "greener than it is red or blue" is
 * a wide margin rather than a tuned one.
 */
const isBaize = ([r, g, b]) => g > 55 && g > r * 1.2 && g > b * 1.2;

/** The card table's dealing area in panel pixels, and the panel it is on. */
function theTable() {
  const readPng = require('./read-png.cjs');
  const path = require('node:path');
  const { loadRoomManifest, roomOfKind } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const load = loadRoomManifest();
  assert.equal(load.ok, true, 'room.json does not validate');
  const room = roomOfKind(load.manifest, 'cardTable');
  const berth = room.berths[0];
  return {
    panel: readPng(path.resolve(
      __dirname, '..', 'src/renderer/src/scene/study/assets', path.basename(room.image))),
    baize: {
      left: berth.x * room.natural.w,
      top: berth.y * room.natural.h,
      width: berth.w * room.natural.w,
      height: berth.h * room.natural.h
    }
  };
}

/**
 * The top and bottom of the painted table in one column of the panel, or null
 * where that column misses the table altogether.
 *
 * Asking whether the pixel under a card's foot is green would be the obvious
 * check and it is the wrong one: the painting has small white notes lying ON
 * the felt, so a card standing squarely on the table can have paper rather than
 * baize directly beneath it. The table's extent in that column is what "on the
 * table" actually means, and paper between its edges does not change it.
 */
function tableSpan(panel, x) {
  let top = null;
  let bottom = null;
  for (let y = 0; y < panel.height; y++) {
    if (!isBaize(panel.at(x, y))) continue;
    if (top === null) top = y;
    bottom = y;
  }
  return top === null ? null : { top, bottom };
}

test('every pile stands ON the painted table', () => {
  // A pile rests on the felt and every book above the bottom one rests on the
  // book below it, so the only foot that has to be on the table is the bottom
  // one — and it has to be on it at every count, because the piles move as the
  // group is recentred.
  const { panel, baize } = theTable();
  for (const count of [1, 3, B.STACK_HIGH + 1, B.BAIZE_MAX]) {
    const piled = B.stackBaize(
      Array.from({ length: count }, (_, i) => task(`T-${i + 1}`)), baize);
    for (const { task: t, box, level } of piled) {
      if (level !== 0) continue;
      const foot = box.top + box.height;
      // The middle of the foot, not the corners: the table is an oval and its
      // near edge is a curve, so an outermost corner hanging a few pixels over
      // the rim is a pile on a table rather than a pile off one.
      for (const at of [0.25, 0.5, 0.75]) {
        const x = box.left + box.width * at;
        const span = tableSpan(panel, x);
        assert.ok(span, `with ${count} piled, ${t.id} rests where the panel has no table at all`);
        assert.ok(foot >= span.top && foot <= span.bottom,
          `with ${count} piled, ${t.id}'s foot is at ${Math.round(foot)}, and the table in that `
          + `column runs ${span.top} to ${span.bottom} — the pile is standing off the table`);
      }
    }
  }
});
