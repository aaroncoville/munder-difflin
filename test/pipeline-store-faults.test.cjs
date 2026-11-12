'use strict';
// A fault-injection sweep over the card log. Every filesystem function the store
// imports is wrapped (a test below keeps that list in step with store.ts), so a
// scenario can be run with its Nth call faulted, for every N until no call is left.
//
// The fault model: one fault per operation, of one of these kinds: the call fails
// with EIO (existsSync, which never throws, answers false instead, as it does on any
// error); a write accepts only part of its bytes; a write accepts none (returns 0); a
// write lands part of its bytes and then fails. Where that fault leaves something
// for an open to recover, a second fault (EIO or torn write) is swept over the
// recovering open. Faults are injected one at a time, never at random, and a crash is
// modelled as the operation stopping at the faulted call. Bytes a write reported as
// written and a power failure later loses are outside this model. Every line carries
// multi-byte text, and two rows tear or cut inside a character on purpose. After that the log is
// reopened with no faults and must hold: the
// chain verifies, no committed line is lost or doubled, the sequence numbers run
// without a gap, every byte dropped from the log is on record in exactly one
// log-repaired fact, no temp or marker file is left behind, a writer that failed
// takes no more, and the export copy matches the log.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const core = require('../src/main/pipeline/mr-core.cjs');

const { CardLog } = loadTs('src/main/pipeline/store.ts');

// The sweep checks what the store does when a call fails, not whether the disk keeps
// what it was told to flush (that is outside the fault model). So an fsync that is not
// the injected fault only checks its descriptor, and skips the physical flush that
// would otherwise take most of the run. The faulted fsync fails exactly as before.
fs.fsyncSync = (fd) => { fs.fstatSync(fd); };

const CARD = 'WF-FB-VEHICLES';
// Multi-byte text in every line, so a tear or a cut at any byte can land inside a character.
const NOTE = 'é✓𝄞 Zoë’s ✓✓✓ ééé 𝄞𝄞';
const TORN = '{"v":1,"seq":3,"note":"é torn ✓𝄞';
/** A tail that stops after the first byte of a two-byte character. */
const TORN_MID = Buffer.from('{"v":1,"seq":3,"note":"Zoé').subarray(0, -1);
const WRAPPED = ['closeSync', 'existsSync', 'fsyncSync', 'ftruncateSync', 'mkdirSync', 'openSync', 'readFileSync', 'renameSync', 'rmSync', 'writeSync'];
const injected = (name) => Object.assign(new Error(`EIO: injected at ${name}`), { code: 'EIO' });

function newRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-faults-'));
  return path.join(base, 'app', 'pipeline');
}
// A fixed clock makes equal states byte-equal, so each distinct recovery state is swept once.
const open = (authRoot) => new CardLog({ authRoot, card: CARD, now: () => new Date('2026-11-12T00:00:00.000Z') });
const cardDir = (authRoot) => path.join(authRoot, CARD);
const logFile = (authRoot) => path.join(cardDir(authRoot), 'log.jsonl');
const exportFile = (authRoot) => path.join(authRoot, '_export', CARD, 'log.jsonl');
const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

/** Half of what a write call was asked to write, as [buf, off, len] for the real writeSync. */
function half(args) {
  const [, data, off, len] = args;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  const start = Buffer.isBuffer(data) && typeof off === 'number' ? off : 0;
  const size = Buffer.isBuffer(data) && typeof len === 'number' ? len : buf.length - start;
  return [buf, start, Math.max(1, Math.floor(size / 2))];
}

/**
 * Runs [body] with the [nth] wrapped call faulted. 'eio': that call throws without
 * doing anything (existsSync answers false). 'short': that write writes half and
 * says so. 'zero': that write writes nothing and returns 0. 'tear': that write lands
 * half and then throws. Returns whether the fault fired.
 */
function withFault(mode, nth, body) {
  const real = {};
  let calls = 0;
  let fired = false;
  for (const name of WRAPPED) {
    real[name] = fs[name];
    if (mode !== 'eio' && name !== 'writeSync') continue;
    fs[name] = (...args) => {
      if (fired || ++calls !== nth) return real[name](...args);
      fired = true;
      if (mode === 'eio' && name === 'existsSync') return false;
      if (mode === 'eio') throw injected(name);
      if (mode === 'zero') return 0;
      const [buf, off, len] = half(args);
      const n = real.writeSync(args[0], buf, off, len);
      if (mode === 'short') return n;
      throw injected(name);
    };
  }
  try { body(); } finally { for (const name of WRAPPED) fs[name] = real[name]; }
  return fired;
}

/** Counts every byte a truncate actually removed from the log while [body] runs. */
function truncations(body) {
  const real = fs.ftruncateSync;
  let dropped = 0;
  fs.ftruncateSync = (fd, len) => {
    const before = fs.fstatSync(fd).size;
    const out = real(fd, len);
    dropped += Math.max(0, before - fs.fstatSync(fd).size);
    return out;
  };
  try { body(); } finally { fs.ftruncateSync = real; }
  return dropped;
}

/**
 * Each scenario: setup (no faults) returns what it committed and any live writer;
 * op is the faulted operation. `extra` is a line the op may add (at most once).
 */
const SCENARIOS = {
  'new log, first append': {
    setup: () => ({ committed: [] }),
    op: (root, ctx) => { ctx.writer = open(root); ctx.writer.append({ type: 'fact', note: NOTE, n: 'op' }); },
    extra: 'op',
  },
  'append to an existing log': {
    setup: (root) => { const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 }); w.append({ type: 'fact', note: NOTE, n: 2 }); return { committed: [1, 2], writer: w }; },
    op: (root, ctx) => { ctx.writer.append({ type: 'fact', note: NOTE, n: 'op' }); },
    extra: 'op',
  },
  'open with a torn tail': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 }); w.append({ type: 'fact', note: NOTE, n: 2 });
      fs.appendFileSync(logFile(root), TORN);
      return { committed: [1, 2], tornBytes: Buffer.byteLength(TORN) };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
  },
  'open with a tail torn inside a character': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 }); w.append({ type: 'fact', note: NOTE, n: 2 });
      fs.appendFileSync(logFile(root), TORN_MID);
      return { committed: [1, 2], tornBytes: TORN_MID.length };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
  },
  'open with the export copy cut inside a character': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 }); w.append({ type: 'fact', note: NOTE, n: 2 });
      const buf = fs.readFileSync(exportFile(root));
      const at = buf.lastIndexOf(Buffer.from('é')) + 1; // after the first byte of the last 'é'
      fs.writeFileSync(exportFile(root), buf.subarray(0, at));
      return { committed: [1, 2] };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
  },
  'open one line past the anchor': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 });
      const anchor = fs.readFileSync(path.join(cardDir(root), 'head.json'), 'utf8');
      w.append({ type: 'fact', note: NOTE, n: 2 });
      fs.writeFileSync(path.join(cardDir(root), 'head.json'), anchor);
      return { committed: [1, 2] };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
  },
  'open resuming a repair from its marker': {
    // A repair that stopped after its cut: the marker is durable, the log already
    // truncated, and the log-repaired fact not yet written.
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 }); w.append({ type: 'fact', note: NOTE, n: 2 });
      const keep = fs.statSync(logFile(root)).size;
      const tail = require('node:crypto').createHash('sha256').update(TORN).digest('hex');
      const marker = { seq: 2, keep_bytes: keep, size: keep + Buffer.byteLength(TORN), tail, dropped_bytes: Buffer.byteLength(TORN) };
      fs.writeFileSync(path.join(cardDir(root), 'repair.json'), JSON.stringify(marker));
      return { committed: [1, 2], droppedBefore: Buffer.byteLength(TORN) };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
  },
  'restore of the export copy': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', note: NOTE, n: 1 }); w.append({ type: 'fact', note: NOTE, n: 2 });
      fs.rmSync(path.join(root, '_export'), { recursive: true, force: true });
      return { committed: [1, 2], writer: w, keepsWriter: true };
    },
    op: (root, ctx) => { ctx.writer.restoreMirror(); },
    restores: true,
  },
};

/** True when the log on disk still has something an open must recover. */
const pending = (root) => {
  const text = read(logFile(root));
  return (text !== '' && !text.endsWith('\n')) || fs.existsSync(path.join(cardDir(root), 'repair.json'));
};

/** The invariants after a clean reopen; [dropped] is every byte truncated before it. */
function verify(root, ctx, sc, say, dropped, error) {
  if (sc.restores && !error && read(exportFile(root)) !== read(logFile(root))) say('the restore reported success but the export is not the log');
  let lines = [];
  let reopened = null;
  dropped += (ctx.droppedBefore ?? 0) + truncations(() => {
    try { reopened = open(root); lines = reopened.lines(); } catch (e) { say(`reopen failed: ${e.message}`); }
  });
  if (!reopened) return;
  const text = read(logFile(root));
  if (!core.verifyLogText(text, { card: CARD }).ok) say('the chain does not verify');
  if (text !== '' && !text.endsWith('\n')) say('a torn tail is left');
  lines.forEach((l, i) => { if (l.seq !== i + 1) say(`seq ${l.seq} at line ${i + 1}`); });
  const ns = lines.filter((l) => l.n !== undefined && l.n !== 'after').map((l) => l.n);
  const committed = ns.filter((n) => n !== sc.extra);
  if (JSON.stringify(committed) !== JSON.stringify(ctx.committed)) say(`committed lines ${JSON.stringify(committed)}, want ${JSON.stringify(ctx.committed)}`);
  if (sc.extra && ns.filter((n) => n === sc.extra).length > 1) say('the op line is there twice');
  const repairs = lines.filter((l) => l.fact === 'log-repaired');
  if (repairs.length > 1) say(`${repairs.length} log-repaired facts`);
  if (dropped > 0 && repairs.length !== 1) say(`${dropped} bytes dropped but ${repairs.length} log-repaired facts`);
  if (dropped === 0 && repairs.length !== 0) say('a log-repaired fact with nothing dropped');
  if (repairs[0] && repairs[0].dropped_bytes !== dropped) say(`the repair records ${repairs[0].dropped_bytes} bytes, ${dropped} were dropped`);
  if (ctx.tornBytes && dropped < ctx.tornBytes) say(`only ${dropped} bytes dropped, the torn tail was ${ctx.tornBytes}`);
  const leftover = fs.readdirSync(cardDir(root)).filter((f) => !['head.json', 'log.jsonl'].includes(f));
  if (leftover.length) say(`left in the card folder: ${leftover.join(', ')}`);
  const exportDir = path.dirname(exportFile(root));
  if (fs.existsSync(exportDir)) {
    const stray = fs.readdirSync(exportDir).filter((f) => f !== 'log.jsonl');
    if (stray.length) say(`left in the export folder: ${stray.join(', ')}`);
  }
  if (!sc.restores && reopened.mirrorStatus() !== 'same') say(`the export copy reads ${reopened.mirrorStatus()} after the reopen`);
  try {
    const next = reopened.append({ type: 'fact', note: NOTE, n: 'next' });
    if (next.seq !== lines.length + 1) say(`next seq ${next.seq}, want ${lines.length + 1}`);
  } catch (e) { say(`append after reopen failed: ${e.message}`); }
}

const MODES = ['eio', 'short', 'zero', 'tear'];
const SECOND_MODES = ['eio', 'tear'];

test('fault-injection sweep: every failing call, short write and torn write, then a second fault in the recovering open', () => {
  const failures = [];
  const cells = { eio: 0, short: 0, zero: 0, tear: 0, double: 0, dedup: 0 };
  const swept = new Set();
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    for (const mode of MODES) {
      for (let nth = 1; nth < 200; nth++) {
        // The first fault alone.
        const root = newRoot();
        const ctx = sc.setup(root);
        let error = null;
        let fired = false;
        const dropped = truncations(() => { fired = withFault(mode, nth, () => { try { sc.op(root, ctx); } catch (e) { error = e; } }); });
        if (!fired) break;
        cells[mode] += 1;
        const say = (p) => failures.push(`${name} / ${mode} #${nth}: ${p}`);
        if (error && ctx.writer && !ctx.keepsWriter) {
          let refused = false;
          try { ctx.writer.append({ type: 'fact', note: NOTE, n: 'after' }); } catch { refused = true; }
          if (!refused) say('the failed writer took another append');
        }
        // A short write is not a failure: an operation that returned has its export copy whole too.
        if (mode === 'short' && !error && ctx.writer && !sc.restores && ctx.writer.mirrorStatus() !== 'same') say(`the export copy reads ${ctx.writer.mirrorStatus()} after a short write`);
        // Keep the faulted state to sweep the recovering open over, before the clean reopen recovers it.
        const base = path.dirname(path.dirname(root));
        const state = pending(root) ? [name, ...['log.jsonl', 'head.json', 'repair.json'].map((f) => read(path.join(cardDir(root), f)))].join('\0') : null;
        const fresh = state !== null && !swept.has(state);
        if (fresh) swept.add(state);
        else if (state !== null) cells.dedup += 1;
        const snapshot = fresh ? fs.mkdtempSync(path.join(os.tmpdir(), 'mr-snap-')) : null;
        if (snapshot) fs.cpSync(base, snapshot, { recursive: true });
        verify(root, ctx, sc, say, dropped, error);
        fs.rmSync(base, { recursive: true, force: true });
        if (!snapshot) continue;
        for (const mode2 of SECOND_MODES) {
          for (let m = 1; m < 200; m++) {
            const base2 = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-faults2-'));
            fs.cpSync(snapshot, base2, { recursive: true });
            const root2 = path.join(base2, 'app', 'pipeline');
            let fired2 = false;
            const dropped2 = truncations(() => { fired2 = withFault(mode2, m, () => { try { open(root2); } catch { /* the second fault */ } }); });
            if (!fired2) break;
            cells.double += 1;
            verify(root2, ctx, sc, (p) => failures.push(`${name} / ${mode} #${nth}, then ${mode2} #${m} in the recovering open: ${p}`), dropped + dropped2, error);
            fs.rmSync(base2, { recursive: true, force: true });
          }
        }
      }
    }
  }
  if (process.env.SWEEP_REPORT) console.log(`cells: ${JSON.stringify(cells)}\n${failures.join('\n')}`);
  assert.ok(cells.eio > 40 && cells.tear > 5 && cells.double > 20, `too few cells: ${JSON.stringify(cells)}`);
  assert.deepEqual(failures, []);
});

test('the sweep wraps exactly the filesystem functions the store imports', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/main/pipeline/store.ts'), 'utf8');
  const m = src.match(/import \{([^}]*)\} from 'node:fs';/);
  assert.ok(m, 'store.ts imports from node:fs by name');
  const used = m[1].split(',').map((x) => x.trim()).filter((x) => x && x !== 'constants').sort();
  assert.deepEqual(used, [...WRAPPED].sort());
  // and nothing reaches the filesystem another way
  assert.doesNotMatch(src.replace(m[0], ''), /from 'node:fs'|require\('(node:)?fs'\)|\bfs\./);
});
