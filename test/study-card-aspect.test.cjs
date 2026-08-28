'use strict';
/**
 * A portrait card is cut to the proportion of the portrait in it.
 *
 * The card's box came out of the berth: 62% of the place setting across by the
 * whole of it down, and a place setting is much wider than it is tall, so the
 * card was LANDSCAPE — about 1.2 wide for every 1 tall. The portraits are
 * painted 5:6 the other way. `object-fit: cover` then did what it is for and
 * cropped a horizontal band out of the middle of every face, which is what
 * makes the cards on the floor look squashed and stretched: the frame is the
 * wrong shape, and the painting is being trimmed to fit it.
 *
 * Both halves are held here — the proportion the frame is cut to, and the fact
 * that it is the proportion the shipped art is actually painted at, because a
 * constant that agrees with nothing on disk is a number somebody typed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const { AgentCard, PORTRAIT_ASPECT, CARD_ASPECT } =
  loadTs('src/renderer/src/scene/study/AgentCard.tsx');
const { deskLayout } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');

const PORTRAITS = path.resolve(
  __dirname, '..', 'src/renderer/src/scene/study/assets/portraits');

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};

test('the proportion the cards are cut to is the one the portraits are painted at', () => {
  const files = fs.readdirSync(PORTRAITS).filter((f) => f.endsWith('.png'));
  assert.ok(files.length > 20, 'the portrait pack is on disk');
  let agreeing = 0;
  for (const file of files) {
    const head = fs.readFileSync(path.join(PORTRAITS, file)).subarray(0, 24);
    const aspect = head.readUInt32BE(16) / head.readUInt32BE(20);
    if (Math.abs(aspect - PORTRAIT_ASPECT) < 0.02) agreeing++;
  }
  assert.ok(agreeing / files.length > 0.9,
    `only ${agreeing} of ${files.length} portraits are painted at ${PORTRAIT_ASPECT}, `
    + 'so that is not the pack’s proportion');
});

test('a card is taller than it is wide, whatever shape its berth is', () => {
  assert.ok(CARD_ASPECT < 1, 'the card is cut wider than it is tall');
  // Every place setting in the house is much wider than it is tall, and one of
  // them is nearly twice as wide again as another — so a card taking a fixed
  // share of the setting takes a different SHAPE in each room. It must not.
  for (const desk of [
    { left: 0, top: 0, width: 470, height: 309 },
    { left: 0, top: 0, width: 376, height: 309 },
    { left: 0, top: 0, width: 502, height: 336 }
  ]) {
    const { card } = deskLayout(desk);
    assert.ok(Math.abs(card.width / card.height - CARD_ASPECT) < 0.01,
      `a ${desk.width}×${desk.height} setting cuts a card `
      + `${(card.width / card.height).toFixed(2)} wide for every 1 tall`);
    assert.ok(card.left >= desk.left && card.left + card.width <= desk.left + desk.width,
      'the card hangs off the place setting');
  }
});

test('the portrait frame keeps the portrait’s own proportion', () => {
  // Sizing the CARD right is not enough on its own: the frame inside it is what
  // the image is cropped to, and the caption under the name eats into the card's
  // height, so a frame told only to fill what is left is a different shape again.
  const inst = mount(AgentCard, {
    name: 'Pam', role: 'clerk', status: 'idle',
    box: { left: 0, top: 0, width: 120, height: 200 }, portraitSrc: '/p/pam.png'
  });
  const img = find(inst.tree, (n) => n.type === 'img');
  assert.ok(img, 'the portrait is rendered');
  const frame = find(inst.tree, (n) => n.props?.style?.aspectRatio !== undefined);
  assert.ok(frame, 'nothing in the card holds the portrait to a proportion');
  const [w, h] = String(frame.props.style.aspectRatio).split('/').map(Number);
  assert.ok(w > 0 && h > 0, `the frame's aspect ratio is ${frame.props.style.aspectRatio}`);
  assert.ok(Math.abs(w / h - PORTRAIT_ASPECT) < 0.001,
    `the frame is cut ${(w / h).toFixed(3)} where the portraits are ${PORTRAIT_ASPECT}`);
});
