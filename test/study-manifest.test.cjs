'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const MANIFEST = 'src/renderer/src/scene/study/roomManifest.ts';

test('the shipped room manifest is valid and complete', () => {
  const { loadRoomManifest } = loadTs(MANIFEST);
  const room = loadRoomManifest();
  assert.ok(room.deskBerths.length >= 6, 'at least six desks');
  const ids = new Set(room.deskBerths.map((b) => b.id));
  assert.equal(ids.size, room.deskBerths.length, 'berth ids unique');
  for (const b of [...room.deskBerths, room.godBerth, ...Object.values(room.anchors)]) {
    for (const k of ['x', 'y', 'w', 'h']) {
      assert.ok(b[k] >= 0 && b[k] <= 1, `${b.id ?? 'anchor'}.${k} normalized`);
    }
    assert.ok(b.x + b.w <= 1 && b.y + b.h <= 1, `${b.id} stays inside the backdrop`);
  }
  assert.ok(typeof room.backdrop === 'string' && room.backdrop.length > 0, 'backdrop path');
  assert.ok(Array.isArray(room.lightPoints), 'light points present');
  for (const p of room.lightPoints) {
    assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, 'light point normalized');
  }
});

test('every anchor the scene needs is named in the shipped manifest', () => {
  const { loadRoomManifest } = loadTs(MANIFEST);
  const room = loadRoomManifest();
  for (const key of ['cardTable', 'writingDesk', 'almanac', 'hearth', 'shelves']) {
    assert.ok(room.anchors[key], `anchor ${key}`);
  }
});

test('a manifest missing an anchor is rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  assert.throws(
    () => validateRoomManifest({ backdrop: 'x', deskBerths: [], godBerth: null, anchors: {} }),
    /godBerth|anchors/
  );
});

test('a berth hanging off the edge of the backdrop is rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const base = {
    backdrop: 'x',
    deskBerths: [{ id: 'd1', x: 0.95, y: 0.1, w: 0.2, h: 0.1 }],
    godBerth: { id: 'god', x: 0.4, y: 0.8, w: 0.1, h: 0.1 },
    anchors: {
      cardTable: { id: 'cardTable', x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
      writingDesk: { id: 'writingDesk', x: 0.2, y: 0.1, w: 0.1, h: 0.1 },
      almanac: { id: 'almanac', x: 0.3, y: 0.1, w: 0.1, h: 0.1 },
      hearth: { id: 'hearth', x: 0.4, y: 0.1, w: 0.1, h: 0.1 },
      shelves: { id: 'shelves', x: 0.5, y: 0.1, w: 0.1, h: 0.1 }
    },
    lightPoints: []
  };
  assert.throws(() => validateRoomManifest(base), /d1/);
});

test('duplicate desk berth ids are rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const berth = (id, x) => ({ id, x, y: 0.5, w: 0.05, h: 0.05 });
  assert.throws(() => validateRoomManifest({
    backdrop: 'x',
    deskBerths: [berth('d1', 0.1), berth('d1', 0.2)],
    godBerth: berth('god', 0.3),
    anchors: {
      cardTable: berth('cardTable', 0.1), writingDesk: berth('writingDesk', 0.2),
      almanac: berth('almanac', 0.3), hearth: berth('hearth', 0.4), shelves: berth('shelves', 0.5)
    },
    lightPoints: []
  }), /duplicate/i);
});
