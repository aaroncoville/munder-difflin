/**
 * T-071 QA — the paths the author could not exercise.
 *
 * sceneRestore.ts is deliberately Pixi-free, React-free and map-renderer-free so
 * the whole restore POLICY can be driven from a Map literal. These tests use that
 * seam to probe the four things a headless worktree can still reach:
 *
 *   1. the capture is total, because it shares a cleanup with the context-loss
 *      uninstall and a throw there would strand a listener on a dead scene;
 *   2. seats cannot be double-claimed no matter what order agents restore in;
 *   3. a snapshot cannot outlive the mount it describes;
 *   4. when both halves fail the agent lands on the ordinary cold-start path,
 *      not at 0,0 and not off-map.
 *
 * What is NOT reachable from here — and what would settle it — is written up in
 * docs/investigations/T-071-qa.md. Nothing here touches glRecovery.ts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./load-ts.cjs');

const { captureSceneSnapshot, restorePlacement } =
  load('src/renderer/src/scene/office/sceneRestore.ts');

/** A live runtime the capture can read cleanly. */
const rt = (seatIndex, x, y) => ({ seatIndex, character: { getTilePosition: () => ({ x, y }) } });
/** A floor whose claims are a live Set, so a claim made mid-restore is seen. */
function floor(seats = 8, claims = new Set(), walkable = () => true) {
  return { seatCount: seats, isSeatFree: (i) => !claims.has(i), isWalkable: walkable, claims };
}
/** What OfficeFloor's addCharacter does with a restore result, seat half only:
 *  take the remembered desk if it was offered, else leave it to claimSeat. */
function takeSeat(p, f) {
  if (p?.seatIndex != null) { f.claims.add(p.seatIndex); return p.seatIndex; }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// (1) The capture is TOTAL — it must never take the teardown down with it.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Every way a Character can be broken while it is being destroyed. The author's
 * suite covers a throwing getTilePosition, a null character and a NaN tile; these
 * are the shapes it does not — a property ACCESS that throws rather than a call,
 * a runtime that is not an object at all, and a key that throws on coercion.
 */
test('no shape of half-destroyed runtime can make the capture throw', () => {
  const throwing = () => { throw new Error('mid-destroy'); };
  const garbage = [
    ['character getter throws', { seatIndex: 1, get character() { throwing(); } }],
    ['seatIndex getter throws', { get seatIndex() { throwing(); }, character: { getTilePosition: () => ({ x: 1, y: 1 }) } }],
    ['tile.x getter throws', { seatIndex: 1, character: { getTilePosition: () => ({ get x() { throwing(); }, y: 1 }) } }],
    ['getTilePosition is not callable', { seatIndex: 1, character: { getTilePosition: 42 } }],
    ['character has no getTilePosition', { seatIndex: 1, character: {} }],
    ['runtime is null', null],
    ['runtime is undefined', undefined],
    ['runtime is a primitive', 5],
    ['tile is null', { seatIndex: 1, character: { getTilePosition: () => null } }],
    ['tile x is a string', { seatIndex: 1, character: { getTilePosition: () => ({ x: '3', y: 1 }) } }],
    ['tile y is Infinity', { seatIndex: 1, character: { getTilePosition: () => ({ x: 1, y: Infinity }) } }]
  ];
  for (const [what, broken] of garbage) {
    let snap;
    assert.doesNotThrow(
      () => { snap = captureSceneSnapshot('office', new Map([['ok', rt(1, 5, 5)], ['bad', broken]])); },
      `${what}: the capture threw — the context-loss listener would be stranded on a dead scene`
    );
    assert.equal(snap.agents.bad, undefined, `${what}: was snapshotted anyway`);
    assert.deepEqual(snap.agents.ok, { seatIndex: 1, tile: { x: 5, y: 5 } },
      `${what}: took a healthy agent down with it`);
  }
});

test('a key that throws when coerced is skipped, not fatal', () => {
  const hostile = { toString() { throw new Error('id'); } };
  let snap;
  assert.doesNotThrow(() => {
    snap = captureSceneSnapshot('office', new Map([[hostile, rt(1, 2, 3)], ['ok', rt(2, 4, 5)]]));
  });
  assert.deepEqual(snap.agents.ok, { seatIndex: 2, tile: { x: 4, y: 5 } });
});

test('a floor of nothing but wreckage still yields a well-formed snapshot', () => {
  // The cleanup assigns the result to a ref unconditionally. If a total loss
  // could produce something other than an empty, correctly-themed snapshot, the
  // NEXT mount would read it and seat agents from garbage.
  const snap = captureSceneSnapshot('office', new Map([['a', null], ['b', 7], ['c', { character: null }]]));
  assert.deepEqual(snap, { theme: 'office', agents: {} });
  assert.equal(restorePlacement(snap, 'office', 'a', floor()), null);
});

test('an agent id that collides with an Object key restores nothing, not a bogus desk', () => {
  // `agents` is a bare object literal, so ids like `constructor` or `toString`
  // resolve up the prototype chain. Whatever comes back must not read as a
  // placement — an inherited function must not put anyone in a chair.
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 1, 2)]]));
  for (const id of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    const p = restorePlacement(snap, 'office', id, floor());
    assert.ok(p === null || (p.seatIndex === null && p.spawnTile === null),
      `id "${id}" produced a placement out of Object.prototype: ${JSON.stringify(p)}`);
  }
});

/**
 * SOURCE-ORDER GUARD, and the author's own highest-severity risk: the capture
 * lives in the same effect cleanup as the context-loss uninstall. The capture
 * being total (above) is the first defence and the cleanup's try/catch is the
 * second, but the guarantee that actually holds is ORDER — the uninstall runs
 * first and unconditionally, so no failure downstream of it can strand a
 * listener. Nothing else in a headless worktree can see that ordering; this
 * asserts it against the source and goes red the moment the lines are swapped.
 */
test('the context-loss uninstall runs BEFORE the snapshot capture', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  const uninstall = src.indexOf('__glRecovery?.()');
  const capture = src.indexOf('captureSceneSnapshot(officeTheme');
  assert.ok(uninstall > 0, 'the context-loss uninstall is gone from the cleanup');
  assert.ok(capture > 0, 'the snapshot capture is gone from the cleanup');
  assert.ok(uninstall < capture,
    'the capture was moved ahead of the uninstall — a throw there now strands the ' +
    'loss listener on a dead scene, which is worse than the reset this fixes');
  assert.match(src.slice(capture - 260, capture), /try\s*\{[\s\S]*$/,
    'the capture is no longer inside a try — the cleanup after it would be skipped');
});

// ───────────────────────────────────────────────────────────────────────────
// (2) Seat collision — restoring remembered seats while others claim seats.
// ───────────────────────────────────────────────────────────────────────────

test('agents get their own desks back whatever order they restore in', () => {
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 1, 1)], ['b', rt(5, 2, 2)], ['c', rt(4, 3, 3)]]));
  for (const order of [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'a', 'c']]) {
    const f = floor();
    const got = {};
    for (const id of order) got[id] = takeSeat(restorePlacement(snap, 'office', id, f), f);
    assert.deepEqual(got, { a: 3, b: 5, c: 4 }, `order ${order.join('>')} shuffled the desks`);
    assert.equal(f.claims.size, 3, 'a desk was claimed twice or not at all');
  }
});

test('a desk taken by an agent with no snapshot is not stolen back', () => {
  // The newcomer went through claimSeat and got seat 3 — the desk `a` remembers.
  // `a` must not sit on top of it; it gives up the desk and keeps its position.
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 10, 4)]]));
  const f = floor();
  f.claims.add(3);
  const p = restorePlacement(snap, 'office', 'a', f);
  assert.equal(p.seatIndex, null, 'two agents were put in the same chair');
  assert.deepEqual(p.spawnTile, { x: 10, y: 4 }, 'the desk was lost, the position should not be');
});

test('a seat freed mid-restore is restorable by the agent that remembers it', () => {
  // isSeatFree is read at restore time, not cached at snapshot time: an agent
  // removed part-way through a rebuild releases its chair and the rightful
  // owner, restored later in the same mount, can still take it.
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 1, 1)]]));
  const f = floor();
  f.claims.add(3);
  assert.equal(restorePlacement(snap, 'office', 'a', f).seatIndex, null);
  f.claims.delete(3);
  assert.equal(restorePlacement(snap, 'office', 'a', f).seatIndex, 3,
    'the probe was consulted once and cached — a freed chair stayed unusable');
});

test('restorePlacement has no seat-0 rule of its own — Michael is protected by the caller', () => {
  // Documents WHERE the invariant lives. claimSeat is the only place that knows
  // seat 0 is the god desk, and OfficeFloor keeps the god off this path entirely
  // (seedPlacement nulls the god's seat before the caller sees it). This module
  // will hand seat 0
  // to anyone who remembers it, so that caller-side guard is load-bearing.
  const snap = captureSceneSnapshot('office', new Map([['someone', rt(0, 4, 4)]]));
  assert.equal(restorePlacement(snap, 'office', 'someone', floor()).seatIndex, 0,
    'the seat-0 rule moved into this module — update the caller-side guard note');
});

test('seat 0 survives contention because no ordinary agent can ever remember it', () => {
  // The other half of the invariant: claimSeat only ever deals seats from 1, so
  // a non-god snapshot cannot contain seat 0 to begin with. Assert the source
  // rather than a restatement of it — this is the rule the restore relies on.
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  assert.match(src, /for \(let i = 1; i < seatTiles\.length; i\+\+\)/,
    'claimSeat no longer starts at 1 — a non-god can now hold seat 0 and restore into it');
  // T-071 follow-up (F1): the god is no longer excluded from the restore
  // WHOLESALE — he keeps his position — but seedPlacement still drops his seat,
  // so seat 0 is only ever dealt by claimSeat. See office-scene-restore-f1f2.
  assert.match(src, /const restored = seedPlacement\(/,
    'the god rule left seedPlacement — a restored god seat would make seat 0 contestable');
});

// ───────────────────────────────────────────────────────────────────────────
// (3) Snapshot lifetime — it must not outlive the mount it describes.
// ───────────────────────────────────────────────────────────────────────────

test('an agent archived between capture and rebuild leaves its desk free', () => {
  // Its entry stays in the snapshot but is never consulted (syncAgents only
  // builds agents that are still in the store), and it holds no claim — so the
  // chair is simply available to whoever claims it next.
  const snap = captureSceneSnapshot('office', new Map([['killed', rt(3, 1, 1)], ['alive', rt(5, 2, 2)]]));
  const f = floor();
  takeSeat(restorePlacement(snap, 'office', 'alive', f), f);
  assert.ok(f.isSeatFree(3), 'a dead agent kept its chair reserved across the rebuild');
  assert.equal(restorePlacement(snap, 'office', 'newcomer', f), null,
    'an agent that joined after the teardown must walk in cold');
});

test('a capture taken before the rebuild finished building restores nobody', () => {
  // THE EVICTION STORM. Characters are built asynchronously (`await getFrames`),
  // so a second eviction landing before those resolve tears the mount down with
  // `runtimes` still empty. The capture that runs then is empty — correct in
  // itself, and it is what the ref is left holding.
  const mid = captureSceneSnapshot('office', new Map());
  assert.deepEqual(mid, { theme: 'office', agents: {} });
  assert.equal(restorePlacement(mid, 'office', 'a', floor()), null,
    'an empty snapshot must read as a cold start, never as a placement');
});

test('a theme round trip never replays the first theme’s tiles', () => {
  // office -> spaceship -> office. Each teardown overwrites the ref, so the only
  // snapshot alive when office is rebuilt describes the SPACESHIP map, and its
  // theme tag is what rejects it. Nothing from two mounts ago can leak through.
  const first = captureSceneSnapshot('office', new Map([['a', rt(3, 10, 4)]]));
  const second = captureSceneSnapshot('spaceship', new Map([['a', rt(7, 99, 99)]]));
  assert.equal(restorePlacement(first, 'spaceship', 'a', floor(64)), null);
  assert.equal(restorePlacement(second, 'office', 'a', floor(64)), null,
    'tiles measured on another map were replayed — agents would be seated in walls');
});

// ───────────────────────────────────────────────────────────────────────────
// (4) Degradation — the both-fail case must land on the cold-start path.
// ───────────────────────────────────────────────────────────────────────────

test('both halves failing degrades to the ordinary cold start, not to 0,0', () => {
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 10, 4)]]));
  const p = restorePlacement(snap, 'office', 'a', floor(8, new Set([3]), () => false));
  assert.equal(p.seatIndex, null, 'seatIndex must be null so the caller falls through to claimSeat');
  assert.equal(p.spawnTile, null,
    'spawnTile must be null so the caller falls through to `?? entrance` — a 0,0 or ' +
    'an off-map tile here would drop the agent outside the office');
  assert.ok(!('x' in p), 'the result must not be mistakable for a tile');
});

test('a restored spawn tile is never one the floor called unwalkable', () => {
  const walls = new Set(['0,0', '10,4', '3,3']);
  const snap = captureSceneSnapshot('office',
    new Map([['a', rt(1, 10, 4)], ['b', rt(2, 3, 3)], ['c', rt(3, 6, 6)], ['d', rt(4, 0, 0)]]));
  const f = floor(8, new Set(), (x, y) => !walls.has(`${x},${y}`));
  for (const id of ['a', 'b', 'c', 'd']) {
    const p = restorePlacement(snap, 'office', id, f);
    if (p?.spawnTile) {
      assert.ok(f.isWalkable(p.spawnTile.x, p.spawnTile.y),
        `${id} was spawned into a wall at ${p.spawnTile.x},${p.spawnTile.y}`);
    }
  }
  assert.equal(restorePlacement(snap, 'office', 'c', f).spawnTile.x, 6, 'a walkable tile was dropped');
});

test('the restored tile is a copy — one agent’s spawn cannot rewrite another’s', () => {
  // The caller hands spawnTile to a Character, which owns and mutates position.
  // If it aliased the snapshot, the first agent to move would corrupt the
  // placement every later agent in the same mount is restored from.
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 10, 4)]]));
  const first = restorePlacement(snap, 'office', 'a', floor()).spawnTile;
  first.x = -1; first.y = -1;
  assert.deepEqual(restorePlacement(snap, 'office', 'a', floor()).spawnTile, { x: 10, y: 4 },
    'the restore handed out the snapshot’s own tile object');
});
