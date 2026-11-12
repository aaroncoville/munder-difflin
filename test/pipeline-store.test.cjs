'use strict';
// The pipeline's per-card transition log (spec 12.3 and 11). The authoritative copy
// lives in the app's own data directory, where agents cannot write; a mirror under
// hive/pipeline/ is there to read. Each line carries the hash of the line before,
// so an edited or removed line is found by a script. The mirror is compared with
// the authoritative copy, never trusted over it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const core = require('../src/main/pipeline/mr-core.cjs');

const { CardLog, LogTamperError } = loadTs('src/main/pipeline/store.ts');

function roots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-store-'));
  return { authRoot: path.join(base, 'app', 'pipeline'), mirrorRoot: path.join(base, 'hive', 'pipeline') };
}
const clock = () => { let t = Date.parse('2026-11-12T04:44:02.000Z'); return () => new Date((t += 1000)); };
const open = (r, card = 'WF-FB-VEHICLES') => new CardLog({ ...r, card, now: clock() });
const authText = (r, card = 'WF-FB-VEHICLES') => fs.readFileSync(path.join(r.authRoot, card, 'log.jsonl'), 'utf8');
const mirrorFile = (r, card = 'WF-FB-VEHICLES') => path.join(r.mirrorRoot, card, 'log.jsonl');

test('each appended line is numbered, timed, chained to the one before, and mirrored', () => {
  const r = roots();
  const log = open(r);
  const a = log.append({ type: 'transition', from: null, to: 'implementing', by: 'god' });
  const b = log.append({ type: 'fact', probe: 'forge', head: 'x' });
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
  assert.equal(a.v, 1);
  assert.equal(a.card, 'WF-FB-VEHICLES');
  assert.equal(a.prev, core.GENESIS);
  const [first] = authText(r).split('\n');
  assert.equal(b.prev, core.hashLine(first));
  assert.deepEqual(core.verifyLogText(authText(r)), { ok: true, count: 2, last: core.hashLine(authText(r).split('\n')[1]) });
  assert.equal(fs.readFileSync(mirrorFile(r), 'utf8'), authText(r));
  assert.equal(log.mirrorStatus(), 'same');
});

test('the store sets seq, prev, v, card and at itself: an entry cannot forge them', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact' });
  const line = log.append({ type: 'fact', seq: 99, prev: 'f'.repeat(64), v: 7, card: 'OTHER', at: '1999-01-01T00:00:00Z' });
  assert.equal(line.seq, 2);
  assert.notEqual(line.prev, 'f'.repeat(64));
  assert.equal(line.v, 1);
  assert.equal(line.card, 'WF-FB-VEHICLES');
  assert.notEqual(line.at, '1999-01-01T00:00:00Z');
  assert.equal(core.verifyLogText(authText(r)).ok, true);
});

test('a log reopened after a restart carries on from its last line', () => {
  const r = roots();
  open(r).append({ type: 'fact', n: 1 });
  const again = open(r);
  assert.deepEqual(again.lines().map((l) => l.n), [1]);
  assert.equal(again.append({ type: 'fact', n: 2 }).seq, 2);
  assert.equal(core.verifyLogText(authText(r)).ok, true);
});

test('an edited line in the mirror is found, the authoritative log is untouched, and the mirror can be put back', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'transition', to: 'review' });
  log.append({ type: 'transition', to: 'mergeable' });
  const before = authText(r);
  fs.writeFileSync(mirrorFile(r), fs.readFileSync(mirrorFile(r), 'utf8').replace('mergeable', 'merged   '));
  assert.equal(log.mirrorStatus(), 'differs');
  assert.equal(authText(r), before);
  log.restoreMirror();
  assert.equal(log.mirrorStatus(), 'same');
  assert.equal(fs.readFileSync(mirrorFile(r), 'utf8'), before);
});

test('a deleted mirror is reported missing, not as tampering with the log itself', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact' });
  fs.rmSync(mirrorFile(r));
  assert.equal(log.mirrorStatus(), 'missing');
});

test('an authoritative log with an edited, removed or torn line will not open', () => {
  const cases = {
    edited: (t) => t.replace('"to":"review"', '"to":"merged"'),
    removed: (t) => t.split('\n').filter((_, i) => i !== 1).join('\n'),
    torn: (t) => t.slice(0, -5),
  };
  for (const [what, damage] of Object.entries(cases)) {
    const r = roots();
    const log = open(r);
    log.append({ type: 'transition', to: 'review' });
    log.append({ type: 'transition', to: 'mergeable' });
    log.append({ type: 'transition', to: 'merged' });
    const file = path.join(r.authRoot, 'WF-FB-VEHICLES', 'log.jsonl');
    fs.writeFileSync(file, damage(fs.readFileSync(file, 'utf8')));
    assert.throws(() => open(r), LogTamperError, what);
  }
});

test('a card id that could leave the log directory is refused', () => {
  for (const card of ['../tasks', 'a/b', '', '.hidden']) {
    assert.throws(() => open(roots(), card), /card id/, card);
  }
});

test('each card has its own log and its own chain', () => {
  const r = roots();
  open(r, 'A-1').append({ type: 'fact' });
  const b = open(r, 'B-2');
  assert.equal(b.append({ type: 'fact' }).seq, 1);
  assert.equal(b.lines().length, 1);
});
