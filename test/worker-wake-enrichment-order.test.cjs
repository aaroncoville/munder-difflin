'use strict';

// The wake beat types a nudge, submits it with Enter a moment later, and reads
// the diagnostics for its stall lines. These cases run the real nudgeWorker,
// enrichment scheduler and runWorkerWakeBeat source on real timers, with the
// services around them stubbed, so the ordering is observed rather than read
// off the source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { enrichStallLines, STALL_ENRICH_BUDGET_MS } = loadTs('src/main/codexActivity.ts');
const REPO = path.resolve(__dirname, '..');
const SLOW_READ_MS = 120;

function beatSource() {
  const src = fs.readFileSync(path.join(REPO, 'src/main/index.ts'), 'utf8');
  const start = src.indexOf('const WORKER_WAKE_POLL_MS = 15_000;');
  const end = src.indexOf('/** (Re)arm the always-on beats');
  assert.ok(start >= 0 && end > start, 'wake beat located in index.ts');
  return ts.transpileModule(src.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

/** One Codex worker with mail. Beat i nudges it when nudges[i]; beat i's
 *  skip-log observation throws when failObserve[i]. The first diagnostic read
 *  is slow, like an uncached walk of a large history. */
function floor({ nudges, failObserve = [] }) {
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const events = [];
  const observed = [];
  let beat = -1;
  let reads = 0;
  let catchups = 0;
  const ctx = vm.createContext({
    // The code's own timers must not keep this process alive: a broken drain
    // that re-arms forever has to fail its assertions, not hang the run.
    setTimeout: (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref(); return handle; },
    performance, Date, Set,
    console: { log() {}, warn() {}, error() {} },
    join: path.join,
    hive: {
      enabled: () => true,
      registry: () => ({ godId: 'god', agents: { worker: { provider: 'codex' } } }),
      root: () => '/hive',
      inbox: () => [{ id: 'mail' }],
      appendLog: () => {}
    },
    ptyForAgent: () => 'pty',
    control: { snapshot: () => ({}) },
    ptyManager: {
      lastOutputAt: () => 1,
      write: (_, text) => { events.push([text === '\r' ? 'enter' : 'text', at()]); return { ok: true }; }
    },
    inboxNudgeText: () => 'nudge',
    workerWake: { decideWithReasons: () => { beat += 1; return [{ agentId: 'worker', nudge: !!nudges[beat] }]; } },
    wakeSkipLog: {
      observe: (_, now) => {
        const b = observed.length;
        observed.push(now);
        if (failObserve[b]) throw new Error('observe failed');
        return [{ agentId: 'worker', quietMs: 1 }];
      },
      recordDelivery: () => []
    },
    codexHomes: { homeOf: (_, home) => home },
    codexActivityCache: {},
    codexCatchupCache: { read: (_, __, fn) => fn() },
    lastCatchupAt: () => { catchups += 1; return null; },
    openCodexLogDb: () => {},
    codexAgentActiveAt: () => {
      events.push(['read', at()]);
      if (reads++ === 0) { const s = performance.now(); while (performance.now() - s < SLOW_READ_MS) { /* a slow disk */ } }
      return null;
    },
    enrichStallLines,
    STALL_ENRICH_BUDGET_MS
  });
  vm.runInContext(beatSource(), ctx);
  return { beat: () => ctx.runWorkerWakeBeat(), events, observed, catchups: () => catchups };
}

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** No diagnostic read may start while any nudge's text is typed and its Enter
 *  has not fired. Counted, so overlapping nudges from two beats are covered. */
function assertSubmissionsIsolated(events) {
  let awaitingEnter = 0;
  for (const [kind, t] of events) {
    if (kind === 'text') awaitingEnter += 1;
    else if (kind === 'enter') awaitingEnter -= 1;
    else if (kind === 'read' && awaitingEnter > 0) {
      assert.fail(`a read at ${t} ms started while a nudge awaited its Enter: ${JSON.stringify(events)}`);
    }
  }
}

test('a beat submits its nudge before any stall-line reading starts', async () => {
  const f = floor({ nudges: [true] });
  f.beat();
  await settle(500);
  assert.deepEqual(f.events.map(([k]) => k).slice(0, 3), ['text', 'enter', 'read']);
  assertSubmissionsIsolated(f.events);
  assert.equal(f.observed.length, 1, 'the enrichment still ran');
  assert.equal(f.catchups(), 0, 'the slow first reader spent the budget, so catch-up was not started');
});

test('a rearmed beat\'s nudge is not held behind the previous beat\'s enrichment', async () => {
  // Rearming runs a beat at once. Here the first beat has nothing to deliver
  // and reads its diagnostics; a second beat 20 ms later finds new mail.
  const f = floor({ nudges: [false, true] });
  f.beat();
  setTimeout(() => f.beat(), 20);
  await settle(800);
  assertSubmissionsIsolated(f.events);
  const text = f.events.find(([k]) => k === 'text')?.[1];
  const enter = f.events.find(([k]) => k === 'enter')?.[1];
  assert.ok(text !== undefined && enter !== undefined, JSON.stringify(f.events));
  assert.ok(enter - text <= 140 + 60, `the Enter came ${enter - text} ms after its text: ${JSON.stringify(f.events)}`);
  assert.equal(f.observed.length, 2, 'both beats still produce their stall lines');
});

test('when two beats\' nudges overlap, every read waits for both Enters, oldest beat first', async () => {
  const f = floor({ nudges: [true, true] });
  f.beat();
  setTimeout(() => f.beat(), 20);
  await settle(800);
  assertSubmissionsIsolated(f.events);
  assert.equal(f.observed.length, 2);
  assert.ok(f.observed[0] < f.observed[1], `beats enriched out of order: ${f.observed}`);
});

test('an enrichment that fails neither escapes its timer nor strands the next beat\'s', async () => {
  const f = floor({ nudges: [true, true], failObserve: [true] });
  f.beat();
  setTimeout(() => f.beat(), 20);
  await settle(800);
  assert.equal(f.observed.length, 2, 'the second beat was still enriched');
});
