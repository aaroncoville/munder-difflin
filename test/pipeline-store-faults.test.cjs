'use strict';
// A fault-injection sweep over the card log. Every filesystem call the store makes
// to change something is wrapped, so a scenario can be run with its Nth call
// failing (EIO), or with its Nth write accepting only part of the bytes, for every
// N until no call is left. After each fault the log is reopened with no faults and
// must hold: the chain verifies, no committed line is lost or doubled, the sequence
// numbers run without a gap, a repair that dropped bytes is on record exactly once,
// no temp or marker file is left behind, and a writer that failed takes no more.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const core = require('../src/main/pipeline/mr-core.cjs');

const { CardLog } = loadTs('src/main/pipeline/store.ts');

const CARD = 'WF-FB-VEHICLES';
const TORN = '{"v":1,"seq":3,"note":"é torn';
const WRAPPED = ['openSync', 'writeSync', 'fsyncSync', 'ftruncateSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'appendFileSync'];

function newRoot() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-faults-'));
  return path.join(base, 'app', 'pipeline');
}
const open = (authRoot) => new CardLog({ authRoot, card: CARD });
const cardDir = (authRoot) => path.join(authRoot, CARD);
const logFile = (authRoot) => path.join(cardDir(authRoot), 'log.jsonl');

/**
 * Runs [body] with the [nth] wrapped call failing: mode 'eio' throws EIO from any
 * wrapped call; mode 'short' makes the nth writeSync write half its bytes and say so.
 * Returns whether the fault fired.
 */
function withFault(mode, nth, body) {
  const real = {};
  let calls = 0;
  let fired = false;
  for (const name of WRAPPED) {
    real[name] = fs[name];
    if (mode === 'short' && name !== 'writeSync') continue;
    fs[name] = (...args) => {
      if (fired || ++calls !== nth) return real[name](...args);
      fired = true;
      if (mode === 'eio') throw Object.assign(new Error(`EIO: injected at ${name}`), { code: 'EIO' });
      const [fd, data] = args;
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
      return real.writeSync(fd, buf, 0, Math.max(1, Math.floor(buf.length / 2)));
    };
  }
  try { body(); } finally { for (const name of WRAPPED) fs[name] = real[name]; }
  return fired;
}

/**
 * Each scenario: setup (no faults) returns what it committed and any live writer;
 * op is the faulted operation. `extra` is a line the op may add (at most once);
 * `repair` says the reopened log must carry exactly one log-repaired fact.
 */
const SCENARIOS = {
  'new log, first append': {
    setup: () => ({ committed: [] }),
    op: (root, ctx) => { ctx.writer = open(root); ctx.writer.append({ type: 'fact', n: 'op' }); },
    extra: 'op',
  },
  'append to an existing log': {
    setup: (root) => { const w = open(root); w.append({ type: 'fact', n: 1 }); w.append({ type: 'fact', n: 2 }); return { committed: [1, 2], writer: w }; },
    op: (root, ctx) => { ctx.writer.append({ type: 'fact', n: 'op' }); },
    extra: 'op',
  },
  'open with a torn tail': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', n: 1 }); w.append({ type: 'fact', n: 2 });
      fs.appendFileSync(logFile(root), TORN);
      return { committed: [1, 2] };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
    repair: true,
  },
  'open one line past the anchor': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', n: 1 });
      const anchor = fs.readFileSync(path.join(cardDir(root), 'head.json'), 'utf8');
      w.append({ type: 'fact', n: 2 });
      fs.writeFileSync(path.join(cardDir(root), 'head.json'), anchor);
      return { committed: [1, 2] };
    },
    op: (root, ctx) => { ctx.writer = open(root); },
  },
  'restore of the export copy': {
    setup: (root) => {
      const w = open(root); w.append({ type: 'fact', n: 1 }); w.append({ type: 'fact', n: 2 });
      fs.rmSync(path.join(root, '_export'), { recursive: true, force: true });
      return { committed: [1, 2], writer: w, keepsWriter: true };
    },
    op: (root, ctx) => { ctx.writer.restoreMirror(); },
    restores: true,
  },
};

/** Everything that went wrong in one cell, as strings; empty when the invariants hold. */
function checkCell(name, sc, mode, nth) {
  const root = newRoot();
  const ctx = sc.setup(root);
  let error = null;
  const fired = withFault(mode, nth, () => { try { sc.op(root, ctx); } catch (e) { error = e; } });
  if (!fired) return { fired, problems: [] };
  const problems = [];
  const say = (p) => problems.push(p);
  // A writer that saw its operation fail takes no more appends (the export copy is not the log).
  if (error && ctx.writer && !ctx.keepsWriter) {
    let refused = false;
    try { ctx.writer.append({ type: 'fact', n: 'after' }); } catch { refused = true; }
    if (!refused) say('the failed writer took another append');
  }
  let lines;
  try { lines = open(root).lines(); } catch (e) { say(`reopen failed: ${e.message}`); return { fired, problems }; }
  const text = fs.existsSync(logFile(root)) ? fs.readFileSync(logFile(root), 'utf8') : '';
  if (!core.verifyLogText(text, { card: CARD }).ok) say('the chain does not verify');
  if (text !== '' && !text.endsWith('\n')) say('a torn tail is left');
  lines.forEach((l, i) => { if (l.seq !== i + 1) say(`seq ${l.seq} at line ${i + 1}`); });
  const ns = lines.filter((l) => l.n !== undefined && l.n !== 'after').map((l) => l.n);
  const committed = ns.filter((n) => n !== sc.extra);
  if (JSON.stringify(committed) !== JSON.stringify(ctx.committed)) say(`committed lines ${JSON.stringify(committed)}, want ${JSON.stringify(ctx.committed)}`);
  if (sc.extra && ns.filter((n) => n === sc.extra).length > 1) say('the op line is there twice');
  const repairs = lines.filter((l) => l.fact === 'log-repaired').length;
  if (sc.repair && repairs !== 1) say(`${repairs} log-repaired facts, want 1`);
  for (const l of lines.filter((x) => x.fact === 'log-repaired')) {
    if (l.dropped_bytes !== Buffer.byteLength(TORN)) say(`the repair says ${l.dropped_bytes} bytes dropped, want ${Buffer.byteLength(TORN)}`);
  }
  if (!sc.repair && repairs !== 0) say(`${repairs} log-repaired facts, want 0`);
  const leftover = fs.readdirSync(cardDir(root)).filter((f) => !['head.json', 'log.jsonl'].includes(f));
  if (leftover.length) say(`left in the card folder: ${leftover.join(', ')}`);
  const exportDir = path.join(root, '_export', CARD);
  // A restore that reports success has put back the whole log.
  if (sc.restores && !error && fs.readFileSync(path.join(exportDir, 'log.jsonl'), 'utf8') !== text) say('the restored export copy is not the log');
  if (fs.existsSync(exportDir)) {
    const stray = fs.readdirSync(exportDir).filter((f) => f !== 'log.jsonl');
    if (stray.length) say(`left in the export folder: ${stray.join(', ')}`);
  }
  try {
    const next = open(root).append({ type: 'fact', n: 'next' });
    if (next.seq !== lines.length + 1) say(`next seq ${next.seq}, want ${lines.length + 1}`);
  } catch (e) { say(`append after reopen failed: ${e.message}`); }
  return { fired, problems };
}

test('fault-injection sweep: every failing call and every short write, in every scenario, reopens whole', () => {
  const failures = [];
  let cells = 0;
  for (const [name, sc] of Object.entries(SCENARIOS)) {
    for (const mode of ['eio', 'short']) {
      for (let nth = 1; nth < 200; nth++) {
        const { fired, problems } = checkCell(name, sc, mode, nth);
        if (!fired) break;
        cells += 1;
        for (const p of problems) failures.push(`${name} / ${mode} #${nth}: ${p}`);
      }
    }
  }
  if (process.env.SWEEP_REPORT) console.log(`cells: ${cells}\n${failures.join('\n')}`);
  assert.ok(cells > 40, `only ${cells} cells ran`);
  assert.deepEqual(failures, []);
});
