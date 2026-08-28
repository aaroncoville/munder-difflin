'use strict';
/**
 * The book on a working assistant's desk is alive, and it is a door.
 *
 * Two properties, and they are separate things. A book whose pages TURN says
 * from across the room that this desk is the one where that commission is
 * being worked — which is the only signal in the house that says so without
 * text. A book that OPENS its commission is the same control the card table's
 * spines and the shelf wall's volumes already are, and a house where two of
 * the three surfaces that draw a commission can be pressed and the third
 * cannot is a house that teaches the wrong lesson about which marks are live.
 *
 * Turning is for work IN HAND only. A commission waiting its turn and a
 * commission that is stuck are both books nobody is reading, and animating
 * them would say the opposite of what they mean.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};
const all = (n, pred, out = []) => {
  if (!n || typeof n !== 'object') return out;
  if (pred(n)) out.push(n);
  for (const k of [].concat(n.props?.children ?? [])) all(k, pred, out);
  return out;
};
const box = { left: 0, top: 0, width: 40, height: 30 };
const root = (inst) => find(inst.tree, (n) => n.props?.['data-book-state'] !== undefined);
/** Everything the component's own <style> block ships, as one string. */
const sheet = (inst) =>
  all(inst.tree, (n) => n.type === 'style').map((n) => String(n.props.children)).join('\n');

test('only the book of work in hand turns its pages', () => {
  const open = mount(DeskBook, { state: 'open', box });
  const leaf = find(open.tree, (n) => n.props?.['data-book-leaf'] !== undefined);
  assert.ok(leaf, 'an open book has a leaf being turned');
  assert.match(String(leaf.props.style.animation), /\S/, 'the leaf is animated');
  assert.match(String(leaf.props.style.animation), /infinite/,
    'the pages keep turning for as long as the work is in hand');

  for (const state of ['closed', 'sealed']) {
    const shut = mount(DeskBook, { state, box });
    assert.equal(find(shut.tree, (n) => n.props?.['data-book-leaf'] !== undefined), undefined,
      `a ${state} book turns no pages — nobody is reading it`);
  }
});

test('the turning leaf is driven by a keyframe the book itself ships', () => {
  const open = mount(DeskBook, { state: 'open', box });
  const leaf = find(open.tree, (n) => n.props?.['data-book-leaf'] !== undefined);
  const name = String(leaf.props.style.animation).trim().split(/\s+/)[0];
  assert.ok(name, 'the animation names a keyframe');
  // The keyframe has to be DEFINED, not merely referenced: a name with no
  // @keyframes behind it is a page that never moves and a test that never
  // notices.
  assert.match(sheet(open), new RegExp(`@keyframes\\s+${name}\\s*\\{`),
    `${name} is defined in the book's own stylesheet`);
});

test('a machine asking for less movement gets a book that lies still', () => {
  const open = mount(DeskBook, { state: 'open', box });
  const leaf = find(open.tree, (n) => n.props?.['data-book-leaf'] !== undefined);
  const cls = String(leaf.props.className || '').trim().split(/\s+/).filter(Boolean);
  assert.ok(cls.length, 'the leaf carries a class the stylesheet can reach');
  const reduce = sheet(open).match(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\n\s*\}/);
  assert.ok(reduce, 'the book answers prefers-reduced-motion itself');
  // Reached by the class the leaf ACTUALLY wears, so renaming the class
  // without renaming it in the rule fails here rather than in somebody's eye.
  assert.ok(cls.some((c) => reduce[0].includes(`.${c}`)),
    `the rule reaches the leaf's own class (${cls.join(' ')})`);
  assert.match(reduce[0], /animation:\s*none/, 'and it stops the animation outright');
});

test('a book that stands for a commission opens it, by pointer and by key', () => {
  const opened = [];
  const inst = mount(DeskBook, {
    state: 'open', box, taskId: 'T-9', title: 'Port the loader', onOpen: (id) => opened.push(id)
  });
  const el = root(inst);
  assert.equal(el.props.role, 'button', 'it announces itself as a control');
  assert.equal(el.props.tabIndex, 0, 'and the keyboard can reach it');
  assert.equal(el.props['aria-label'], 'Port the loader');

  let stopped = false;
  el.props.onClick({ stopPropagation: () => { stopped = true; } });
  assert.deepEqual(opened, ['T-9']);
  assert.ok(stopped, 'the room underneath does not also answer the click');

  const press = (key, target) => {
    const ev = {
      key,
      target: target ?? el,
      currentTarget: el,
      prevented: false,
      preventDefault() { ev.prevented = true; },
      stopPropagation() {}
    };
    el.props.onKeyDown(ev);
    return ev;
  };
  assert.ok(press('Enter').prevented, 'Enter opens it');
  assert.ok(press(' ').prevented, 'Space opens it');
  assert.deepEqual(opened, ['T-9', 'T-9', 'T-9']);
  assert.equal(press('a').prevented, false, 'and nothing else does');
  // A key pressed on something INSIDE the book is not a press of the book —
  // the same guard the card-table spines and the shelf's volumes use.
  assert.equal(press('Enter', {}).prevented, false);
  assert.deepEqual(opened, ['T-9', 'T-9', 'T-9']);
});

test('a book that stands for nothing does not claim to be a control', () => {
  const inst = mount(DeskBook, { state: 'closed', box, title: 'Port the loader' });
  const el = root(inst);
  assert.equal(el.props.role, undefined, 'no button semantics without a destination');
  assert.equal(el.props.tabIndex, undefined, 'and no tab stop that does nothing');
  assert.equal(el.props.onClick, undefined);
  // Its tooltip survives: the book still says what it is, it just leads nowhere.
  assert.equal(el.props.title, 'Port the loader');
});

test('a book with a commission and no way to open it stays inert', () => {
  // `onOpen` is what the scene supplies; a book rendered without one — a
  // preview, a test, a surface that has no task detail — must not offer a
  // press that goes nowhere.
  const el = root(mount(DeskBook, { state: 'open', box, taskId: 'T-9' }));
  assert.equal(el.props.role, undefined);
  assert.equal(el.props.tabIndex, undefined);
});

// ─── Wired to the house ─────────────────────────────────────────────────────
// The component above is only half the property. What makes the desk book an
// at-a-glance signal is that the house hands it the commission its assistant is
// actually working, and the same door the other two surfaces open.

const { useStore } = loadTs('src/renderer/src/store/store.ts');
const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';

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
const person = (id, over = {}) => ({
  id, name: id.toUpperCase(), character: 'jim', accent: 'sky', description: '',
  project: 'p', tmuxTarget: '', cwd: '/tmp', status: 'idle', action: '', progress: 0, ...over
});

const scenes = [];
test.after(() => { for (const s of scenes) for (const c of s.cleanups ?? []) c?.(); });

async function inhabit({ agents = [], tasks = [] }) {
  const opened = [];
  global.window = {
    localStorage: { getItem: () => 'occult', setItem: () => {}, removeItem: () => {} },
    close: () => {},
    cth: { hiveTasks: async () => ({ tasks }), requestQuit: async () => {} }
  };
  global.document = { documentElement: { dataset: {} } };
  useStore.setState({ agents: [], archivedAgents: [], restorableAgents: [] });
  for (const a of agents) useStore.getState().addAgent(a);
  useStore.setState({
    requestCommandCenterTab: () => {}, select: () => {},
    openTaskDetail: (id) => opened.push(id)
  });
  const { StudyScene } = loadTs(SCENE);
  const view = mount(StudyScene, {});
  scenes.push(view);
  await settle();
  view.render();
  return { view, opened };
}

test('the book at a desk opens the very commission that desk is working', async () => {
  const { view, opened } = await inhabit({
    agents: [person('w-1', { status: 'working' })],
    tasks: [
      { id: 'T-77', assignee: 'w-1', status: 'doing', title: 'Port the loader', dependsOn: [] },
      { id: 'T-78', assignee: 'w-2', status: 'doing', title: "somebody else's", dependsOn: [] }
    ]
  });
  const books = deep(view.tree, (n) => n.props?.['data-book-state'] !== undefined);
  assert.equal(books.length, 1, 'one desk, one book');
  assert.equal(books[0].props['data-book-state'], 'open');
  books[0].props.onClick({ stopPropagation: () => {} });
  assert.deepEqual(opened, ['T-77'],
    'and it is the commission on that desk, not merely some commission');
});
