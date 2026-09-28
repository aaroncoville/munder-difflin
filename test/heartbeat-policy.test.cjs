'use strict';

/**
 * Pure decision logic for one heartbeat beat: whether to re-engage god, and how
 * many tasks.json cards are 'doing' (the signal that distinguishes "quiet floor,
 * nothing in flight" from "quiet floor, a stall in progress"). Extracted out of
 * index.ts's beat() so it can be exercised directly instead of only through the
 * Electron-only main process.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { shouldReengage, doingTaskCount } = loadTs('src/main/heartbeatPolicy.ts');

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-heartbeat-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTasks(root, tasks) {
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks }), 'utf8');
}

// ─── shouldReengage ────────────────────────────────────────────────────────

test('actionable inbox mail always re-engages, regardless of quiet/doing/knob', () => {
  assert.equal(shouldReengage({ actionable: 1, quiet: false, doingCount: 0, suppressWhenIdle: true }), true);
  assert.equal(shouldReengage({ actionable: 1, quiet: true, doingCount: 0, suppressWhenIdle: false }), true);
  assert.equal(shouldReengage({ actionable: 3, quiet: false, doingCount: 5, suppressWhenIdle: true }), true);
});

test('an active (non-quiet) floor with no actionable mail never re-engages', () => {
  assert.equal(shouldReengage({ actionable: 0, quiet: false, doingCount: 0, suppressWhenIdle: true }), false);
  assert.equal(shouldReengage({ actionable: 0, quiet: false, doingCount: 5, suppressWhenIdle: true }), false);
  assert.equal(shouldReengage({ actionable: 0, quiet: false, doingCount: 0, suppressWhenIdle: false }), false);
});

test('quiet + no doing cards + suppression on => does NOT re-engage (the new behaviour)', () => {
  assert.equal(shouldReengage({ actionable: 0, quiet: true, doingCount: 0, suppressWhenIdle: true }), false);
});

test('quiet + at least one doing card + suppression on => DOES re-engage (possible stall)', () => {
  assert.equal(shouldReengage({ actionable: 0, quiet: true, doingCount: 1, suppressWhenIdle: true }), true);
  assert.equal(shouldReengage({ actionable: 0, quiet: true, doingCount: 4, suppressWhenIdle: true }), true);
});

test('knob off restores the old behaviour: any quiet floor re-engages regardless of doing cards', () => {
  assert.equal(shouldReengage({ actionable: 0, quiet: true, doingCount: 0, suppressWhenIdle: false }), true);
  assert.equal(shouldReengage({ actionable: 0, quiet: true, doingCount: 7, suppressWhenIdle: false }), true);
});

// ─── doingTaskCount ────────────────────────────────────────────────────────

test('counts only cards with status doing, ignoring todo/blocked/done', (t) => {
  const root = tmpRoot(t);
  writeTasks(root, [
    { id: '1', status: 'todo' },
    { id: '2', status: 'doing' },
    { id: '3', status: 'blocked' },
    { id: '4', status: 'doing' },
    { id: '5', status: 'done' }
  ]);
  assert.equal(doingTaskCount(root), 2);
});

test('an empty (legitimate) task list counts as zero doing cards', (t) => {
  const root = tmpRoot(t);
  writeTasks(root, []);
  assert.equal(doingTaskCount(root), 0);
});

test('a missing tasks.json fails toward "has doing cards", never toward silence', (t) => {
  const root = tmpRoot(t); // no tasks.json written at all
  assert.equal(doingTaskCount(root) > 0, true);
});

test('a corrupt tasks.json (unparsable JSON) fails toward "has doing cards"', (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'tasks.json'), '{ not valid json', 'utf8');
  assert.equal(doingTaskCount(root) > 0, true);
});

test('a malformed tasks.json (tasks is not an array) fails toward "has doing cards"', (t) => {
  const root = tmpRoot(t);
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: 'nope' }), 'utf8');
  assert.equal(doingTaskCount(root) > 0, true);
});

test('a null hive root (hive disabled) fails toward "has doing cards"', () => {
  assert.equal(doingTaskCount(null) > 0, true);
});
