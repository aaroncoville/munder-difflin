'use strict';

/**
 * A Codex worker never feeds the OpenTelemetry collector — only Claude Code is
 * given the telemetry environment — so the fleet snapshot used to publish
 * `lastActiveSecAgo: null` for it forever, and the orchestrator's roster read
 * "no activity yet" for an agent that had just finished a turn.
 *
 * Codex does keep its own record of every event it handles: the session's
 * rollout file, appended on each turn, tool call and token count. Its
 * modification time is the Codex equivalent of the last telemetry sample.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const sourceAssert = require('./source-assert.cjs');

const { newestRolloutAt, fleetLastActiveAt } = loadTs('src/main/codexActivity.ts');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-activity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Write a file and pin its modification time (seconds since the epoch). */
function writeAt(file, seconds) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{}\n');
  fs.utimesSync(file, seconds, seconds);
}

test('a Codex home with no sessions reads as no activity', (t) => {
  assert.equal(newestRolloutAt(tempHome(t)), null);
  assert.equal(newestRolloutAt(path.join(tempHome(t), 'does-not-exist')), null);
});

test('the newest rollout wins even when it sits under an older day', (t) => {
  // A resumed session keeps appending to the file it was created in, so the
  // live rollout is routinely filed under a day that is not the newest one.
  const home = tempHome(t);
  writeAt(path.join(home, 'sessions/2026/09/08/rollout-2026-09-08T22-52-27-resumed.jsonl'), 3_000_000);
  writeAt(path.join(home, 'sessions/2026/09/10/rollout-2026-09-10T09-00-00-older.jsonl'), 2_000_000);

  assert.equal(newestRolloutAt(home), 3_000_000 * 1000);
});

test('files that are not rollouts do not count as activity', (t) => {
  const home = tempHome(t);
  writeAt(path.join(home, 'sessions/2026/09/10/rollout-2026-09-10T09-00-00-a.jsonl'), 2_000_000);
  writeAt(path.join(home, 'sessions/2026/09/10/.DS_Store'), 9_000_000);
  writeAt(path.join(home, 'sessions/2026/09/10/notes.txt'), 9_000_000);

  assert.equal(newestRolloutAt(home), 2_000_000 * 1000);
});

test('a sessions directory reached through a symlink is read', (t) => {
  // The hive stores each worker's rollouts under Codex's global scan root and
  // links them into the worker's isolated home, so `sessions` is a link.
  const home = tempHome(t);
  const elsewhere = tempHome(t);
  writeAt(path.join(elsewhere, '2026/09/10/rollout-2026-09-10T09-00-00-a.jsonl'), 4_000_000);
  fs.symlinkSync(elsewhere, path.join(home, 'sessions'), 'dir');

  assert.equal(newestRolloutAt(home), 4_000_000 * 1000);
});

test('an agent that reports telemetry keeps its telemetry timestamp', (t) => {
  const home = tempHome(t);
  writeAt(path.join(home, 'sessions/2026/09/10/rollout-x.jsonl'), 9_000_000);

  assert.equal(fleetLastActiveAt('claude', 5_000, null), 5_000);
  assert.equal(fleetLastActiveAt(undefined, 5_000, null), 5_000);
  assert.equal(fleetLastActiveAt('codex', 5_000, home), 5_000);
});

test('a Codex agent without telemetry reads its rollout activity', (t) => {
  const home = tempHome(t);
  writeAt(path.join(home, 'sessions/2026/09/10/rollout-x.jsonl'), 7_000_000);

  assert.equal(fleetLastActiveAt('codex', undefined, home), 7_000_000 * 1000);
});

test('a Codex agent that has never run still reads as no activity', (t) => {
  assert.equal(fleetLastActiveAt('codex', undefined, tempHome(t)), null);
  assert.equal(fleetLastActiveAt('codex', undefined, null), null);
});

test('an agent of another provider is never given activity from disk', (t) => {
  const home = tempHome(t);
  writeAt(path.join(home, 'sessions/2026/09/10/rollout-x.jsonl'), 7_000_000);

  assert.equal(fleetLastActiveAt('claude', undefined, home), null);
  assert.equal(fleetLastActiveAt(undefined, undefined, home), null);
});

test('the fleet snapshot derives each agent\'s last activity from fleetLastActiveAt', () => {
  // Comments are blanked, so a call that has been commented out cannot pass.
  const src = sourceAssert.activeSource('src/main/index.ts');
  const body = sourceAssert.boundedSlice(
    src,
    'function writeFleetSnapshot(): void {',
    'hive.writeFleetSnapshot({ ts: now, agents });'
  );
  assert.match(body, /const activeAt = fleetLastActiveAt\(/);
  assert.match(body, /lastActiveSecAgo: activeAt === null \? null : Math\.round\(\(now - activeAt\) \/ 1000\)/);
});
