'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

const SCENE = 'src/renderer/src/scene/study/StudyScene.tsx';
const ASSETS = path.resolve(__dirname, '..', 'src/renderer/src/scene/study/assets');

const seedDom = () => {
  global.window = { localStorage: { getItem: () => 'occult', setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
};

test('berthToBox letterboxes correctly', () => {
  const { berthToBox } = loadTs(SCENE);
  // 2:1 backdrop contain-fit inside a 1000x1000 container -> view 1000x500 at y=250
  const view = { x: 0, y: 250, w: 1000, h: 500 };
  assert.deepEqual(
    berthToBox({ id: 'd', x: 0.5, y: 0.5, w: 0.1, h: 0.2 }, view),
    { left: 500, top: 500, width: 100, height: 100 }
  );
});

test('containFit letterboxes on the constraining axis', () => {
  const { containFit } = loadTs(SCENE);
  // A 2:1 image in a square container is limited by width: full width, centred.
  assert.deepEqual(containFit({ w: 1000, h: 1000 }, { w: 200, h: 100 }),
    { x: 0, y: 250, w: 1000, h: 500 });
  // The same image in a very wide container is limited by height: pillarboxed.
  assert.deepEqual(containFit({ w: 1000, h: 200 }, { w: 200, h: 100 }),
    { x: 300, y: 0, w: 400, h: 200 });
  // A zero-sized container (mounted but not laid out yet) must not divide by zero.
  const degenerate = containFit({ w: 0, h: 0 }, { w: 200, h: 100 });
  for (const v of Object.values(degenerate)) assert.ok(Number.isFinite(v), 'finite view box');
});

test('the scene stacks backdrop, ambiance slot, card layer in order', () => {
  seedDom();
  const { StudyScene } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  const layers = JSON.stringify(inst.tree);
  const iBackdrop = layers.indexOf('backdrop');
  const iAmbiance = layers.indexOf('data-study-slot');
  const iCards = layers.indexOf('data-study-layer');
  assert.ok(iBackdrop >= 0, 'backdrop present');
  assert.ok(iBackdrop < iAmbiance, 'backdrop below the ambiance slot');
  assert.ok(iAmbiance < iCards, 'ambiance slot below the card layer');
});

test('the ambiance slot is reserved and empty, and never eats a click', () => {
  seedDom();
  const { StudyScene } = loadTs(SCENE);
  const inst = mount(StudyScene, {});
  const find = (n) => {
    if (!n || typeof n !== 'object') return undefined;
    if (n.props?.['data-study-slot'] === 'ambiance') return n;
    for (const k of [].concat(n.props?.children ?? [])) { const h = find(k); if (h) return h; }
    return undefined;
  };
  const slot = find(inst.tree);
  assert.ok(slot, 'ambiance slot rendered');
  assert.equal(slot.props.children, undefined, 'nothing mounted in it yet');
  assert.equal(slot.props.style.pointerEvents, 'none', 'input belongs to the DOM layer');
});

test('the shipped backdrop exists and matches what the manifest declares', () => {
  const { loadRoomManifest } = loadTs('src/renderer/src/scene/study/roomManifest.ts');
  const declared = loadRoomManifest().backdrop;
  const file = path.resolve(ASSETS, declared);
  assert.ok(fs.existsSync(file), `manifest backdrop ${declared} is on disk`);
  // The scene must render the file the manifest names — not some other import
  // that happens to be lying around.
  const { BACKDROP_SRC, BACKDROP_NATURAL } = loadTs(SCENE);
  assert.equal(path.basename(BACKDROP_SRC), path.basename(declared));
  // A real PNG, at the aspect the berth coordinates were authored against.
  const head = fs.readFileSync(file).subarray(0, 24);
  assert.equal(head.subarray(1, 4).toString('latin1'), 'PNG', 'PNG signature');
  assert.equal(head.readUInt32BE(16), BACKDROP_NATURAL.w, 'declared width matches the file');
  assert.equal(head.readUInt32BE(20), BACKDROP_NATURAL.h, 'declared height matches the file');
});
