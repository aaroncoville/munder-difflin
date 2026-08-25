/**
 * The floor resets when you switch agents.
 *
 * Switching agents opens terminals; each xterm takes a WebGL context
 * (@xterm/addon-webgl), Chromium crosses its per-process cap and evicts the
 * OLDEST context — which is always the office floor's, built at app startup.
 * glRecovery catches that and bumps `glGeneration`, a dep of the scene effect,
 * so the whole scene is torn down and rebuilt. That rebuild is the recovery
 * working; the visible cost is that every agent is constructed cold again and
 * replays the walk-in from the office door, and seats are re-claimed in
 * whatever order the agents happen to be rebuilt in.
 *
 * These tests pin the seam that removes the annoyance: the placement of every
 * agent is snapshotted before teardown and seeded back on rebuild, so agents
 * reappear AT their desks. It does NOT stop the eviction — see
 * docs/investigations/T-071-floor-reset.md.
 */
const test = require('node:test');
const assert = require('node:assert');
const load = require('./load-ts.cjs');

const { captureSceneSnapshot, restorePlacement } =
  load('src/renderer/src/scene/office/sceneRestore.ts');

/** A runtimes map stand-in — the two fields the capture actually reads. */
function runtimes(entries) {
  return new Map(entries.map(([id, seatIndex, x, y]) => [
    id, { seatIndex, character: { getTilePosition: () => ({ x, y }) } }
  ]));
}
/** A floor with `seats` seats, all free, and everything walkable. */
function floor(seats = 8, claimed = []) {
  const taken = new Set(claimed);
  return {
    seatCount: seats,
    isSeatFree: (i) => !taken.has(i),
    isWalkable: () => true
  };
}

test('a snapshot carries each agent’s desk and where it was standing', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4], ['b', 5, 2, 9]]));
  assert.equal(snap.theme, 'office');
  assert.deepEqual(snap.agents.a, { seatIndex: 3, tile: { x: 10, y: 4 } });
  assert.deepEqual(snap.agents.b, { seatIndex: 5, tile: { x: 2, y: 9 } });
});

test('on rebuild an agent gets its OWN desk back, not the next free one', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4]]));
  const p = restorePlacement(snap, 'office', 'a', floor());
  assert.equal(p.seatIndex, 3, 'agent was reseated somewhere else — desks shuffled on rebuild');
});

test('the agent reappears AT its desk instead of replaying the walk-in', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4]]));
  const p = restorePlacement(snap, 'office', 'a', floor());
  assert.deepEqual(p.spawnTile, { x: 10, y: 4 }, 'spawned somewhere other than where it stood');
});

test('a genuine cold start still walks in through the door', () => {
  assert.equal(restorePlacement(null, 'office', 'a', floor()), null,
    'no snapshot must mean no restore — the first-ever mount is meant to walk in');
});

test('an agent that joined after the teardown walks in normally', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4]]));
  assert.equal(restorePlacement(snap, 'office', 'newcomer', floor()), null);
});

test('a theme change discards the snapshot — different map, meaningless tiles', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4]]));
  assert.equal(restorePlacement(snap, 'spaceship', 'a', floor()), null,
    'seat indices and tiles from another map would seat agents inside walls');
});

test('a desk already claimed this mount is never double-claimed', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4]]));
  const p = restorePlacement(snap, 'office', 'a', floor(8, [3]));
  assert.equal(p.seatIndex, null, 'two agents were put in the same chair');
  assert.deepEqual(p.spawnTile, { x: 10, y: 4 }, 'position is still worth restoring');
});

test('a seat index the current floor no longer has falls back', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 9, 10, 4]]));
  assert.equal(restorePlacement(snap, 'office', 'a', floor(8)).seatIndex, null);
});

test('an unwalkable remembered tile falls back to the door', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', 3, 10, 4]]));
  const p = restorePlacement(snap, 'office', 'a', { ...floor(), isWalkable: () => false });
  assert.equal(p.spawnTile, null, 'would have spawned an agent inside a wall');
  assert.equal(p.seatIndex, 3, 'the desk is still restorable');
});

test('an agent that never got a desk restores its position only', () => {
  const snap = captureSceneSnapshot('office', runtimes([['a', null, 10, 4]]));
  const p = restorePlacement(snap, 'office', 'a', floor());
  assert.equal(p.seatIndex, null);
  assert.deepEqual(p.spawnTile, { x: 10, y: 4 });
});

test('the snapshot is a copy — the live scene keeps moving while it is torn down', () => {
  // The tile object handed back is the one the snapshot must NOT alias: the
  // ticker is still running during teardown, and a scene destroyed mid-walk
  // would otherwise rewrite the placement we are about to restore from.
  const pos = { x: 10, y: 4 };
  const live = { seatIndex: 3, character: { getTilePosition: () => pos } };
  const snap = captureSceneSnapshot('office', new Map([['a', live]]));
  pos.x = 0; pos.y = 0;
  live.seatIndex = 99;
  assert.deepEqual(snap.agents.a, { seatIndex: 3, tile: { x: 10, y: 4 } });
});

/**
 * DO NOT REGRESS THE RECOVERY. The capture runs inside the same effect cleanup
 * that uninstalls the context-loss listener. If a half-destroyed character
 * throws while being read, an unguarded capture takes the whole cleanup down
 * with it and the listener is never removed — a torn-down scene that can still
 * resurrect itself, which is strictly worse than the reset we are fixing.
 */
test('a broken character cannot take the teardown down with it', () => {
  const map = new Map([
    ['ok', { seatIndex: 1, character: { getTilePosition: () => ({ x: 5, y: 5 }) } }],
    ['throws', { seatIndex: 2, character: { getTilePosition: () => { throw new Error('destroyed'); } } }],
    ['gone', { seatIndex: 3, character: null }],
    ['nan', { seatIndex: 4, character: { getTilePosition: () => ({ x: NaN, y: 2 }) } }]
  ]);
  let snap;
  assert.doesNotThrow(() => { snap = captureSceneSnapshot('office', map); });
  assert.deepEqual(snap.agents.ok, { seatIndex: 1, tile: { x: 5, y: 5 } });
  for (const bad of ['throws', 'gone', 'nan']) {
    assert.equal(snap.agents[bad], undefined, `${bad} should have been skipped, not snapshotted`);
    assert.equal(restorePlacement(snap, 'office', bad, floor()), null);
  }
});

test('a garbage snapshot restores nothing rather than seating agents in walls', () => {
  for (const bad of [undefined, {}, { theme: 'office' }, { agents: {} }]) {
    assert.equal(restorePlacement(bad, 'office', 'a', floor()), null);
  }
});
