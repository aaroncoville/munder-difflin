'use strict';
/**
 * Finished work, lit on the shelf wall.
 *
 * The shelves room is a painting of pale books, so an archived thing DARKENS
 * one of them. That is the inverse of the usual "light it up" and it is the
 * right way round here: against light books, darkening is what reads as
 * emphasis. The code says `darken` for that reason and not by accident.
 *
 * The bound is the part worth pinning hardest, because the failure mode is
 * quiet: a wall that keeps everything looks correct on the day it ships and is
 * an unreadable smear a month later.
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
  // An archived assistant carries no timestamp anywhere in the store, so there
  // is no age to test it against. Dropping it for that would mean archived
  // assistants never appeared on the wall at all — which the design asks for.
  const undated = thing('someone', null, 'assistant');
  const stale = thing('stale', NOW - (S.ARCHIVE_WINDOW_DAYS + 9) * DAY);
  assert.deepEqual(S.shelfBooks([stale, undated], NOW).map((k) => k.id), ['someone']);
  // ...but it is still bounded, or the wall fills with them.
  const crowd = Array.from({ length: S.ARCHIVE_MAX * 2 }, (_, i) => thing(`a${i}`, null, 'assistant'));
  assert.equal(S.shelfBooks(crowd, NOW).length, S.ARCHIVE_MAX);
});

test('an empty archive is an empty wall, not a crash', () => {
  assert.deepEqual(S.shelfBooks([], NOW), []);
});

test('every book lands on a shelf in the painting, and none overlap', () => {
  const view = { x: 0, y: 0, w: 800, h: 343 };
  const shelves = Array.from({ length: 10 }, (_, i) =>
    ({ x: 0.1 + (i % 4) * 0.25, y: 0.3 + Math.floor(i / 4) * 0.28 }));
  const boxes = Array.from({ length: S.ARCHIVE_MAX }, (_, i) => S.bookSlot(i, view, shelves));
  for (const b of boxes) {
    assert.ok(b.left >= 0 && b.top >= 0, 'a book is off the top or left of the panel');
    assert.ok(b.left + b.width <= view.w + 0.01, 'a book is off the right of the panel');
    assert.ok(b.top + b.height <= view.h + 0.01, 'a book is off the bottom of the panel');
    assert.ok(b.width > 0 && b.height > 0);
  }
  // The first ten sit on the ten shelf positions the painting actually has, so
  // no two of them are the same book darkened twice.
  const first = boxes.slice(0, 10).map((b) => `${Math.round(b.left)},${Math.round(b.top)}`);
  assert.equal(new Set(first).size, 10, 'two books were shelved in the same place');
});

test('a wall with no marked shelves still shelves its books', () => {
  // room.json is data and the art track revises it. A shelves room that lost
  // its light points must not take the Study down with it.
  const view = { x: 0, y: 0, w: 800, h: 343 };
  const b = S.bookSlot(3, view, []);
  assert.ok(Number.isFinite(b.left) && Number.isFinite(b.top), 'NaN geometry');
  assert.ok(b.left >= 0 && b.left + b.width <= view.w + 0.01);
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

test('a concluded commission and a departed assistant both light the shelf', async () => {
  const view = await inhabit({
    archived: [person('gone-1', { archived: true })],
    tasks: [{ id: 'T-1', status: 'done', title: 'the seventh folio', dependsOn: [],
      createdAt: new Date().toISOString() }]
  });
  const books = all(view.tree, (n) => n.props?.['data-shelf-book'] !== undefined);
  assert.equal(books.length, 2, 'the shelf shows neither the work nor the people');
  const labels = books.map((b) => String(b.props.title));
  assert.ok(labels.some((l) => /seventh folio/.test(l)), 'the commission is not named');
  assert.ok(labels.some((l) => /GONE-1/.test(l)), 'the assistant is not named');
});

test('unfinished work is not on the shelf', async () => {
  const view = await inhabit({
    tasks: [{ id: 'T-1', status: 'doing', title: 'still reading', dependsOn: [],
      createdAt: new Date().toISOString() }]
  });
  assert.equal(all(view.tree, (n) => n.props?.['data-shelf-book'] !== undefined).length, 0);
});

test('the books darken the painting rather than covering it', async () => {
  const view = await inhabit({ archived: [person('gone-1', { archived: true })] });
  const book = all(view.tree, (n) => n.props?.['data-shelf-book'] !== undefined)[0];
  assert.ok(book, 'no book');
  // A book drawn as an opaque patch would hide the painting it is meant to be
  // pointing at; multiply darkens what is already there.
  assert.equal(book.props.style.mixBlendMode, 'multiply');
});

test('the darkening is measured against the wall it actually lands on', () => {
  // The wall this was designed for was assumed to be painted PALE, and it is
  // not: room-shelves.png averages a luma of 61 out of 255, and the slots the
  // books stand in average about 95. Multiplying a dark painting by a mid-tone
  // accent moves it a few percent, which is why a marked volume was invisible
  // among the painted spines. So the assertion is not "it multiplies" — it is
  // how far the pixels under a book actually move.
  const readPng = require('./read-png.cjs');
  const fs = require('node:fs');
  const path = require('node:path');
  const at = (p) => path.resolve(__dirname, '..', p);
  const png = readPng(at('src/renderer/src/scene/study/assets/room-shelves.png'));
  const room = JSON.parse(fs.readFileSync(
    at('src/renderer/src/scene/study/assets/room.json'), 'utf8'))
    .rooms.find((r) => r.id === 'shelves');
  const css = fs.readFileSync(
    at('src/renderer/src/design/occult/occult-tokens.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const token = (name) => {
    const m = css.match(new RegExp(`${name}:\\s*#([0-9A-Fa-f]{6})`));
    assert.ok(m, `${name} is not declared in the occult theme`);
    return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  };
  const luma = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

  const src = loadTs('src/renderer/src/scene/study/ShelfArchive.tsx');
  const view = { x: 0, y: 0, w: room.natural.w, h: room.natural.h };
  const box = S.bookSlot(0, view, room.lightPoints);

  // Both kinds, because they were the two ends of the problem: the accents this
  // started on moved the slot 55% (lilac) and 40% (peach), and the peach one
  // was invisible where the lilac was merely weak.
  for (const [kind, name] of Object.entries(src.BOOK_TINT)) {
    const tint = token(name.replace(/^var\(|\)$/g, ''));
    let before = 0;
    let after = 0;
    let n = 0;
    for (let y = Math.round(box.top); y < Math.round(box.top + box.height); y++) {
      for (let x = Math.round(box.left); x < Math.round(box.left + box.width); x++) {
        const px = png.at(x, y);
        before += luma(px);
        after += luma(px.map((c, i) => (c * tint[i]) / 255));
        n++;
      }
    }
    assert.ok(n > 0, 'the book covers no pixels of the painting');
    const drop = 1 - after / before;
    assert.ok(drop >= 0.7,
      `a ${kind} volume darkens its slot by ${(drop * 100).toFixed(0)}% — `
      + 'not enough to pick out among the painted spines');
  }
});

test('a marked volume is bigger than a painted spine, and carries a gilt edge', async () => {
  // At the scale the house is drawn at, a mark 44 panel-px wide arrives about
  // ten pixels across — the same as the spines painted either side of it, so
  // it reads as one more of them. It has to be wider than they are, and it has
  // to carry something no painted spine has.
  const room = JSON.parse(require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '..',
      'src/renderer/src/scene/study/assets/room.json'), 'utf8'))
    .rooms.find((r) => r.id === 'shelves');
  const view = { x: 0, y: 0, w: room.natural.w, h: room.natural.h };
  const box = S.bookSlot(0, view, room.lightPoints);
  assert.ok(box.width >= view.w * 0.038, `a volume is ${box.width.toFixed(0)} panel px wide`);
  assert.ok(box.height >= view.h * 0.18, `a volume is ${box.height.toFixed(0)} panel px tall`);

  const scene = await inhabit({ archived: [person('gone-1', { archived: true })] });
  const gilt = all(scene.tree, (n) => n.props?.['data-shelf-gilt'] !== undefined);
  assert.equal(gilt.length, 1, 'the volume has no gilt edge of its own');
  // A SIBLING of the darkening patch, not a child of it: `mix-blend-mode` on
  // the patch makes it a blend group, so gilt drawn inside it would be
  // multiplied too — and multiply cannot lighten, so the gilt would come out
  // as one more shade of the dark it is supposed to stand against.
  assert.notEqual(gilt[0].props.style.mixBlendMode, 'multiply',
    'the gilt is inside the darkening, where it can only ever be dark');
  const book = all(scene.tree, (n) => n.props?.['data-shelf-book'] !== undefined)[0];
  assert.ok(gilt[0].props.style.width >= book.props.style.width * 0.15,
    'the gilt edge is a hairline the house scale erases');
});
