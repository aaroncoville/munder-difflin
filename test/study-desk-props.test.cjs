'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { DeskBook } = loadTs('src/renderer/src/scene/study/DeskBook.tsx');
const { SpeechScroll } = loadTs('src/renderer/src/scene/study/SpeechScroll.tsx');

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
const bookBox = { left: 0, top: 0, width: 40, height: 30 };

test('each book state is drawn differently', () => {
  const shapes = new Set();
  for (const state of ['closed', 'open', 'sealed']) {
    const inst = mount(DeskBook, { state, box: bookBox });
    const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
    assert.ok(root, `${state} book has a positioned root`);
    assert.equal(root.props['data-book-state'], state, 'state is on the element');
    // The whole subtree, minus the state attribute itself — two states that
    // differ only by a data attribute look identical to the user.
    shapes.add(JSON.stringify(inst.tree).split(`"data-book-state":"${state}"`).join(''));
  }
  assert.equal(shapes.size, 3, 'closed, open and sealed are visually distinct');
});

test('an open book shows two pages, a closed one shows a spine', () => {
  const open = mount(DeskBook, { state: 'open', box: bookBox });
  assert.equal(all(open.tree, (n) => n.props?.['data-book-page'] !== undefined).length, 2,
    'two pages');
  // Sealed is a CLOSED book with a ribbon across it — work that is impeded is
  // work nobody is reading. Drawing it with its pages open says the opposite.
  for (const shut of ['closed', 'sealed']) {
    const inst = mount(DeskBook, { state: shut, box: bookBox });
    assert.equal(all(inst.tree, (n) => n.props?.['data-book-page'] !== undefined).length, 0,
      `a ${shut} book shows no pages`);
    assert.ok(find(inst.tree, (n) => n.props?.['data-book-spine'] !== undefined),
      `a ${shut} book shows its spine`);
  }
});

test('a sealed book shows its ribbon', () => {
  const inst = mount(DeskBook, { state: 'sealed', box: bookBox });
  assert.ok(find(inst.tree, (n) => n.props?.['data-book-ribbon'] !== undefined), 'ribbon');
  for (const state of ['closed', 'open']) {
    const other = mount(DeskBook, { state, box: bookBox });
    assert.equal(find(other.tree, (n) => n.props?.['data-book-ribbon'] !== undefined), undefined,
      `no ribbon on a ${state} book`);
  }
});

test('the book title is its tooltip, and the book is drawn from tokens alone', () => {
  const inst = mount(DeskBook, { state: 'open', title: 'Port the loader', box: bookBox });
  const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
  assert.equal(root.props.title, 'Port the loader');
  // Every state, not just one: the parts that only appear on a sealed book are
  // exactly the parts a token audit of the open one cannot see.
  for (const state of ['closed', 'open', 'sealed']) {
    const one = mount(DeskBook, { state, box: bookBox });
    // No images: the book is CSS shapes, so it recolours with the theme.
    assert.equal(find(one.tree, (n) => n.type === 'img'), undefined, `${state}: no image`);
    const literal = JSON.stringify(one.tree).match(/"(background|color|boxShadow)":"(?!var\()[^"]*"/);
    assert.equal(literal, null, `${state}: colour outside the token system: ${literal && literal[0]}`);
  }
});

test('an untitled book has no empty tooltip', () => {
  const inst = mount(DeskBook, { state: 'closed', box: bookBox });
  const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
  assert.equal(root.props.title, undefined);
});

test('an empty speech scroll renders nothing', () => {
  assert.equal(mount(SpeechScroll, { text: '', box: { left: 0, top: 0, width: 100 } }).tree, null);
  assert.equal(mount(SpeechScroll, { text: '   ', box: { left: 0, top: 0, width: 100 } }).tree, null);
});

test('a speech scroll is parchment, capped, and shows its text', () => {
  const inst = mount(SpeechScroll, {
    text: 'Reading the seventh folio.', box: { left: 12, top: 34, width: 120 }
  });
  const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
  assert.ok(root, 'positioned root');
  assert.equal(root.props.style.left, 12);
  assert.equal(root.props.style.width, 120);
  assert.match(String(root.props.style.background), /var\(--cth-cream-50\)/);
  assert.match(String(root.props.style.fontFamily), /var\(--cth-font-ui\)/);
  assert.equal(root.props.style.overflow, 'hidden');
  assert.ok(root.props.style.maxHeight, 'a long thought cannot grow over the room');
  assert.match(text(inst.tree).join(' '), /Reading the seventh folio\./);
});

test('a speech scroll never eats a click meant for the card beneath it', () => {
  const inst = mount(SpeechScroll, { text: 'hm', box: { left: 0, top: 0, width: 100 } });
  const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
  assert.equal(root.props.style.pointerEvents, 'none');
});
