/**
 * T-071 follow-up — the two behaviour gaps QA found and correctly did not apply.
 *
 * F1: the god was excluded from BOTH halves of the restore, so Michael — the
 *     agent most likely to be on screen — marched in through the door on every
 *     eviction. Only his SEAT is protected (seat 0 is his by rule and claimSeat
 *     is the one place that rule lives); his POSITION is orthogonal.
 * F2: an eviction storm could tear a mount down before its characters finished
 *     building (`await theme.cast.getFrames`), capturing a still-empty runtimes
 *     map and writing `{}` OVER a good snapshot. The next rebuild was then a
 *     full cold start — the exact jank T-071 exists to remove.
 *
 * Both are driven through sceneRestore.ts's Pixi-free seam, plus source-wiring
 * guards for the one thing a headless worktree cannot execute: that OfficeFloor
 * actually calls them. See docs/investigations/T-071-qa.md for QA's reasoning.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const load = require('./load-ts.cjs');

const { captureSceneSnapshot, restorePlacement, seedPlacement, mergeSceneSnapshot } =
  load('src/renderer/src/scene/office/sceneRestore.ts');

const SRC = path.join(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx');
const officeFloorSource = () => fs.readFileSync(SRC, 'utf8');

/** A live runtime the capture can read cleanly. */
const rt = (seatIndex, x, y) => ({ seatIndex, character: { getTilePosition: () => ({ x, y }) } });
/** A floor whose claims are a live Set, so a claim made mid-restore is seen. */
function floor(seats = 8, claims = new Set(), walkable = () => true) {
  return { seatCount: seats, isSeatFree: (i) => !claims.has(i), isWalkable: walkable, claims };
}

// ───────────────────────────────────────────────────────────────────────────
// F1 — the god keeps his position; only his seat is re-dealt.
// ───────────────────────────────────────────────────────────────────────────

test('the god reappears where he was standing instead of walking in again', () => {
  // The whole point of the feature, on its most visible subject. Before this,
  // OfficeFloor read `agent.isGod ? null : restorePlacement(...)`, which threw
  // away the position along with the seat and sent Michael back to the door.
  const snap = captureSceneSnapshot('office', new Map([['god-1', rt(0, 11, 7)]]));
  const seeded = seedPlacement(snap, 'office', { id: 'god-1', isGod: true }, floor());
  assert.deepEqual(seeded.spawnTile, { x: 11, y: 7 },
    'the god lost his remembered position — he walks in through the door on every eviction');
});

test('the god does NOT get his remembered seat back — claimSeat re-deals it', () => {
  // Seat 0 is Michael's by rule and claimSeat is the one place that rule lives.
  // Restoring it here would put a second copy of that rule in the restore path.
  const snap = captureSceneSnapshot('office', new Map([['god-1', rt(0, 11, 7)]]));
  const seeded = seedPlacement(snap, 'office', { id: 'god-1', isGod: true }, floor());
  assert.equal(seeded.seatIndex, null,
    'the god restored a seat — the seat-0 rule now lives in two places');
});

test('an ordinary agent still gets both halves of its placement back', () => {
  // The god rule must not leak onto everybody else.
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  const seeded = seedPlacement(snap, 'office', { id: 'a', isGod: false }, floor());
  assert.deepEqual(seeded, { seatIndex: 3, spawnTile: { x: 4, y: 9 } });
});

test('an agent with no isGod flag is treated as an ordinary agent', () => {
  // `isGod` is optional on Agent; absent must mean "not the god", not "unknown".
  const snap = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  assert.equal(seedPlacement(snap, 'office', { id: 'a' }, floor()).seatIndex, 3,
    'a missing isGod flag suppressed an ordinary agent\'s desk');
});

test('a god with no snapshot still falls through to the cold start', () => {
  // A genuine first appearance, and the both-halves-failed case: the caller
  // must see the same `null` it saw before, so it walks him in from the door.
  assert.equal(seedPlacement(null, 'office', { id: 'god-1', isGod: true }, floor()), null);
  const snap = captureSceneSnapshot('office', new Map([['someone-else', rt(3, 1, 1)]]));
  assert.equal(seedPlacement(snap, 'office', { id: 'god-1', isGod: true }, floor()), null);
});

test('a theme change discards the god restore too', () => {
  const snap = captureSceneSnapshot('spaceship', new Map([['god-1', rt(0, 11, 7)]]));
  assert.equal(seedPlacement(snap, 'office', { id: 'god-1', isGod: true }, floor()), null,
    'a spaceship tile was replayed onto the office map');
});

test('the god does not consume a desk claim on the restore path', () => {
  // OfficeFloor only calls seatClaims.add() when the restore OFFERS a seat.
  // If the god were ever offered seat 0 here it would be claimed twice — once
  // by this path and once by claimSeat.
  const snap = captureSceneSnapshot('office', new Map([['god-1', rt(0, 11, 7)]]));
  const f = floor();
  const seeded = seedPlacement(snap, 'office', { id: 'god-1', isGod: true }, f);
  if (seeded.seatIndex != null) f.claims.add(seeded.seatIndex);
  assert.equal(f.claims.size, 0, 'the god claimed a desk before claimSeat ran');
});

// ── the seat-0 rule, un-regressed ──────────────────────────────────────────

test('no ordinary agent can land on seat 0, before or after the god restore', () => {
  // The invariant survives on two caller-side facts, both still true:
  //  (a) claimSeat only ever deals seats from index 1 to a non-god, so no
  //      ordinary agent's snapshot can contain seat 0 to begin with;
  //  (b) the god's seat is never restored, so seat 0 is only ever dealt by
  //      claimSeat, to the god.
  const src = officeFloorSource();
  assert.match(src, /for \(let i = 1; i < seatTiles\.length; i\+\+\)/,
    'claimSeat no longer starts at 1 — a non-god can now hold seat 0 and restore into it');
  assert.match(src, /if \(agent\.isGod\) \{ seatClaims\.add\(GOD_SEAT\); return GOD_SEAT; \}/,
    'claimSeat no longer reserves seat 0 for the god');
  // And behaviourally: a non-god that somehow DID remember seat 0 is not the
  // thing that protects it — this module hands it over, which is exactly why
  // (a) above is load-bearing and asserted against the source.
  const rogue = captureSceneSnapshot('office', new Map([['a', rt(0, 1, 1)]]));
  assert.equal(restorePlacement(rogue, 'office', 'a', floor()).seatIndex, 0,
    'the seat-0 rule moved into sceneRestore — update the caller-side guard notes');
});

test('OfficeFloor seeds characters through seedPlacement, god included', () => {
  // The wiring a headless worktree cannot execute. Goes red if someone puts the
  // `agent.isGod ? null :` exclusion back, or drops the god rule entirely by
  // calling restorePlacement directly from addCharacter.
  const src = officeFloorSource();
  assert.match(src, /const restored = seedPlacement\(\s*sceneSnapshotRef\.current,\s*officeTheme,\s*agent,/,
    'addCharacter no longer seeds through seedPlacement — the god rule is bypassed');
  assert.doesNotMatch(src, /agent\.isGod\s*\n?\s*\?\s*null\s*\n?\s*:\s*(seedPlacement|restorePlacement)/,
    'the god is excluded from the restore again — Michael walks in on every eviction');
  assert.match(src, /spawnTile: restored\?\.spawnTile \?\? entrance/,
    'the restored position is no longer used to seed the character');
});

// ───────────────────────────────────────────────────────────────────────────
// F2 — an eviction storm must not clobber a good snapshot with an empty one.
// ───────────────────────────────────────────────────────────────────────────

test('a capture of a floor that never finished building keeps the old placements', () => {
  // The storm: eviction 1 tears down a populated floor and captures it. The
  // rebuild starts, `await theme.cast.getFrames` has not resolved, so `runtimes`
  // is still empty when eviction 2 tears THAT mount down. Assigning its capture
  // would write `{}` over the good snapshot and the next rebuild would be a full
  // cold start — everyone walks in, which is the jank T-071 exists to remove.
  const good = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)], ['b', rt(5, 1, 2)]]));
  const empty = captureSceneSnapshot('office', new Map());
  const merged = mergeSceneSnapshot(good, empty);
  assert.deepEqual(merged.agents, good.agents,
    'an empty capture destroyed the previous placements — the next rebuild is a cold start');
  assert.equal(merged.theme, 'office');
});

test('a partial capture keeps the placements it could not see', () => {
  // The same storm, one frame later: some characters resolved, some did not.
  const good = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)], ['b', rt(5, 1, 2)]]));
  const partial = captureSceneSnapshot('office', new Map([['a', rt(3, 7, 7)]]));
  const merged = mergeSceneSnapshot(good, partial);
  assert.deepEqual(merged.agents.b, { seatIndex: 5, tile: { x: 1, y: 2 } },
    'the agent that had not finished building lost its placement');
});

test('a fresh placement wins over the one it remembers', () => {
  // Merging is a floor, not a freeze: an agent that actually moved must be
  // remembered where it ended up, not where it was two rebuilds ago.
  const older = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  const newer = captureSceneSnapshot('office', new Map([['a', rt(6, 12, 2)]]));
  assert.deepEqual(mergeSceneSnapshot(older, newer).agents.a, { seatIndex: 6, tile: { x: 12, y: 2 } },
    'a stale placement outranked the live one');
});

test('a theme change DISCARDS the previous placements rather than merging them', () => {
  // Seat indices and tiles index ONE map. Merging across themes would resurrect
  // office placements onto the spaceship and seat agents inside walls — the one
  // thing the theme tag exists to prevent.
  const office = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  const ship = captureSceneSnapshot('spaceship', new Map([['b', rt(1, 0, 0)]]));
  const merged = mergeSceneSnapshot(office, ship);
  assert.equal(merged.theme, 'spaceship');
  assert.deepEqual(Object.keys(merged.agents), ['b'],
    'an office placement survived into the spaceship snapshot');
});

test('a theme change to an EMPTY capture still discards — it does not resurrect', () => {
  // The nastiest combination of F2 and the theme rule: a storm during a theme
  // switch. The empty spaceship capture must win anyway; keeping the office
  // placements "because the new one is empty" would replay them onto the new map.
  const office = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  const merged = mergeSceneSnapshot(office, captureSceneSnapshot('spaceship', new Map()));
  assert.deepEqual(merged, { theme: 'spaceship', agents: {} },
    'office placements survived a theme change because the new capture was empty');
});

test('the first capture of the session merges into nothing', () => {
  const fresh = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  assert.deepEqual(mergeSceneSnapshot(null, fresh), fresh);
  assert.deepEqual(mergeSceneSnapshot(undefined, fresh), fresh);
});

test('the merge does not mutate the snapshot it is merging into', () => {
  // The ref is swapped, not edited: a placement handed out to a restore that is
  // still running must not change under it.
  const good = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  const merged = mergeSceneSnapshot(good, captureSceneSnapshot('office', new Map([['b', rt(5, 1, 2)]])));
  assert.deepEqual(Object.keys(good.agents), ['a'], 'the previous snapshot was edited in place');
  assert.notEqual(merged.agents, good.agents);
});

test('a merged placement is still restorable end to end', () => {
  // The point of keeping it: the agent the storm could not see still comes back
  // to its own desk on the rebuild after.
  const good = captureSceneSnapshot('office', new Map([['a', rt(3, 4, 9)]]));
  const merged = mergeSceneSnapshot(good, captureSceneSnapshot('office', new Map()));
  assert.deepEqual(seedPlacement(merged, 'office', { id: 'a' }, floor()),
    { seatIndex: 3, spawnTile: { x: 4, y: 9 } },
    'the placement survived the merge but could not be restored from');
});

test('OfficeFloor merges the capture into the ref instead of replacing it', () => {
  // The wiring a headless worktree cannot execute. Goes red if the cleanup goes
  // back to `sceneSnapshotRef.current = captureSceneSnapshot(...)`.
  const src = officeFloorSource();
  assert.match(src, /sceneSnapshotRef\.current = mergeSceneSnapshot\(\s*sceneSnapshotRef\.current,\s*captureSceneSnapshot\(officeTheme, runtimes\)\s*,?\s*\)/,
    'the cleanup assigns the capture straight onto the ref — an eviction storm ' +
    'can still write an empty snapshot over a good one');
  // F2 must not have moved the capture ahead of the context-loss uninstall.
  const uninstall = src.indexOf('__glRecovery?.()');
  assert.ok(uninstall > 0 && uninstall < src.indexOf('= mergeSceneSnapshot('),
    'the merge was placed ahead of the uninstall — a throw there strands the loss listener');
});
