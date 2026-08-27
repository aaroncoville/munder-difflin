'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { mount, text } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { AgentCard } = loadTs('src/renderer/src/scene/study/AgentCard.tsx');

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};
const box = { left: 10, top: 20, width: 80, height: 110 };

test('the card sits at its box and glides via the motion token', () => {
  const inst = mount(AgentCard, { name: 'Pam', status: 'working', box });
  const root = find(inst.tree, (n) => n.props?.style?.position === 'absolute');
  assert.ok(root, 'absolutely positioned root');
  assert.equal(root.props.style.left, 10);
  assert.equal(root.props.style.top, 20);
  assert.equal(root.props.style.width, 80);
  // Both axes, not just one: a card that reseats across the room moves in x AND
  // y, and a transition on `left` alone makes it jump vertically while sliding
  // horizontally. Assert the pair, or half the glide can be deleted in silence.
  for (const axis of ['left', 'top']) {
    assert.match(String(root.props.style.transition),
      new RegExp(`${axis} var\\(--cth-dur-slow\\) var\\(--cth-ease-glide\\)`),
      `${axis} glides on the motion tokens`);
  }
  // The frame is gilt and the ground is paper — both from tokens, never literals.
  assert.match(String(root.props.style.boxShadow), /var\(--cth-/);
  assert.match(String(root.props.style.background), /var\(--cth-/);
});

test('no portrait means a monogram, never a broken image', () => {
  const inst = mount(AgentCard, { name: 'Pam', status: 'idle', box });
  assert.equal(find(inst.tree, (n) => n.type === 'img'), undefined);
  assert.ok(find(inst.tree, (n) => n.props?.children === 'P'), 'monogram letter');
});

test('a portrait replaces the monogram', () => {
  const inst = mount(AgentCard, { name: 'Pam', status: 'idle', box, portraitSrc: '/p/pam.png' });
  const img = find(inst.tree, (n) => n.type === 'img');
  assert.ok(img, 'portrait rendered');
  assert.equal(img.props.src, '/p/pam.png');
  assert.equal(img.props.style.objectFit, 'cover');
  assert.equal(find(inst.tree, (n) => n.props?.children === 'P'), undefined, 'no monogram beside it');
});

test('an unnamed agent still gets a monogram rather than an empty frame', () => {
  const inst = mount(AgentCard, { name: '   ', status: 'idle', box });
  assert.ok(find(inst.tree, (n) => n.props?.children === '?'), 'fallback monogram');
});

test('every status paints its own dot and names itself', () => {
  const seen = new Set();
  for (const status of ['idle', 'working', 'blocked', 'archived']) {
    const inst = mount(AgentCard, { name: 'Pam', status, box });
    const dot = find(inst.tree, (n) => n.props?.title === status);
    assert.ok(dot, `status element for ${status}`);
    const color = String(dot.props.style.background);
    assert.match(color, /var\(--cth-/, `${status} colour comes from a token`);
    seen.add(color);
  }
  assert.equal(seen.size, 4, 'the four statuses are visually distinct');
});

test('the name and role are on the plaque, in the display face', () => {
  const inst = mount(AgentCard, { name: 'Pam', role: 'Receptionist', status: 'idle', box });
  // The element that actually carries the name is the one that has to be set
  // in the display face — a monogram in the right font proves nothing about it.
  const plaque = find(inst.tree, (n) => n.props?.children === 'Pam');
  assert.ok(plaque, 'the name is rendered');
  assert.match(String(plaque.props.style.fontFamily), /var\(--cth-font-display\)/);
  assert.match(String(plaque.props.style.fontSize), /var\(--cth-text-display-sm\)/);
  assert.match(text(inst.tree).join(' '), /Receptionist/);
});

test('a clickable card is reachable by keyboard, an inert one is not', () => {
  let clicks = 0;
  const live = mount(AgentCard, { name: 'Pam', status: 'idle', box, onClick: () => { clicks++; } });
  const btn = find(live.tree, (n) => n.props?.role === 'button');
  assert.ok(btn, 'exposed as a button');
  assert.equal(btn.props.tabIndex, 0, 'focusable');
  btn.props.onClick();
  assert.equal(clicks, 1, 'the handler is actually wired');

  const inert = mount(AgentCard, { name: 'Pam', status: 'idle', box });
  assert.equal(find(inert.tree, (n) => n.props?.role === 'button'), undefined,
    'no button semantics without a handler');
});

test('an archived card recedes instead of disappearing', () => {
  const live = mount(AgentCard, { name: 'Pam', status: 'idle', box });
  const gone = mount(AgentCard, { name: 'Pam', status: 'archived', box });
  const rootOf = (i) => find(i.tree, (n) => n.props?.style?.position === 'absolute');
  assert.ok(Number(rootOf(gone).props.style.opacity) < Number(rootOf(live).props.style.opacity ?? 1),
    'archived is dimmer than live');
});
