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

const { UsageLog, RETENTION_DAYS, recordFromRenderer } = loadTs('src/main/usageLog.ts');

function setup(t, { enabled = true, now = Date.parse('2026-11-12T15:00:00Z') } = {}) {
  // The app's own data folder; the hive is a separate folder agents can write.
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-appdata-'));
  t.after(() => fs.rmSync(appData, { recursive: true, force: true }));
  const state = { enabled, now };
  const dir = path.join(appData, 'usage');
  const log = new UsageLog({
    dir: () => dir, enabled: () => state.enabled, now: () => state.now,
    isAgent: (id) => ['jc', 'god'].includes(id), isCard: (id) => ['CARD-1'].includes(id)
  });
  const read = (day = '2026-11-12') => {
    const p = path.join(dir, `${day}.jsonl`);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { appData, dir, log, read, state };
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
  fs.writeFileSync(path.join(dir, 'digest-2026-W44.md'), '# digest\n');
  assert.equal(log.deleteAll(), 3);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('nothing is written under the hive root: the log lives in the app\'s data folder', (t) => {
  const hive = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-hive-'));
  t.after(() => fs.rmSync(hive, { recursive: true, force: true }));
  const { log, dir, appData } = setup(t);
  log.record({ kind: 'ui-view', view: 'settings' });
  log.prune();
  log.deleteAll();
  log.record({ kind: 'ui-view', view: 'settings' });
  assert.deepEqual(fs.readdirSync(hive), []);
  assert.ok(dir.startsWith(appData));
  assert.deepEqual(fs.readdirSync(dir), ['2026-11-12.jsonl']);
});

test('a kind named after an object property is refused, not thrown on', (t) => {
  const { log } = setup(t);
  for (const kind of ['constructor', '__proto__', 'toString']) assert.equal(log.record({ kind }), false, kind);
});

test('only states and surfaces the app emits are accepted', (t) => {
  const { log } = setup(t);
  assert.equal(log.record({ kind: 'app-focus', state: 'hidden' }), false);
  assert.equal(log.record({ kind: 'ask-shown', askKey: 'CARD-1@2026-11-12T10:00:00.000Z', surface: 'card-overlay' }), false);
  assert.equal(log.record({ kind: 'app-focus', state: 'blur' }), true);
});

test('agent and card ids are written only when the roster or tasks.json holds them', (t) => {
  const { log, read } = setup(t);
  const long = 'Owner-said-the-unreleased-project-is-ORCHID.Owner-said-the-unreleased-project-is';
  assert.equal(log.record({ kind: 'ui-view', view: 'agent-detail', agentId: 'jc', cardId: 'CARD-1' }), true);
  assert.equal(log.record({ kind: 'ui-view', view: 'agent-detail', agentId: long, cardId: long }), true, 'the view still counts');
  assert.equal(log.record({ kind: 'ask-shown', askKey: `${long}@2026-11-12T10:00:00.000Z`, surface: 'ask-me' }), false);
  assert.equal(log.record({ kind: 'ask-shown', askKey: 'CARD-1@2026-11-12T10:00:00Z', surface: 'ask-me' }), false, 'not the canonical key');
  const rows = read();
  assert.deepEqual(rows.map((r) => [r.agentId, r.cardId]), [['jc', 'CARD-1'], [undefined, undefined]]);
  assert.doesNotMatch(JSON.stringify(rows), /ORCHID/);
});

test('the hive ignores a usage folder, so no usage file can enter its git history', (t) => {
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-usage-ignore-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  new HiveManager(() => home).ensureHive();
  assert.ok(fs.readFileSync(path.join(home, 'hive', '.gitignore'), 'utf8').split('\n').includes('usage/'));
});

// ── hostile input: a refusal, never a throw ─────────────────────────────────

const HOSTILE_VALUES = [
  'constructor', '__proto__', 'toString', 'hasOwnProperty',
  'CARD-1@2026-99-99T99:99:99.999Z', 'CARD-1@+275760-09-13T00:00:00.001Z', 'CARD-1@',
  42, -1, 1.5, NaN, Infinity, true, null, undefined,
  { nested: { deeper: 'x' } }, ['settings'], 'x'.repeat(1_000_000), Symbol('s'), () => 1, 10n
];
const FIELDS = ['kind', 'view', 'askKey', 'agentId', 'cardId', 'dwellMs', 'ageMs', 'answerLen', 'answerShape', 'surface', 'state', 'focused'];

test('record() refuses every hostile value in every field and never throws', (t) => {
  const { log, dir } = setup(t);
  // Fields each kind declares; any other field is dropped, not refused.
  const DECLARED = {
    'ui-view': ['kind', 'view', 'focused'],
    'ask-shown': ['kind', 'askKey', 'ageMs', 'surface', 'focused'],
    'ask-submitted': ['kind', 'askKey', 'answerLen', 'answerShape', 'surface', 'focused']
  };
  const bases = [
    { kind: 'ui-view', view: 'settings' },
    { kind: 'ask-shown', askKey: 'CARD-1@2026-11-12T10:00:00.000Z', surface: 'ask-me' },
    { kind: 'ask-submitted', askKey: 'CARD-1@2026-11-12T10:00:00.000Z', surface: 'ask-me', answerLen: 4, answerShape: 'done-ack' }
  ];
  for (const base of bases) for (const f of FIELDS) for (const v of HOSTILE_VALUES) {
    let out;
    assert.doesNotThrow(() => { out = log.record({ ...base, [f]: v }); }, `${base.kind}.${f} = ${String(v).slice(0, 40)}`);
    assert.equal(typeof out, 'boolean');
    // agentId/cardId off the roster are dropped and the row is kept; anything else must be refused.
    const legitimate = (f === 'focused' && typeof v === 'boolean') || (['ageMs', 'answerLen'].includes(f) && Number.isSafeInteger(v) && v >= 0);
    if (DECLARED[base.kind].includes(f) && v !== undefined && !legitimate) assert.equal(out, false, `${base.kind}.${f} = ${String(v).slice(0, 40)}`);
  }
  const written = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n), 'utf8')).join('');
  assert.doesNotMatch(written, /constructor|__proto__|99:99|nested|xxxxxxxxxx/);
  for (const v of HOSTILE_VALUES) assert.doesNotThrow(() => log.record(v), String(v).slice(0, 40));
});

test('the renderer entry point refuses hostile payloads and never throws', (t) => {
  const { log, read } = setup(t);
  const ctx = { session: 'sess-1', win: 1, focused: true };
  const payloads = [...HOSTILE_VALUES, Object.create(null), new Proxy({}, { get() { throw new Error('trap'); }, ownKeys() { throw new Error('trap'); } })];
  for (const f of FIELDS) for (const v of HOSTILE_VALUES) payloads.push({ kind: 'ui-view', view: 'settings', [f]: v });
  for (const p of payloads) {
    let out;
    assert.doesNotThrow(() => { out = recordFromRenderer(log, p, ctx); });
    assert.equal(typeof out, 'boolean');
  }
  assert.equal(recordFromRenderer(log, { kind: 'ui-view', view: 'settings', session: 'spoofed' }, ctx), true);
  assert.equal(read().at(-1).session, 'sess-1', 'the main process sets session, not the renderer');
});

test('a bare ask-submitted is refused; counts must be whole numbers', (t) => {
  const { log } = setup(t);
  assert.equal(log.record({ kind: 'ask-submitted', askKey: 'CARD-1@2026-11-12T10:00:00.000Z' }), false);
  assert.equal(log.record({ kind: 'ask-submitted', askKey: 'CARD-1@2026-11-12T10:00:00.000Z', surface: 'ask-me', answerLen: 4, answerShape: 'done-ack' }), true);
  assert.equal(log.record({ kind: 'ui-view-end', view: 'settings', dwellMs: 1.5 }), false);
});

test('Delete removes the day files and digests the app wrote, and nothing else', (t) => {
  const { log, dir } = setup(t);
  log.record({ kind: 'ui-view', view: 'settings' });
  fs.writeFileSync(path.join(dir, 'digest-2026-W45.md'), '# d\n');
  fs.writeFileSync(path.join(dir, 'weekly-notes.md'), 'not written by the app');
  assert.equal(log.deleteAll(), 2);
  assert.deepEqual(fs.readdirSync(dir), ['weekly-notes.md']);
});
