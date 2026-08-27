'use strict';

/**
 * The Study's floor plan is a house of rooms, not one painting.
 *
 * Each room is its own panel with its own art and its own berths, normalized
 * WITHIN that panel — so a berth is checked against the room it belongs to, and
 * an id is checked across the whole house. Those two scopes are the point: the
 * per-room check catches a coordinate authored against the wrong panel, and the
 * house-wide one catches two rooms claiming the same assistant.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const MANIFEST = 'src/renderer/src/scene/study/roomManifest.ts';

/** Every kind that has to be in the house exactly once. */
const ANCHOR_KINDS = ['cardTable', 'writingDesk', 'almanac', 'hearth', 'shelves'];

const berth = (id, over = {}) => ({ id, x: 0.2, y: 0.2, w: 0.4, h: 0.4, ...over });

/** A minimal house that validates, for the rejection cases to spoil one field of. */
const house = (over = {}) => ({
  bandThickness: 8,
  rooms: [
    { id: 'r-desk', kind: 'desk', image: './d.png', natural: { w: 100, h: 100 }, row: 0, col: 0,
      berths: [berth('b-1')] },
    { id: 'r-god', kind: 'godStudy', image: './g.png', natural: { w: 100, h: 100 }, row: 1, col: 0,
      berths: [berth('god')] },
    ...ANCHOR_KINDS.map((kind, i) => ({
      id: `r-${kind}`, kind, image: `./${kind}.png`, natural: { w: 100, h: 100 },
      row: 2, col: i, berths: []
    }))
  ],
  ...over
});

/** The shipped floor plan, or a failure naming why it would not load. */
function shippedHouse() {
  const { loadRoomManifest } = loadTs(MANIFEST);
  const load = loadRoomManifest();
  assert.equal(load.ok, true, load.ok ? '' : `room.json does not validate: ${load.error}`);
  return load.manifest;
}

test('the shipped house is valid and complete', () => {
  const { deskBerths, deskRooms } = loadTs(MANIFEST);
  const room = shippedHouse();
  assert.ok(room.rooms.length >= 8, 'a house of rooms');
  assert.ok(deskRooms(room).length >= 1, 'somewhere to read');
  // What the house owes the seating is DESKS, not rooms: a painted reading
  // room holds more than one, so counting rooms would pass a house with six
  // empty ones and fail a house with three that seat eight.
  assert.ok(deskBerths(room).length >= 6, 'at least six reading desks');
  assert.ok(room.bandThickness > 0, 'the masonry between rows has a thickness');

  const roomIds = new Set(room.rooms.map((r) => r.id));
  assert.equal(roomIds.size, room.rooms.length, 'room ids unique');

  const berthIds = new Set();
  for (const r of room.rooms) {
    assert.ok(typeof r.image === 'string' && r.image.length > 0, `${r.id} names a panel image`);
    assert.ok(r.natural.w > 0 && r.natural.h > 0, `${r.id} has a natural size`);
    assert.ok(Number.isInteger(r.row) && r.row >= 0, `${r.id} sits on a row`);
    assert.ok(Number.isInteger(r.col) && r.col >= 0, `${r.id} sits in a column`);
    for (const b of r.berths) {
      assert.equal(berthIds.has(b.id), false, `${b.id} is claimed by one room only`);
      berthIds.add(b.id);
      for (const k of ['x', 'y', 'w', 'h']) {
        assert.ok(b[k] >= 0 && b[k] <= 1, `${b.id}.${k} normalized to its own panel`);
      }
      assert.ok(b.x + b.w <= 1 && b.y + b.h <= 1, `${b.id} stays inside ${r.id}`);
    }
    for (const p of r.lightPoints) {
      assert.ok(p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1, `${r.id} light point normalized`);
    }
  }
});

test('every anchor the scene needs stands in the house exactly once', () => {
  // Once, but not necessarily as a room: an anchor is either a room of its own
  // kind or a prop inside somebody else's, and the scene navigates from it
  // either way. Two of one, or none, is a plan the scene cannot draw.
  const rooms = shippedHouse().rooms;
  for (const kind of ANCHOR_KINDS) {
    const standing = rooms.filter((r) => r.kind === kind).length
      + rooms.reduce((n, r) => n + r.props.filter((p) => p.kind === kind).length, 0);
    assert.equal(standing, 1, `one ${kind}, as a room or as a prop`);
  }
  assert.equal(rooms.filter((r) => r.kind === 'godStudy').length, 1, "one god's study");
});

test('the reading desks are the berths of the desk rooms, in manifest order', () => {
  const { loadRoomManifest, deskBerths, deskRooms } = loadTs(MANIFEST);
  const room = shippedHouse();
  assert.deepEqual(
    deskBerths(room).map((b) => b.id),
    deskRooms(room).flatMap((r) => r.berths.map((b) => b.id)),
    'seating order is the order the rooms are authored in'
  );
  assert.ok(deskBerths(room).length >= 6, 'six assistants can sit down');
});

test("the god's berth comes from the god's study, not from a reading room", () => {
  const { loadRoomManifest, godBerth, deskBerths } = loadTs(MANIFEST);
  const room = shippedHouse();
  const god = godBerth(room);
  const study = room.rooms.find((r) => r.kind === 'godStudy');
  assert.ok(study.berths.some((b) => b.id === god.id), "the god sits in the god's study");
  assert.equal(deskBerths(room).some((b) => b.id === god.id), false,
    'and does not consume a reading desk');
});

test('the house reads top to bottom, and each row left to right', () => {
  const { loadRoomManifest, houseRows } = loadTs(MANIFEST);
  const rows = houseRows(shippedHouse());
  assert.ok(rows.length >= 2, 'more than one storey');
  let previous = -1;
  for (const row of rows) {
    assert.ok(row.length > 0, 'no empty storey');
    assert.ok(row[0].row > previous, 'rows ascend');
    previous = row[0].row;
    for (const r of row) assert.equal(r.row, previous, 'one row per storey');
    const cols = row.map((r) => r.col);
    assert.deepEqual(cols, [...cols].sort((a, b) => a - b), 'columns ascend');
  }
  const placed = rows.flat().length;
  assert.equal(placed, shippedHouse().rooms.length, 'every room is placed');
});

test('a house missing an anchor room is rejected, naming the kind', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const short = house();
  short.rooms = short.rooms.filter((r) => r.kind !== 'hearth');
  assert.throws(() => validateRoomManifest(short), /hearth/);
});

test('a house with no reading room is rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const short = house();
  short.rooms = short.rooms.filter((r) => r.kind !== 'desk');
  assert.throws(() => validateRoomManifest(short), /desk/);
});

test('a berth hanging off the edge of its own panel is rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const spoilt = house();
  spoilt.rooms[0].berths = [berth('b-1', { x: 0.95, w: 0.2 })];
  assert.throws(() => validateRoomManifest(spoilt), /b-1/);
});

test('two rooms claiming the same berth id are rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const spoilt = house();
  // Deliberately in DIFFERENT rooms: a per-room uniqueness check would pass
  // this and leave two panels drawing the same assistant.
  spoilt.rooms[0].berths = [berth('twice')];
  spoilt.rooms[1].berths = [berth('twice'), berth('god')];
  assert.throws(() => validateRoomManifest(spoilt), /duplicate.*twice/i);
});

test('a room of an unknown kind is rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const spoilt = house();
  spoilt.rooms[0].kind = 'wine-cellar';
  assert.throws(() => validateRoomManifest(spoilt), /wine-cellar/);
});

test('two rooms standing on the same spot are rejected', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const spoilt = house();
  spoilt.rooms[1].row = spoilt.rooms[0].row;
  spoilt.rooms[1].col = spoilt.rooms[0].col;
  assert.throws(() => validateRoomManifest(spoilt), /row 0.*col 0|same place/i);
});

test("the god's study must actually have a seat in it", () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const spoilt = house();
  spoilt.rooms[1].berths = [];
  assert.throws(() => validateRoomManifest(spoilt), /godStudy/);
});

test('a floor plan that fails validation is reported, not thrown', () => {
  const { loadRoomManifest, validateRoomManifest } = loadTs(MANIFEST);
  const spoilt = house();
  spoilt.rooms = spoilt.rooms.filter((r) => r.kind !== 'hearth');

  // The validator still throws — that is what names the offending field.
  assert.throws(() => validateRoomManifest(spoilt), /hearth/);

  // The loader must not, because the Study reads the plan while its module is
  // being evaluated: a throw there rejects the whole chunk.
  let load;
  assert.doesNotThrow(() => { load = loadRoomManifest(spoilt); },
    'loading a broken floor plan must not throw');
  assert.equal(load.ok, false, 'the load reports failure');
  assert.match(load.error, /hearth/, 'and carries the validator\'s reason');
});

test('the shipped floor plan loads cleanly', () => {
  const { loadRoomManifest } = loadTs(MANIFEST);
  const load = loadRoomManifest();
  assert.equal(load.ok, true, load.ok ? '' : `room.json is broken: ${load.error}`);
  assert.ok(load.manifest.rooms.length > 0, 'and carries the house');
});

test('a reading room with no desk in it is rejected, naming the room', () => {
  const { validateRoomManifest, deskBerths } = loadTs(MANIFEST);
  const spoilt = house();
  spoilt.rooms[0].berths = [];
  // The house still HAS a reading room, so the count check passes and the
  // seating is left with nowhere to put anybody.
  assert.equal(spoilt.rooms.filter((r) => r.kind === 'desk').length, 1);
  assert.throws(() => validateRoomManifest(spoilt), /r-desk/);
  // Which is what lets the seating index a berth without checking first.
  assert.ok(deskBerths(shippedHouse()).length > 0, 'the shipped house has desks');
});

test('no storey holds more than two rooms', () => {
  const { houseRows } = loadTs(MANIFEST);
  // Three rooms abreast made the house wider than it was tall, and because the
  // house is letterboxed whole, EVERY room in it shrank to fit the one storey
  // that was too wide. Two is the cap; there is vertical space to spend and
  // another storey is cheap.
  for (const storey of houseRows(shippedHouse())) {
    assert.ok(storey.length <= 2,
      `storey ${storey[0].row} holds ${storey.length} rooms: ${storey.map((r) => r.id).join(', ')}`);
  }
});

test('every storey spans the whole house, so no room is centred in dead floor', () => {
  // A storey narrower than the house is drawn centred, with empty floor either
  // side — and the empty floor is paid for out of the scale the whole building
  // is letterboxed at, so a single short storey shrinks every room in the house.
  const { houseRows } = loadTs(MANIFEST);
  const storeys = houseRows(shippedHouse());
  const span = (rooms) => rooms.reduce((s, r) => s + r.natural.w / r.natural.h, 0);
  const widest = Math.max(...storeys.map(span));
  for (const storey of storeys) {
    assert.equal(span(storey), widest,
      `storey ${storey[0].row} spans ${span(storey)} of the house's ${widest}`);
  }
});

test('an anchor may stand as a prop inside a room instead of owning one', () => {
  // A room per function wastes a storey, and the house is letterboxed whole —
  // so every storey spent on a single prop shrinks the reading rooms too. An
  // anchor is therefore allowed to be a place INSIDE somebody else's room.
  const { validateRoomManifest } = loadTs(MANIFEST);
  const plan = house();
  const host = plan.rooms.find((r) => r.id === 'r-cardTable');
  const moved = plan.rooms.filter((r) => r.kind !== 'hearth');
  host.props = [{ kind: 'hearth', berth: berth('door', { x: 0.05, y: 0.05, w: 0.1, h: 0.8 }) }];
  const manifest = validateRoomManifest({ ...plan, rooms: moved });
  const hosted = manifest.rooms.find((r) => r.id === 'r-cardTable');
  assert.equal(hosted.props.length, 1);
  assert.equal(hosted.props[0].kind, 'hearth');
  assert.equal(hosted.props[0].berth.id, 'door');
});

test('an anchor that is both a room and a prop is rejected, and so is one that is neither', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const twice = house();
  twice.rooms.find((r) => r.id === 'r-cardTable').props = [
    { kind: 'hearth', berth: berth('door', { x: 0.05, y: 0.05, w: 0.1, h: 0.8 }) }
  ];
  assert.throws(() => validateRoomManifest(twice), /exactly one hearth/);

  const none = house();
  assert.throws(
    () => validateRoomManifest({ ...none, rooms: none.rooms.filter((r) => r.kind !== 'hearth') }),
    /exactly one hearth/
  );
});

test('a prop berth is checked against its host panel and the house-wide id list', () => {
  const { validateRoomManifest } = loadTs(MANIFEST);
  const off = house();
  off.rooms.find((r) => r.id === 'r-cardTable').props = [
    { kind: 'almanac', berth: berth('page', { x: 0.8, y: 0.1, w: 0.4, h: 0.2 }) }
  ];
  assert.throws(
    () => validateRoomManifest({ ...off, rooms: off.rooms.filter((r) => r.kind !== 'almanac') }),
    /hangs off the panel of r-cardTable/
  );

  const clash = house();
  clash.rooms.find((r) => r.id === 'r-cardTable').props = [
    { kind: 'almanac', berth: berth('b-1') }
  ];
  assert.throws(
    () => validateRoomManifest({ ...clash, rooms: clash.rooms.filter((r) => r.kind !== 'almanac') }),
    /duplicate berth id b-1/
  );
});

test('anchorSeat finds an anchor whether it owns a room or stands in one', () => {
  const { anchorSeat } = loadTs(MANIFEST);
  const plan = shippedHouse();
  for (const kind of ANCHOR_KINDS) {
    const seat = anchorSeat(plan, kind);
    assert.ok(seat, `${kind} is nowhere in the house`);
    assert.ok(plan.rooms.includes(seat.room), `${kind}'s host is not a room of the house`);
    if (seat.room.kind !== kind) {
      assert.ok(seat.room.props.some((p) => p.kind === kind), `${kind} is not a prop of its host`);
    }
  }
});

test('the function rooms are gathered into one, so the reading rooms get the storey', () => {
  // Single-function rooms cost a whole storey each, and the house is scaled to
  // fit as one drawing — so the price of a room holding nothing but a stack of
  // letters is paid by every assistant's card in the building.
  const { houseRows } = loadTs(MANIFEST);
  const storeys = houseRows(shippedHouse());
  assert.equal(storeys.length, 4, 'the house is four storeys, not five');
  const anchorRooms = storeys.flat().filter(
    (r) => r.kind !== 'desk' && r.kind !== 'godStudy');
  assert.ok(anchorRooms.length <= 3,
    `${anchorRooms.length} rooms hold nothing but props: ${anchorRooms.map((r) => r.id).join(', ')}`);
});
