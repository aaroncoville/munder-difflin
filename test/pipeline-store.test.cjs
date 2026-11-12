'use strict';
// The pipeline's per-card transition log (spec 12.3 and 11). The authoritative copy
// lives in the app's own data directory, where agents cannot write; an export copy
// beside it is there to read. Each line carries the hash of the line before, so an
// edited or removed line is found by a script. The export is compared with the
// authoritative copy, never trusted over it. Nothing is written under the hive.

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
  return { base, authRoot: path.join(base, 'app', 'pipeline'), hiveRoot: path.join(base, 'hive') };
}
const clock = () => { let t = Date.parse('2026-11-12T04:44:02.000Z'); return () => new Date((t += 1000)); };
const open = (r, card = 'WF-FB-VEHICLES') => new CardLog({ authRoot: r.authRoot, card, now: clock() });
const authText = (r, card = 'WF-FB-VEHICLES') => fs.readFileSync(path.join(r.authRoot, card, 'log.jsonl'), 'utf8');
const mirrorFile = (r, card = 'WF-FB-VEHICLES') => path.join(r.authRoot, '_export', card, 'log.jsonl');

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

// --- Nothing under the hive: the export lives in app data ---

/** Every path under [dir], with what it is, a link's target and a file's bytes. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) out[p] = `link -> ${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { out[p] = 'dir'; walk(p); }
      else out[p] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

test('no pipeline write lands under the hive, even when the old mirror path is offered and full of planted links', () => {
  const r = roots();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-outside-'));
  fs.writeFileSync(path.join(outside, 'log.jsonl'), 'SAFE\n');
  // What an agent could plant where the mirror used to be written.
  const hivePipeline = path.join(r.hiveRoot, 'pipeline');
  fs.mkdirSync(hivePipeline, { recursive: true });
  fs.symlinkSync(outside, path.join(hivePipeline, 'WF-FB-VEHICLES'));
  fs.symlinkSync(outside, path.join(hivePipeline, 'A-1'));
  const hiveBefore = snapshot(r.hiveRoot);
  const outsideBefore = snapshot(outside);

  // A caller still passing the old option gets nothing written there.
  const log = new CardLog({ authRoot: r.authRoot, mirrorRoot: hivePipeline, card: 'WF-FB-VEHICLES', now: clock() });
  log.append({ type: 'transition', to: 'review' });
  log.append({ type: 'fact', n: 2 });
  fs.writeFileSync(mirrorFile(r), 'edited\n');
  assert.equal(log.mirrorStatus(), 'differs');
  log.restoreMirror();
  assert.equal(log.mirrorStatus(), 'same');
  fs.appendFileSync(path.join(r.authRoot, 'WF-FB-VEHICLES', 'log.jsonl'), '{"torn');
  open(r).append({ type: 'fact', n: 4 });
  open(r, 'A-1').append({ type: 'fact' });

  assert.deepEqual(snapshot(r.hiveRoot), hiveBefore);
  assert.deepEqual(snapshot(outside), outsideBefore);
  // Everything the store made is under its app-data root.
  for (const p of Object.keys(snapshot(r.base))) {
    assert.ok(p.startsWith(r.hiveRoot) || p === path.dirname(r.authRoot) || p.startsWith(r.authRoot), p);
  }
});

// --- The genesis anchor and the first append ---

test('a new card\'s log gets a genesis anchor on disk before its first line', () => {
  const r = roots();
  open(r);
  assert.deepEqual(JSON.parse(fs.readFileSync(anchorFile(r), 'utf8')), { seq: 0, hash: core.GENESIS });
});

test('a crash on the very first append, after the line and before its anchor, reopens cleanly: the line is kept', () => {
  const r = roots();
  const log = open(r);
  const genesis = fs.readFileSync(anchorFile(r), 'utf8');
  log.append({ type: 'fact', n: 1 });
  fs.writeFileSync(anchorFile(r), genesis);
  const again = open(r);
  assert.deepEqual(again.lines().map((l) => l.n), [1]);
  assert.equal(again.append({ type: 'fact', n: 2 }).seq, 2);
});

test('two lines past the genesis anchor, or a first line torn, are told apart from that crash', () => {
  const r = roots();
  const log = open(r);
  const genesis = fs.readFileSync(anchorFile(r), 'utf8');
  log.append({ type: 'fact', n: 1 });
  log.append({ type: 'fact', n: 2 });
  fs.writeFileSync(anchorFile(r), genesis);
  assert.throws(() => open(r), LogTamperError);

  const t = roots();
  open(t);
  fs.writeFileSync(path.join(t.authRoot, 'WF-FB-VEHICLES', 'log.jsonl'), '{"torn');
  assert.deepEqual(open(t).lines().map((l) => l.fact), ['log-repaired']);
});

test('the new log, the genesis anchor and every anchor move are synced in their folder too', () => {
  const r = roots();
  const dir = path.join(r.authRoot, 'WF-FB-VEHICLES');
  const synced = [];
  const real = fs.fsyncSync;
  fs.fsyncSync = (fd) => {
    const st = fs.fstatSync(fd);
    if (st.isDirectory()) synced.push(st.ino);
    return real(fd);
  };
  try {
    const log = open(r);
    const ino = fs.statSync(dir).ino;
    assert.equal(synced.filter((i) => i === ino).length, 1, 'genesis anchor');
    log.append({ type: 'fact' });
    assert.equal(synced.filter((i) => i === ino).length, 3, 'new log file and the anchor move');
    log.append({ type: 'fact' });
    assert.equal(synced.filter((i) => i === ino).length, 4, 'the anchor move');
  } finally {
    fs.fsyncSync = real;
  }
});

test('an append that fails after its line is on disk means reopen and look, not retry: the line is kept once', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact', n: 1 });
  const real = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'head.json') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    return real(from, to);
  };
  try {
    assert.throws(() => log.append({ type: 'fact', n: 2 }), /ENOSPC/);
  } finally {
    fs.renameSync = real;
  }
  // The line is on disk; this writer is done rather than writing it a second time.
  assert.throws(() => log.append({ type: 'fact', n: 2 }), LogTamperError);
  const again = open(r);
  assert.deepEqual(again.lines().map((l) => l.n), [1, 2]);
  assert.equal(again.append({ type: 'fact', n: 3 }).seq, 3);
  assert.deepEqual(fs.readdirSync(path.join(r.authRoot, 'WF-FB-VEHICLES')).sort(), ['head.json', 'log.jsonl']);
});

/** Replaces fsyncSync for folders only; [how] decides per call. Returns the folder inodes synced. */
function onFolderSync(how, body) {
  const real = fs.fsyncSync;
  const synced = [];
  fs.fsyncSync = (fd) => {
    if (fs.fstatSync(fd).isDirectory()) { synced.push(fs.fstatSync(fd).ino); how(); }
    return real(fd);
  };
  try { body(); } finally { fs.fsyncSync = real; }
  return synced;
}
const failWith = (code) => () => { throw Object.assign(new Error(`${code}: injected`), { code }); };

test('a new card folder, and every folder made on the way to it, is synced in its parent', () => {
  const r = roots();
  const synced = onFolderSync(() => {}, () => open(r));
  const app = path.dirname(r.authRoot);
  for (const [name, dir] of [['base (holds app)', r.base], ['app (holds pipeline)', app], ['authRoot (holds the card)', r.authRoot]]) {
    assert.ok(synced.includes(fs.statSync(dir).ino), name);
  }
  const second = onFolderSync(() => {}, () => open(r, 'WF-OTHER'));
  assert.ok(second.includes(fs.statSync(r.authRoot).ino), 'a second card in an existing root syncs the root');
  assert.ok(!second.includes(fs.statSync(app).ino), 'folders that already existed are not walked');
});

test('a folder sync that fails with a real error fails the open or the append, not swallowed', () => {
  for (const code of ['EIO', 'ENOSPC', 'EACCES']) {
    const r = roots();
    assert.throws(() => onFolderSync(failWith(code), () => open(r)), new RegExp(code), `open, ${code}`);
    const r2 = roots();
    const log = open(r2);
    assert.throws(() => onFolderSync(failWith(code), () => log.append({ type: 'fact' })), new RegExp(code), `append, ${code}`);
  }
});

test('a platform that cannot sync folders at all is tolerated, by its named error codes only', () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EISDIR']) {
    const r = roots();
    onFolderSync(failWith(code), () => {
      const log = open(r);
      assert.equal(log.append({ type: 'fact' }).seq, 1, code);
    });
  }
});

test('a folder that cannot be opened for its sync fails the open, unless the platform opens no folder', () => {
  const real = fs.openSync;
  const withOpen = (code, body) => {
    fs.openSync = (p, ...rest) => {
      if (fs.existsSync(p) && fs.statSync(p).isDirectory()) throw Object.assign(new Error(`${code}: injected`), { code });
      return real(p, ...rest);
    };
    try { body(); } finally { fs.openSync = real; }
  };
  withOpen('EACCES', () => assert.throws(() => open(roots()), /EACCES/));
  withOpen('EISDIR', () => assert.equal(open(roots()).append({ type: 'fact' }).seq, 1));
});

/**
 * Makes the [nth] call (1-based) to fs[fn] during [body] throw EIO, optionally only
 * for calls [where] accepts. Returns whether it fired.
 */
function eioAt(fn, nth, body, where = () => true) {
  const real = fs[fn];
  let calls = 0;
  let fired = false;
  fs[fn] = (...args) => {
    if (where(...args) && ++calls === nth) { fired = true; throw Object.assign(new Error('EIO: injected'), { code: 'EIO' }); }
    return real(...args);
  };
  try { body(); } finally { fs[fn] = real; }
  return fired;
}
const isDirFd = (fd) => fs.fstatSync(fd).isDirectory();
const isFileFd = (fd) => !isDirFd(fd);

// Each step of an append on a log that already has a line: [name, fn, nth, where, line 2 on disk after it].
const APPEND_STEPS = [
  ['line write', 'writeSync', 1, () => true, false],
  ['line fsync', 'fsyncSync', 1, isFileFd, true],
  ['anchor write', 'writeSync', 2, () => true, true],
  ['anchor fsync', 'fsyncSync', 2, isFileFd, true],
  ['anchor rename', 'renameSync', 1, () => true, true],
  ['folder fsync after the anchor move', 'fsyncSync', 1, isDirFd, true],
];

test('a failed append at any step poisons the writer; a reopen keeps what reached disk once and carries on', () => {
  for (const [name, fn, nth, where, kept] of APPEND_STEPS) {
    const r = roots();
    const log = open(r);
    log.append({ type: 'fact', n: 1 });
    let threw = null;
    assert.ok(eioAt(fn, nth, () => { try { log.append({ type: 'fact', n: 2 }); } catch (e) { threw = e; } }, where), `${name}: the fault fired`);
    assert.match(String(threw), /EIO/, `${name}: the append throws`);
    assert.throws(() => log.append({ type: 'fact', n: 3 }), LogTamperError, `${name}: the same writer refuses the next append`);
    const again = open(r);
    const want = kept ? [1, 2] : [1];
    assert.deepEqual(again.lines().map((l) => l.n), want, `${name}: on disk once`);
    assert.equal(again.append({ type: 'fact', n: 9 }).seq, want.length + 1, `${name}: the next seq continues`);
    assert.equal(core.verifyLogText(authText(r), { card: 'WF-FB-VEHICLES' }).ok, true, `${name}: the chain verifies`);
    assert.deepEqual(fs.readdirSync(path.join(r.authRoot, 'WF-FB-VEHICLES')).sort(), ['head.json', 'log.jsonl'], `${name}: no temp file left`);
  }
});

test('the first append into a new log, failing at the new file\'s folder sync, poisons the writer too', () => {
  const r = roots();
  const log = open(r);
  assert.throws(() => eioAt('fsyncSync', 1, () => log.append({ type: 'fact', n: 1 }), isDirFd), /EIO/);
  assert.throws(() => log.append({ type: 'fact', n: 2 }), LogTamperError);
  const again = open(r);
  assert.deepEqual(again.lines().map((l) => [l.seq, l.n]), [[1, 1]]);
  assert.equal(again.append({ type: 'fact', n: 2 }).seq, 2);
});

test('a failed restore of the export copy leaves no temp file behind and the log usable', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact', n: 1 });
  assert.throws(() => eioAt('fsyncSync', 1, () => log.restoreMirror(), isFileFd), /EIO/);
  assert.deepEqual(fs.readdirSync(path.dirname(mirrorFile(r))), ['log.jsonl']);
  assert.equal(log.append({ type: 'fact', n: 2 }).seq, 2);
});

test('an open that fails while writing the genesis anchor or repairing a torn tail throws, and the next open recovers', () => {
  const r = roots();
  assert.throws(() => eioAt('renameSync', 1, () => open(r)), /EIO/, 'genesis anchor');
  assert.equal(open(r).append({ type: 'fact', n: 1 }).seq, 1);

  const t = roots();
  const log = open(t);
  log.append({ type: 'fact', n: 1 });
  fs.appendFileSync(path.join(t.authRoot, 'WF-FB-VEHICLES', 'log.jsonl'), '{"torn":');
  assert.throws(() => eioAt('renameSync', 1, () => open(t)), /EIO/, 'repair append');
  const again = open(t);
  assert.deepEqual(again.lines().map((l) => l.fact ?? l.n), [1, 'log-repaired']);
  assert.equal(again.append({ type: 'fact', n: 2 }).seq, 3);
});

test('a repair marker that does not match the log, or cannot be read, will not open', () => {
  const r = roots();
  const log = open(r);
  log.append({ type: 'fact', n: 1 });
  log.append({ type: 'fact', n: 2 });
  const marker = path.join(r.authRoot, 'WF-FB-VEHICLES', 'repair.json');
  fs.writeFileSync(marker, JSON.stringify({ seq: 0, dropped_bytes: 5 }));
  assert.throws(() => open(r), LogTamperError, 'a marker for another line');
  fs.writeFileSync(marker, '{"seq":');
  assert.throws(() => open(r), LogTamperError, 'an unreadable marker');
  fs.writeFileSync(marker, JSON.stringify({ seq: 2, dropped_bytes: 5 }));
  const fixed = open(r);
  assert.deepEqual(fixed.lines().map((l) => l.fact ?? l.n), [1, 2, 'log-repaired'], 'a marker at the log\'s end finishes its repair');
  assert.equal(fs.existsSync(marker), false);
});
