'use strict';

/**
 * A Codex worker never feeds the OpenTelemetry collector — only Claude Code is
 * given the telemetry environment — so the fleet snapshot used to publish
 * `lastActiveSecAgo: null` for it forever, and the orchestrator's roster read
 * "no activity yet" for an agent that had just finished a turn.
 *
 * Codex does keep its own record of every event it handles: the session's
 * rollout file, appended on each turn, tool call and token count. Its
 * modification time is the Codex equivalent of the last telemetry sample —
 * provided it is read from the home the worker actually runs in, and only for
 * the sessions that are the worker's own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  newestRolloutAt,
  fleetLastActiveAt,
  codexAgentActiveAt,
  ReadingCache
} = loadTs('src/main/codexActivity.ts');

const REPO = path.resolve(__dirname, '..');

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

/** A rollout for `session`, named the way Codex names them, under `tree`. */
function rollout(home, session, seconds, tree = 'sessions', day = '2026/09/08') {
  const file = path.join(home, tree, day, `rollout-2026-09-08T22-52-27-${session}.jsonl`);
  writeAt(file, seconds);
  return file;
}

const S1 = '01a08414-c11e-7900-a709-b6cf3703a742';
const S2 = '01a08415-902d-78a1-90f3-0c67c41be971';
const S3 = '01a08b71-da88-7e03-8e91-2d7813925ebb';

const neverReadDisk = () => { throw new Error('must not read disk'); };

// ─── newestRolloutAt ─────────────────────────────────────────────────────────

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

// ─── fleetLastActiveAt ───────────────────────────────────────────────────────

test('an agent that reports telemetry keeps its telemetry timestamp', () => {
  assert.equal(fleetLastActiveAt('claude', 5_000, neverReadDisk), 5_000);
  assert.equal(fleetLastActiveAt(undefined, 5_000, neverReadDisk), 5_000);
  assert.equal(fleetLastActiveAt('codex', 5_000, neverReadDisk), 5_000);
});

test('a Codex agent without telemetry reads its own activity', () => {
  assert.equal(fleetLastActiveAt('codex', undefined, () => 7_000_000), 7_000_000);
  assert.equal(fleetLastActiveAt('codex', undefined, () => null), null);
});

test('an agent of another provider is never given activity from disk', () => {
  assert.equal(fleetLastActiveAt('claude', undefined, neverReadDisk), null);
  assert.equal(fleetLastActiveAt(undefined, undefined, neverReadDisk), null);
});

// ─── codexAgentActiveAt: the home a worker actually runs in ──────────────────

const NOW = 5_000_000 * 1000;

test('a worker resumed into another agent\'s home reads that home, not its own', (t) => {
  // Resuming a session that another agent's home owns points the worker's
  // CODEX_HOME at that home, because the session's index lives there too.
  const root = tempHome(t);
  const ownerHome = path.join(root, 'agents/original/.codex');
  const ownHome = path.join(root, 'agents/resumed/.codex');
  rollout(ownerHome, S1, 4_000_000);
  const records = new Map([['resumed', { home: ownerHome, session: S1 }]]);

  assert.equal(codexAgentActiveAt('resumed', records, ownHome, NOW), 4_000_000 * 1000);
});

test('a worker resumed into a shared home reads only its own session there', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 3_000_000);                    // the session it resumed
  rollout(ownerHome, S2, 4_000_000, 'sessions', '2026/09/10'); // the owner's own, newer
  const records = new Map([['resumed', { home: ownerHome, session: S1 }]]);

  assert.equal(codexAgentActiveAt('resumed', records, null, NOW), 3_000_000 * 1000);
});

test('the owner of a shared home does not claim sessions others resumed into it', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S2, 3_000_000);                    // the owner's own
  rollout(ownerHome, S1, 4_000_000, 'sessions', '2026/09/10'); // resumed by someone else, newer
  const records = new Map([
    ['original', { home: ownerHome }],
    ['resumed', { home: ownerHome, session: S1 }]
  ]);

  assert.equal(codexAgentActiveAt('original', records, ownerHome, NOW), 3_000_000 * 1000);
});

test('a worker with no record reads the home named after it', (t) => {
  const home = tempHome(t);
  rollout(home, S3, 2_000_000);
  assert.equal(codexAgentActiveAt('fresh', new Map(), home, NOW), 2_000_000 * 1000);
  assert.equal(codexAgentActiveAt('fresh', new Map(), null, NOW), null);
});

test('with no live rollout, archived history is the last activity', (t) => {
  const home = tempHome(t);
  rollout(home, S1, 2_000_000, 'archived_sessions');
  assert.equal(codexAgentActiveAt('agent', new Map(), home, NOW), 2_000_000 * 1000);

  // …but only as a fallback: a live rollout, even an older one, is the answer.
  rollout(home, S2, 1_000_000);
  assert.equal(codexAgentActiveAt('agent', new Map(), home, NOW), 1_000_000 * 1000);
});

test('a rollout stamped in the future reads as now, never as a negative age', (t) => {
  const home = tempHome(t);
  rollout(home, S1, 9_000_000); // copied, restored, or written under a skewed clock
  assert.equal(codexAgentActiveAt('agent', new Map(), home, NOW), NOW);
});

// ─── ReadingCache: a history is walked at most once per ttl ──────────────────

test('a reading is reused within its ttl and taken again after it', () => {
  const cache = new ReadingCache(30_000);
  let walks = 0;
  const walk = () => ++walks;
  assert.equal(cache.read('k', 0, walk), 1);
  assert.equal(cache.read('k', 29_999, walk), 1);
  assert.equal(cache.read('k', 30_000, walk), 2);
  assert.equal(cache.read('other', 30_000, walk), 3);
});

test('a cached history still notices a resumed file being written, after the ttl', (t) => {
  // The live rollout of a resumed session sits under an old day; a cache that
  // only looked for NEW files would miss it being appended to.
  const home = tempHome(t);
  const file = rollout(home, S1, 2_000_000);
  const cache = new ReadingCache(30_000);
  assert.equal(codexAgentActiveAt('agent', new Map(), home, NOW, cache), 2_000_000 * 1000);
  fs.utimesSync(file, 3_000_000, 3_000_000);
  assert.equal(codexAgentActiveAt('agent', new Map(), home, NOW + 1_000, cache), 2_000_000 * 1000);
  assert.equal(codexAgentActiveAt('agent', new Map(), home, NOW + 30_000, cache), 3_000_000 * 1000);
});

// ─── The fleet snapshot itself ───────────────────────────────────────────────

/** Run the real writeFleetSnapshot from index.ts against stubbed surroundings.
 *  Every name it needs is passed in, so a new dependency fails loudly here. */
function runFleetSnapshot({ root, registry, usage, records }) {
  const source = fs.readFileSync(path.join(REPO, 'src/main/index.ts'), 'utf8');
  const start = source.indexOf('function writeFleetSnapshot(): void {');
  const end = source.indexOf('/** Arm the heartbeat', start);
  assert.ok(start >= 0 && end > start, 'writeFleetSnapshot located in index.ts');
  const body = source.slice(start, end).replace('writeFleetSnapshot(): void', 'writeFleetSnapshot()');
  let written = null;
  const hive = {
    enabled: () => true,
    root: () => root,
    registry: () => ({ agents: registry }),
    inboxBacklog: () => 0,
    writeFleetSnapshot: (s) => { written = s; }
  };
  const telemetry = { snapshot: () => ({ usage, spans: {} }) };
  const costTotals = { refresh: () => {}, usdFor: () => null };
  const breaker = { levelFor: () => 'ok' };
  // eslint-disable-next-line no-new-func
  new Function(
    'hive', 'telemetry', 'costTotals', 'breaker', 'join',
    'fleetLastActiveAt', 'codexAgentActiveAt', 'codexSessionOf', 'codexActivityCache',
    `${body}\nwriteFleetSnapshot();`
  )(
    hive, telemetry, costTotals, breaker, path.join,
    fleetLastActiveAt, codexAgentActiveAt, records, ReadingCache ? new ReadingCache(30_000) : undefined
  );
  assert.ok(written, 'writeFleetSnapshot wrote a snapshot');
  return Object.fromEntries(written.agents.map((a) => [a.id, a]));
}

test('the fleet snapshot dates a resumed worker from the home it actually runs in', (t) => {
  const root = tempHome(t);
  const ownerHome = path.join(root, 'agents/original/.codex');
  const nowS = Math.floor(Date.now() / 1000);
  rollout(ownerHome, S1, nowS);                               // the resumed worker's session, live now
  rollout(ownerHome, S2, nowS - 600, 'sessions', '2026/09/10'); // the owner's own, ten minutes ago

  const agents = runFleetSnapshot({
    root,
    registry: {
      original: { name: 'Original', provider: 'codex' },
      resumed: { name: 'Resumed', provider: 'codex' },
      claude: { name: 'Claude', provider: 'claude' }
    },
    usage: [{ agentId: 'claude', ts: Date.now() - 5_000, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, usd: 0 }],
    records: new Map([
      ['original', { home: ownerHome }],
      ['resumed', { home: ownerHome, session: S1 }]
    ])
  });

  assert.ok(agents.resumed.lastActiveSecAgo !== null && agents.resumed.lastActiveSecAgo <= 2,
    `resumed worker: ${agents.resumed.lastActiveSecAgo}`);
  assert.ok(Math.abs(agents.original.lastActiveSecAgo - 600) <= 2,
    `owner: ${agents.original.lastActiveSecAgo}`);
  assert.ok(Math.abs(agents.claude.lastActiveSecAgo - 5) <= 1,
    `claude: ${agents.claude.lastActiveSecAgo}`);
});

test('the spawn path records where a resumed Codex worker really runs', () => {
  // A live resume needs Electron and a real Codex session, so this half is
  // checked structurally. Comments are blanked, so a commented-out line
  // cannot pass.
  const sa = require('./source-assert.cjs');
  const src = sa.activeSource('src/main/index.ts');
  const redirect = sa.boundedSlice(src, 'if (ownerHome !== myHome) {', 'const args = opts.args ?? [];');
  assert.match(redirect, /CODEX_HOME: ownerHome/);
  assert.match(redirect, /codexResumedSession = sid;/);
  const record = sa.boundedSlice(src, 'ptyToAgent.set(opts.id, opts.hive.id);', 'workerWake.noteSpawn(opts.id);');
  assert.match(record, /const codexHome = opts\.env\?\.CODEX_HOME;/);
  assert.match(record,
    /codexSessionOf\.set\(opts\.hive\.id, codexResumedSession\s*\?\s*\{ home: codexHome, session: codexResumedSession \}\s*:\s*\{ home: codexHome \}\)/);
  const snapshot = sa.boundedSlice(src, 'function writeFleetSnapshot(): void {', 'hive.writeFleetSnapshot({ ts: now, agents });');
  assert.match(snapshot, /codexActivityCache/);
});
