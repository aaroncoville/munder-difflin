'use strict';
// The local usage log for UI events: allowlisted, ids/enums/durations only,
// daily files under <hive>/usage with private modes, 90-day retention, an off
// switch and a delete.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { UsageLog, RETENTION_DAYS } = loadTs('src/main/usageLog.ts');

function setup(t, { enabled = true, now = Date.parse('2026-11-12T15:00:00Z') } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { enabled, now };
  const log = new UsageLog({ root: () => root, enabled: () => state.enabled, now: () => state.now });
  const dir = path.join(root, 'usage');
  const read = (day = '2026-11-12') => {
    const p = path.join(dir, `${day}.jsonl`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { root, dir, log, read, state };
}

test('an allowlisted event is appended to today\'s file with ts and schema version', (t) => {
  const { log, read } = setup(t);
  assert.equal(log.record({ kind: 'ui-view', view: 'command-center:tasks', session: 's1', win: 1, focused: true }), true);
  assert.deepEqual(read(), [{ ts: Date.parse('2026-11-12T15:00:00Z'), v: 1, kind: 'ui-view', view: 'command-center:tasks', session: 's1', win: 1, focused: true }]);
});

test('unknown kinds, unknown fields and free text never reach the file', (t) => {
  const { log, read } = setup(t);
  assert.equal(log.record({ kind: 'keystroke', key: 'a' }), false);
  assert.equal(log.record({ kind: 'ui-view', view: 'settings', note: 'typed by the owner' }), true);
  assert.equal(log.record({ kind: 'ui-view', view: 'not a known view' }), false);
  assert.equal(log.record({ kind: 'ask-shown', askKey: 'CARD-1@2026-11-12T10:00:00.000Z', ageMs: 5, surface: 'ask-me' }), true);
  assert.equal(log.record({ kind: 'ask-shown', askKey: 'Is this the question text?', ageMs: 5, surface: 'ask-me' }), false);
  const rows = read();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].note, undefined);
  assert.doesNotMatch(JSON.stringify(rows), /typed by the owner|question text/);
});

test('numbers must be finite and non-negative; booleans must be booleans', (t) => {
  const { log } = setup(t);
  assert.equal(log.record({ kind: 'ui-view-end', view: 'settings', dwellMs: -1 }), false);
  assert.equal(log.record({ kind: 'ui-view-end', view: 'settings', dwellMs: 'long' }), false);
  assert.equal(log.record({ kind: 'app-focus', state: 'focus', focused: 'yes' }), false);
  assert.equal(log.record({ kind: 'ui-view-end', view: 'settings', dwellMs: 1200 }), true);
});

test('nothing is written while the switch is off', (t) => {
  const { log, read, state } = setup(t, { enabled: false });
  assert.equal(log.record({ kind: 'ui-view', view: 'settings' }), false);
  assert.deepEqual(read(), []);
  state.enabled = true;
  assert.equal(log.record({ kind: 'ui-view', view: 'settings' }), true);
});

test('the folder and files are private to the owner', (t) => {
  if (process.platform === 'win32') return;
  const { log, dir } = setup(t);
  log.record({ kind: 'ui-view', view: 'settings' });
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, '2026-11-12.jsonl')).mode & 0o777, 0o600);
});

test('files older than the retention window are pruned; others stay', (t) => {
  const { log, dir } = setup(t);
  fs.mkdirSync(dir, { recursive: true });
  for (const day of ['2026-08-13', '2026-08-14', '2026-11-11']) fs.writeFileSync(path.join(dir, `${day}.jsonl`), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not ours');
  assert.equal(RETENTION_DAYS, 90);
  const removed = log.prune();
  assert.equal(removed, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['2026-08-14.jsonl', '2026-11-11.jsonl', 'notes.txt']);
});

test('delete removes every usage file and reports how many', (t) => {
  const { log, dir } = setup(t);
  log.record({ kind: 'ui-view', view: 'settings' });
  fs.writeFileSync(path.join(dir, '2026-11-01.jsonl'), '{}\n');
  assert.equal(log.deleteAll(), 2);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a folder that is a link is refused, so the log cannot be redirected', (t) => {
  if (process.platform === 'win32') return;
  const { root, log } = setup(t);
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'md-elsewhere-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  fs.symlinkSync(elsewhere, path.join(root, 'usage'));
  assert.equal(log.record({ kind: 'ui-view', view: 'settings' }), false);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});
