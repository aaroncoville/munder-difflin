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

test('an authoritative log with any line edited or removed, newest included, or rewritten whole, will not open', () => {
  const lines = (t) => t.slice(0, -1).split('\n');
  const cases = {
    'middle edited': (t) => t.replace('"to":"mergeable"', '"to":"abandoned"'),
    'middle removed': (t) => t.split('\n').filter((_, i) => i !== 1).join('\n'),
    'newest edited': (t) => t.replace('"to":"merged"', '"to":"live"  '),
    'newest removed': (t) => `${lines(t).slice(0, 2).join('\n')}\n`,
    'all but the first removed': (t) => `${lines(t)[0]}\n`,
    'emptied': () => '',
    // Rewritten from the first line by someone who knows the chain's algorithm.
    'rewritten whole': (t) => {
      let prev = core.GENESIS;
      return lines(t).map((l) => {
        const e = { ...JSON.parse(l), prev, note: 'rewritten' };
        const text = JSON.stringify(e);
        prev = core.hashLine(text);
        return text;
      }).join('\n') + '\n';
    },
    'another card\'s line': (t) => t.replace(/"card":"WF-FB-VEHICLES"/, '"card":"OTHER"'),
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

// --- The head anchor, crashes, and the mirror as untrusted output (review of #83) ---

const anchorFile = (r, card = 'WF-FB-VEHICLES') => path.join(r.authRoot, card, 'head.json');

test('a log whose head anchor is missing will not open: the anchor is what proves nothing was cut off', () => {
  const r = roots();
  open(r).append({ type: 'fact' });
  fs.rmSync(anchorFile(r));
  assert.throws(() => open(r), LogTamperError);
});

test('a torn last line after a crash is repaired, not taken for tampering, and the repair is logged', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact', n: 1 });
  const file = path.join(r.authRoot, 'WF-FB-VEHICLES', 'log.jsonl');
  fs.appendFileSync(file, '{"type":"fact","v":1,"se');
  const again = open(r);
  const ls = again.lines();
  assert.deepEqual(ls.map((l) => l.n ?? l.fact), [1, 'log-repaired']);
  assert.equal(ls[1].dropped_bytes, '{"type":"fact","v":1,"se'.length);
  assert.equal(core.verifyLogText(authText(r)).ok, true);
});

test('a torn last line is not repaired when the anchor does not point at the line before it', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact', n: 1 });
  log.append({ type: 'fact', n: 2 });
  const file = path.join(r.authRoot, 'WF-FB-VEHICLES', 'log.jsonl');
  // Cut back to line 1, then tear: the anchor still says 2.
  fs.writeFileSync(file, `${authText(r).split('\n')[0]}\n{"torn`);
  const before = authText(r);
  assert.throws(() => open(r), LogTamperError);
  // Nothing was cut: the evidence stays as it was found.
  assert.equal(authText(r), before);
});

test('a whole log and anchor copied in from another card will not open as this card\'s', () => {
  const r = roots();
  open(r, 'A-1').append({ type: 'transition', to: 'mergeable' });
  fs.mkdirSync(path.join(r.authRoot, 'B-2'), { recursive: true });
  for (const f of ['log.jsonl', 'head.json']) fs.copyFileSync(path.join(r.authRoot, 'A-1', f), path.join(r.authRoot, 'B-2', f));
  assert.throws(() => open(r, 'B-2'), LogTamperError);
});

test('a crash between the line and its anchor update reopens cleanly: the line is kept', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact', n: 1 });
  const anchor = fs.readFileSync(anchorFile(r), 'utf8');
  log.append({ type: 'fact', n: 2 });
  fs.writeFileSync(anchorFile(r), anchor);
  assert.deepEqual(open(r).lines().map((l) => l.n), [1, 2]);
});

test('a second writer on the same card is refused rather than forking the chain', () => {
  const r = roots();
  const a = open(r);
  const b = open(r);
  a.append({ type: 'fact' });
  assert.throws(() => b.append({ type: 'fact' }), LogTamperError);
  assert.equal(core.verifyLogText(authText(r)).ok, true);
});

test('a mirror that is merely behind reads "behind", not "differs", and is brought up to date', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact' });
  const one = fs.readFileSync(mirrorFile(r), 'utf8');
  log.append({ type: 'fact' });
  fs.writeFileSync(mirrorFile(r), one);
  assert.equal(log.mirrorStatus(), 'behind');
  log.restoreMirror();
  assert.equal(log.mirrorStatus(), 'same');
});

function planted() {
  const r = roots();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-outside-'));
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'precious\n');
  return { r, outside, victim };
}

test('a mirror log planted as a link is never written through: the outside file is untouched', () => {
  const { r, victim } = planted();
  fs.mkdirSync(path.join(r.mirrorRoot, 'WF-FB-VEHICLES'), { recursive: true });
  fs.symlinkSync(victim, mirrorFile(r));
  const log = open(r);
  log.append({ type: 'fact' });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  assert.equal(log.mirrorStatus(), 'differs');
  log.restoreMirror();
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  assert.equal(fs.lstatSync(mirrorFile(r)).isSymbolicLink(), false);
  assert.equal(log.mirrorStatus(), 'same');
});

test('a restore through a planted temp-file link writes nothing outside', () => {
  const { r, victim } = planted();
  const log = open(r);
  log.append({ type: 'fact' });
  fs.symlinkSync(victim, `${mirrorFile(r)}.tmp`);
  log.restoreMirror();
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious\n');
  assert.equal(log.mirrorStatus(), 'same');
});

test('a mirror card folder, or the mirror root itself, planted as a link is not written into', () => {
  for (const which of ['card', 'root']) {
    const { r, outside } = planted();
    if (which === 'card') {
      fs.mkdirSync(r.mirrorRoot, { recursive: true });
      fs.symlinkSync(outside, path.join(r.mirrorRoot, 'WF-FB-VEHICLES'));
    } else {
      fs.mkdirSync(path.dirname(r.mirrorRoot), { recursive: true });
      fs.symlinkSync(outside, r.mirrorRoot);
    }
    const log = open(r);
    log.append({ type: 'fact' });
    log.restoreMirror();
    assert.deepEqual(fs.readdirSync(outside).sort(), ['victim.txt'], which);
    assert.equal(fs.readFileSync(path.join(outside, 'victim.txt'), 'utf8'), 'precious\n', which);
    assert.equal(log.mirrorStatus(), 'differs', which);
  }
});
