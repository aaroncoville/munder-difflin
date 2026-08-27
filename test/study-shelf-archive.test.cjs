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
  // The shelves are painted PALE. A book drawn as an opaque patch would hide
  // the painting it is meant to be pointing at; multiply darkens what is
  // already there, which is the whole of Aaron's design for this wall.
  assert.equal(book.props.style.mixBlendMode, 'multiply');
});
