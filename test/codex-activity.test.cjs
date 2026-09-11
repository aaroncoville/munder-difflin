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
 * the sessions that are the worker's own. A resume can share one home between
 * workers, and a running worker can start new sessions in it.
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
  CodexHomes,
  ReadingCache,
  enrichStallLines,
  appendSession,
  SESSION_HISTORY_CAP,
  newestOwnedRolloutAt
} = loadTs('src/main/codexActivity.ts');
const { lastCatchupAt } = loadTs('src/main/codexCatchupLog.ts');

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

/** Homes recorded the way the spawn path records them: [agentId, home, resumedSession?]. */
function spawned(...entries) {
  const homes = new CodexHomes();
  for (const [agentId, home, resumed] of entries) homes.recordSpawn(agentId, home, resumed);
  return homes;
}

const S1 = '01a08414-c11e-7900-a709-b6cf3703a742';
const S2 = '01a08415-902d-78a1-90f3-0c67c41be971';
const S3 = '01a08b71-da88-7e03-8e91-2d7813925ebb';
const S4 = '01a08dba-f793-73b1-8f74-a580786b04c0';
const S5 = '01a09000-aaaa-7000-b000-000000000005';
const S6 = '01a09000-bbbb-7000-b000-000000000006';

const NOW = 5_000_000 * 1000;
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

// ─── CodexHomes: where a worker runs, and which sessions are whose ───────────

test('a worker is read from the home it was spawned into, else the one named after it', () => {
  const homes = spawned(['resumed', '/h/owner', S1], ['fresh', '/h/fresh']);
  assert.equal(homes.homeOf('resumed', '/h/resumed'), '/h/owner');
  assert.equal(homes.homeOf('fresh', '/h/fresh-nominal'), '/h/fresh');
  assert.equal(homes.homeOf('unknown', '/h/unknown'), '/h/unknown');
  assert.equal(homes.homeOf('unknown', null), null);
});

test('the spawn record forgets a worker that no longer runs Codex', () => {
  const homes = spawned(['x', '/h/x']);
  homes.recordSpawn('x', undefined);
  assert.equal(homes.homeOf('x', '/h/nominal'), '/h/nominal');
});

test('a resume hands the resumed session to the worker that resumed it', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 4_000_000);
  rollout(ownerHome, S2, 3_000_000, 'sessions', '2026/09/10');
  const homes = new CodexHomes();
  homes.noteSession('original', S1); // the original agent ran it first
  homes.recordSpawn('original', ownerHome);
  homes.recordSpawn('resumed', ownerHome, S1);
  homes.noteSession('original', S2); // the owner's own, reported by its hooks

  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW), 4_000_000 * 1000);
  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), 3_000_000 * 1000);
});

test('a later report cannot take an owned session away from its worker', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 4_000_000);
  rollout(ownerHome, S2, 3_000_000, 'sessions', '2026/09/10');
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  homes.noteSession('original', S1); // e.g. a stale registry value
  homes.noteSession('original', S2); // the owner's own, reported by its hooks

  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW), 4_000_000 * 1000);
  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), 3_000_000 * 1000);
});

// ─── codexAgentActiveAt: the home a worker actually runs in ──────────────────

test('a worker resumed into another agent\'s home reads that home, not its own', (t) => {
  // Resuming a session that another agent's home owns points the worker's
  // CODEX_HOME at that home, because the session's index lives there too.
  const root = tempHome(t);
  const ownerHome = path.join(root, 'agents/original/.codex');
  const ownHome = path.join(root, 'agents/resumed/.codex');
  rollout(ownerHome, S1, 4_000_000);

  assert.equal(codexAgentActiveAt('resumed', spawned(['resumed', ownerHome, S1]), ownHome, NOW), 4_000_000 * 1000);
});

test('a worker resumed into a shared home reads only its own sessions there', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 3_000_000);                           // the session it resumed
  rollout(ownerHome, S2, 4_000_000, 'sessions', '2026/09/10'); // the owner's own, newer

  assert.equal(codexAgentActiveAt('resumed', spawned(['resumed', ownerHome, S1]), null, NOW), 3_000_000 * 1000);
});

test('the owner of a shared home does not claim sessions others resumed into it', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S2, 3_000_000);                           // the owner's own
  rollout(ownerHome, S1, 4_000_000, 'sessions', '2026/09/10'); // resumed by someone else, newer
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  homes.noteSession('original', S2); // the owner's hooks reported its own session

  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), 3_000_000 * 1000);
});

test('a new session a redirected worker reports is its own, and never the owner\'s', (t) => {
  // The redirected worker starts a new session (`/new`) in the running, shared
  // home. Its hooks report the new session id; from then on it is the worker's.
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 3_000_000);                           // resumed earlier, now quiet
  rollout(ownerHome, S2, 2_000_000, 'sessions', '2026/09/09'); // the owner's own
  rollout(ownerHome, S3, 4_000_000, 'sessions', '2026/09/10'); // the worker's new session
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  homes.noteSession('resumed', S3);
  homes.noteSession('original', S2);

  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW), 4_000_000 * 1000);
  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), 2_000_000 * 1000);
});

test('in a shared home, a session nobody is known to own is nobody\'s activity', (t) => {
  // A session no hook named — or one the bounded history has since forgotten —
  // cannot be told from the owner's own, so it is never presented as the owner's.
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 3_000_000);                           // resumed by the worker
  rollout(ownerHome, S2, 2_000_000, 'sessions', '2026/09/09'); // the owner's own
  rollout(ownerHome, S3, 4_000_000, 'sessions', '2026/09/10'); // nobody reported it
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);

  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW), 3_000_000 * 1000);
  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), null);
  homes.noteSession('original', S2); // once its hooks name its own session, that counts — S3 still does not
  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), 2_000_000 * 1000);
});

test('in a home no other worker has written to, an unreported session is still its worker\'s', (t) => {
  const home = tempHome(t);
  rollout(home, S3, 2_000_000);
  const homes = spawned(['solo', home], ['elsewhere', '/h/other', S1]); // S1 is owned, but not in this home
  assert.equal(codexAgentActiveAt('solo', homes, home, NOW), 2_000_000 * 1000);
});

test('a worker with no record reads the home named after it', (t) => {
  const home = tempHome(t);
  rollout(home, S3, 2_000_000);
  assert.equal(codexAgentActiveAt('fresh', new CodexHomes(), home, NOW), 2_000_000 * 1000);
  assert.equal(codexAgentActiveAt('fresh', new CodexHomes(), null, NOW), null);
});

test('with no live rollout, archived history is the last activity', (t) => {
  const home = tempHome(t);
  rollout(home, S1, 2_000_000, 'archived_sessions');
  assert.equal(codexAgentActiveAt('agent', new CodexHomes(), home, NOW), 2_000_000 * 1000);

  // …but only as a fallback: a live rollout, even an older one, is the answer.
  rollout(home, S2, 1_000_000);
  assert.equal(codexAgentActiveAt('agent', new CodexHomes(), home, NOW), 1_000_000 * 1000);
});

test('a rollout stamped in the future reads as now, never as a negative age', (t) => {
  const home = tempHome(t);
  rollout(home, S1, 9_000_000); // copied, restored, or written under a skewed clock
  assert.equal(codexAgentActiveAt('agent', new CodexHomes(), home, NOW), NOW);
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
  const homes = new CodexHomes();
  assert.equal(codexAgentActiveAt('agent', homes, home, NOW, cache), 2_000_000 * 1000);
  fs.utimesSync(file, 3_000_000, 3_000_000);
  assert.equal(codexAgentActiveAt('agent', homes, home, NOW + 1_000, cache), 2_000_000 * 1000);
  assert.equal(codexAgentActiveAt('agent', homes, home, NOW + 30_000, cache), 3_000_000 * 1000);
});

test('a cached reading is not reused once the worker\'s sessions change', (t) => {
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 3_000_000);
  rollout(ownerHome, S3, 4_000_000, 'sessions', '2026/09/10');
  const cache = new ReadingCache(30_000);
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW, cache), 3_000_000 * 1000);
  homes.noteSession('resumed', S3);
  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW + 1_000, cache), 4_000_000 * 1000);
});

// ─── The fleet snapshot itself ───────────────────────────────────────────────

/** Run the real writeFleetSnapshot from index.ts against stubbed surroundings.
 *  Every name it needs is passed in, so a new dependency fails loudly here. */
function runFleetSnapshot({ root, registry, usage, homes }) {
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
    'fleetLastActiveAt', 'codexAgentActiveAt', 'codexHomes', 'codexActivityCache',
    `${body}\nwriteFleetSnapshot();`
  )(
    hive, telemetry, costTotals, breaker, path.join,
    fleetLastActiveAt, codexAgentActiveAt, homes, new ReadingCache(30_000)
  );
  assert.ok(written, 'writeFleetSnapshot wrote a snapshot');
  return Object.fromEntries(written.agents.map((a) => [a.id, a]));
}

function sharedHomeFixture(t) {
  const root = tempHome(t);
  const ownerHome = path.join(root, 'agents/original/.codex');
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  return { root, ownerHome, homes };
}

test('the fleet snapshot dates a resumed worker from the home it actually runs in', (t) => {
  const { root, ownerHome, homes } = sharedHomeFixture(t);
  const nowS = Math.floor(Date.now() / 1000);
  rollout(ownerHome, S1, nowS);                                  // the resumed worker's session, live now
  rollout(ownerHome, S2, nowS - 1_200, 'sessions', '2026/09/10'); // the owner's own, twenty minutes ago

  const agents = runFleetSnapshot({
    root,
    homes,
    registry: {
      original: { name: 'Original', provider: 'codex', sessionId: S2 },
      resumed: { name: 'Resumed', provider: 'codex', sessionId: S1 },
      claude: { name: 'Claude', provider: 'claude' }
    },
    usage: [{ agentId: 'claude', ts: Date.now() - 5_000, input: 1, output: 1, cacheRead: 0, cacheCreation: 0, usd: 0 }]
  });

  assert.ok(agents.resumed.lastActiveSecAgo !== null && agents.resumed.lastActiveSecAgo <= 2,
    `resumed worker: ${agents.resumed.lastActiveSecAgo}`);
  assert.ok(Math.abs(agents.original.lastActiveSecAgo - 1_200) <= 2, `owner: ${agents.original.lastActiveSecAgo}`);
  assert.ok(Math.abs(agents.claude.lastActiveSecAgo - 5) <= 1, `claude: ${agents.claude.lastActiveSecAgo}`);
});

test('the fleet snapshot follows a redirected worker into a new session, and keeps it from the owner', (t) => {
  // The redirected worker, still running in the shared home, starts S3. Its
  // hooks record S3 as its session in the registry; S1 is now ten minutes old.
  const { root, ownerHome, homes } = sharedHomeFixture(t);
  const nowS = Math.floor(Date.now() / 1000);
  rollout(ownerHome, S1, nowS - 600);
  rollout(ownerHome, S2, nowS - 1_200, 'sessions', '2026/09/09');
  rollout(ownerHome, S3, nowS, 'sessions', '2026/09/10');

  const agents = runFleetSnapshot({
    root,
    homes,
    registry: {
      // The owner is listed first: every session must be known before any
      // worker's activity is read, or the owner would briefly claim S3.
      original: { name: 'Original', provider: 'codex', sessionId: S2 },
      resumed: { name: 'Resumed', provider: 'codex', sessionId: S3 }
    },
    usage: []
  });

  assert.ok(agents.resumed.lastActiveSecAgo !== null && agents.resumed.lastActiveSecAgo <= 2,
    `resumed worker: ${agents.resumed.lastActiveSecAgo}`);
  assert.ok(Math.abs(agents.original.lastActiveSecAgo - 1_200) <= 2, `owner: ${agents.original.lastActiveSecAgo}`);
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
  assert.match(record, /codexHomes\.recordSpawn\(opts\.hive\.id, opts\.env\?\.CODEX_HOME, codexResumedSession\)/);
  const snapshot = sa.boundedSlice(src, 'function writeFleetSnapshot(): void {', 'hive.writeFleetSnapshot({ ts: now, agents });');
  assert.match(snapshot, /a\.sessionIds \?\? \(a\.sessionId/);
  assert.match(snapshot, /codexHomes\.noteSession\(id, sid\)/);
  assert.match(snapshot, /codexActivityCache/);
});

// ─── One resolver for every reader ───────────────────────────────────────────

test('one resolver: a resumed worker is read from its effective home by every reader', (t) => {
  const root = tempHome(t);
  const ownerHome = path.join(root, 'agents/original/.codex');
  const nominal = path.join(root, 'agents/resumed/.codex');
  rollout(ownerHome, S1, 4_000_000);
  const homes = spawned(['resumed', ownerHome, S1]); // what the spawn path records after the resume

  // The resolver itself, and the fleet snapshot's reader.
  assert.equal(homes.homeOf('resumed', nominal), ownerHome);
  assert.equal(codexAgentActiveAt('resumed', homes, nominal, NOW), 4_000_000 * 1000);
  // The stall line's two readers: session age, and Codex's catch-up summary.
  const opened = [];
  const open = (file) => {
    opened.push(file);
    return { prepare: () => ({ get: () => ({ ts: 4_100_000 }) }), close() {} };
  };
  const [line] = enrichStallLines(
    [{ kind: 'worker-wake-skip', agentId: 'resumed', state: 'not-quiet', quietMs: 3_000 }],
    (id) => homes.homeOf(id, nominal),
    {
      rolloutAt: (id) => codexAgentActiveAt(id, homes, nominal, NOW),
      catchupAt: (home) => lastCatchupAt(home, NOW, open)
    },
    NOW,
    15_000,
    { elapsed: () => 0, limitMs: 20 }
  );
  assert.deepEqual(opened, [path.join(ownerHome, 'logs_2.sqlite')]);
  assert.deepEqual(line.codex, {
    rolloutAgeMs: NOW - 4_000_000 * 1000,
    catchupAgoMs: NOW - 4_100_000 * 1000,
    catchupInLastBeat: false
  });
});

// ─── Stall enrichment: bounded, and only for stall lines ─────────────────────

const stallLine = (agentId) => ({ kind: 'worker-wake-skip', agentId, state: 'not-quiet', quietMs: 3_000 });

test('only stall lines are enriched, and only for workers that run Codex', () => {
  const read = { rolloutAt: () => 1_000, catchupAt: () => 2_000 };
  const lines = enrichStallLines(
    [
      stallLine('codex-worker'),
      { kind: 'worker-wake-skip', agentId: 'codex-worker', state: 'resolved', via: 'nudged', stalledMs: 1 },
      stallLine('claude-worker')
    ],
    (id) => (id === 'codex-worker' ? '/h/codex' : null),
    read,
    10_000,
    15_000,
    { elapsed: () => 0, limitMs: 20 }
  );
  assert.ok(lines[0].codex);
  assert.equal(lines[1].codex, undefined);
  assert.equal(lines[2].codex, undefined);
});

test('once the budget is spent, remaining lines are flagged instead of read', () => {
  let spent = 0;
  const calls = [];
  const read = {
    rolloutAt: (id) => { calls.push(id); spent += 30; return 1_000; },
    catchupAt: () => 2_000
  };
  const lines = enrichStallLines(
    [stallLine('a'), stallLine('b'), stallLine('c')],
    () => '/h',
    read,
    10_000,
    15_000,
    { elapsed: () => spent, limitMs: 20 }
  );
  assert.deepEqual(calls, ['a']);
  assert.deepEqual(lines[1].codex, { skipped: 'budget' });
  assert.deepEqual(lines[2].codex, { skipped: 'budget' });
});

test('a reader that throws leaves the line written, with the reading unknown', () => {
  const [line] = enrichStallLines(
    [stallLine('a')],
    () => '/h',
    { rolloutAt: () => { throw new Error('EACCES'); }, catchupAt: () => { throw new Error('locked'); } },
    10_000,
    15_000,
    { elapsed: () => 0, limitMs: 20 }
  );
  assert.deepEqual(line.codex, { rolloutAgeMs: null, catchupAgoMs: null, catchupInLastBeat: false });
});

// ─── Both directions in a shared home, and the real refresh cadence ──────────

test('in a shared home, each side\'s new session is its own', (t) => {
  // After the redirect either side can start a new session in the shared home:
  // the redirected worker starts S3, the owner starts S4, and each one's hooks
  // report its own. The owner also has S2, which nobody reported and which is
  // newer than S3: only the redirected worker's own-sessions filter keeps it
  // out of that worker's reading.
  const ownerHome = tempHome(t);
  rollout(ownerHome, S1, 1_000_000);                           // resumed long ago
  rollout(ownerHome, S3, 2_000_000, 'sessions', '2026/09/10'); // the redirected worker's new session
  rollout(ownerHome, S2, 2_500_000, 'sessions', '2026/09/10'); // the owner's, never reported
  rollout(ownerHome, S4, 3_000_000, 'sessions', '2026/09/11'); // the owner's new session, newest
  const homes = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  homes.noteSession('resumed', S3);
  homes.noteSession('original', S4);

  assert.equal(codexAgentActiveAt('resumed', homes, null, NOW), 2_000_000 * 1000);
  assert.equal(codexAgentActiveAt('original', homes, ownerHome, NOW), 3_000_000 * 1000);
});

test('the fleet snapshot credits each side of a shared home with its own new session', (t) => {
  const { root, ownerHome, homes } = sharedHomeFixture(t);
  const nowS = Math.floor(Date.now() / 1000);
  rollout(ownerHome, S1, nowS - 900);                             // resumed, now quiet
  rollout(ownerHome, S3, nowS - 300, 'sessions', '2026/09/10');   // the redirected worker's new session
  rollout(ownerHome, S2, nowS - 200, 'sessions', '2026/09/09');   // the owner's, never reported, newer than S3
  rollout(ownerHome, S4, nowS - 60, 'sessions', '2026/09/11');    // the owner's new session

  const agents = runFleetSnapshot({
    root,
    homes,
    registry: {
      original: { name: 'Original', provider: 'codex', sessionId: S4 },
      resumed: { name: 'Resumed', provider: 'codex', sessionId: S3 }
    },
    usage: []
  });

  assert.ok(Math.abs(agents.resumed.lastActiveSecAgo - 300) <= 2, `resumed worker: ${agents.resumed.lastActiveSecAgo}`);
  assert.ok(Math.abs(agents.original.lastActiveSecAgo - 60) <= 2, `owner: ${agents.original.lastActiveSecAgo}`);
});

test('on the 8 s snapshot cadence, a 30 s reading is refreshed at 32 s', () => {
  // The snapshot runs every 8 s, so a 30 s ttl is next honoured by the tick at
  // 32 s: that, not 30 s, is how late a resumed session's growth can show.
  const cache = new ReadingCache(30_000);
  const walkedAt = [];
  for (let t = 0; t <= 64_000; t += 8_000) cache.read('home', t, () => { walkedAt.push(t); return t; });
  assert.deepEqual(walkedAt, [0, 32_000, 64_000]);
});


// ─── delta 2: every reported session is captured, not just the latest ─────────

test('appendSession keeps every reported session, most-recent last, deduped and capped', () => {
  assert.deepEqual(appendSession(undefined, 'a'), ['a']);
  assert.deepEqual(appendSession(['a'], 'b'), ['a', 'b']);
  // a repeat is not lost or duplicated — it moves to most-recent last
  assert.deepEqual(appendSession(['a', 'b'], 'a'), ['b', 'a']);
  // bounded: only the last `cap` are kept, newest included
  const many = appendSession(Array.from({ length: SESSION_HISTORY_CAP }, (_, i) => `s${i}`), 'new', SESSION_HISTORY_CAP);
  assert.equal(many.length, SESSION_HISTORY_CAP);
  assert.equal(many[many.length - 1], 'new');
  assert.equal(many[0], 's1'); // s0 fell off the front
});

test('the snapshot notes a session that changed twice between two ticks, so the owner is not credited it', (t) => {
  // A redirected worker resumed S1 in the owner's home, then ran /new twice
  // (S5, then S6) before a single fleet snapshot. Its hooks recorded both, so
  // the registry carries the whole list, not just the latest id. S5 is newer
  // than the owner's own S2, so sampling only the latest (S6) would leave S5
  // unowned and credit the owner with it — the delta-2 bug.
  const { root, ownerHome, homes } = sharedHomeFixture(t);
  const nowS = Math.floor(Date.now() / 1000);
  rollout(ownerHome, S1, nowS - 1_800, 'sessions', '2026/09/08'); // worker's resumed session, oldest
  rollout(ownerHome, S2, nowS - 1_200, 'sessions', '2026/09/09'); // the OWNER's own session
  rollout(ownerHome, S5, nowS - 300,  'sessions', '2026/09/10');  // worker's first /new — newer than the owner's
  rollout(ownerHome, S6, nowS - 1,    'sessions', '2026/09/10');  // worker's second /new — live

  const agents = runFleetSnapshot({
    root,
    homes,
    registry: {
      original: { name: 'Original', provider: 'codex', sessionId: S2 },
      resumed: { name: 'Resumed', provider: 'codex', sessionId: S6, sessionIds: [S5, S6] }
    },
    usage: []
  });

  // The owner keeps only its own ~1200 s reading — NOT the missed S5 at ~300 s.
  assert.ok(Math.abs(agents.original.lastActiveSecAgo - 1_200) <= 2,
    `owner falsely credited a missed session: ${agents.original.lastActiveSecAgo}`);
  // The redirected worker owns S1/S5/S6, so it reads its live S6 (~1 s).
  assert.ok(agents.resumed.lastActiveSecAgo !== null && agents.resumed.lastActiveSecAgo <= 2,
    `resumed worker: ${agents.resumed.lastActiveSecAgo}`);
});

test('the session record captures the transition at the hook boundary, on the reporting agent', () => {
  // The capture half runs inside Hive.recordSession, which needs Electron/native
  // deps to load, so it is pinned structurally (comments blanked): each reported
  // session is appended to THAT agent's own list, not merely overwritten.
  const sa = require('./source-assert.cjs');
  const src = sa.activeSource('src/main/hive.ts');
  const record = sa.boundedSlice(src, 'recordSession(agentId: string, sessionId: string): void {', 'lastSession(agentId: string)');
  assert.match(record, /agent\.sessionId = sessionId;/);
  assert.match(record, /agent\.sessionIds = appendSession\(agent\.sessionIds, sessionId\)/);
  assert.match(record, /if \(agent\.provider === 'codex'\) agent\.sessionIds = appendSession/);
});


test('a slow reader is not followed by another: the budget is enforced between readers, not just before the line', () => {
  // Tryphon delta 2: a first reader that overruns the budget must not let the
  // catch-up reader start on top of it. Simulate the overrun by advancing the
  // budget clock inside the first reader.
  let catchupCalls = 0;
  let elapsed = 0;
  const [line] = enrichStallLines(
    [{ agentId: 'slow', quietMs: 1_000 }],
    () => '/home/slow',
    {
      rolloutAt: () => { elapsed = 220; return 5; }, // blows the 20 ms budget mid-read
      catchupAt: () => { catchupCalls += 1; return 7; }
    },
    NOW,
    15_000,
    { elapsed: () => elapsed, limitMs: 20 }
  );
  assert.equal(catchupCalls, 0, 'the catch-up reader must be skipped once the first reader spent the budget');
  assert.deepEqual(line.codex, { skipped: 'budget' });
});

test('after a restart, a long-lived worker\'s forgotten sessions are not credited to the shared home\'s owner', (t) => {
  // Jannings delta 3: a redirected worker runs more sessions than the bounded
  // history keeps. Before a restart the in-memory owners still know them all;
  // after it, only the retained ids come back, and the oldest become unknown.
  const root = tempHome(t);
  const ownerHome = path.join(root, 'agents/original/.codex');
  const nowS = Math.floor(Date.now() / 1000);
  rollout(ownerHome, S2, nowS - 3_600, 'sessions', '2026/09/01'); // the owner's own, an hour ago
  rollout(ownerHome, S1, nowS - 3_500, 'sessions', '2026/09/01'); // the session the worker resumed
  const later = Array.from({ length: SESSION_HISTORY_CAP + 5 }, (_, i) =>
    `01a0a000-0000-7000-b000-${String(i).padStart(12, '0')}`);
  // every later session is newer than the owner's own, the last one ten seconds ago
  later.forEach((sid, i) => rollout(ownerHome, sid, nowS - (later.length - i) * 10, 'sessions', '2026/09/10'));
  let ids;
  for (const sid of [S1, ...later]) ids = appendSession(ids, sid);
  assert.equal(ids.length, SESSION_HISTORY_CAP);
  assert.ok(!ids.includes(S1) && !ids.includes(later[0]), 'the fixture really evicts the oldest sessions');

  const registry = {
    original: { name: 'Original', provider: 'codex', sessionId: S2 },
    resumed: { name: 'Resumed', provider: 'codex', sessionId: later.at(-1), sessionIds: ids }
  };
  // Before the restart: lifetime ownership is still in memory.
  const live = spawned(['original', ownerHome], ['resumed', ownerHome, S1]);
  for (const sid of [S1, ...later]) live.noteSession('resumed', sid);
  const before = runFleetSnapshot({ root, homes: live, registry, usage: [] });
  assert.ok(Math.abs(before.original.lastActiveSecAgo - 3_600) <= 2, `owner before restart: ${before.original.lastActiveSecAgo}`);

  // After the restart: fresh owners, the registry as persisted, and restore
  // resuming the worker's latest session in the owner's home.
  const restarted = spawned(['original', ownerHome], ['resumed', ownerHome, later.at(-1)]);
  const after = runFleetSnapshot({ root, homes: restarted, registry: JSON.parse(JSON.stringify(registry)), usage: [] });
  assert.ok(Math.abs(after.original.lastActiveSecAgo - 3_600) <= 2,
    `owner falsely credited a forgotten session after restart: ${after.original.lastActiveSecAgo}`);
  assert.ok(Math.abs(after.resumed.lastActiveSecAgo - 10) <= 2, `resumed worker after restart: ${after.resumed.lastActiveSecAgo}`);
});

test('a reader told which sessions are others\' never counts their rollouts', (t) => {
  // The exported contract on its own: excluded sessions never count, whether or
  // not the caller also says which are its own.
  const home = tempHome(t);
  rollout(home, S1, 4_000_000);                           // another worker's, newer
  rollout(home, S3, 2_000_000, 'sessions', '2026/09/10'); // nobody's known
  assert.equal(newestOwnedRolloutAt(home, { exclude: new Set([S1]) }), 2_000_000 * 1000);
  assert.equal(newestOwnedRolloutAt(home, { exclude: new Set([S1]), mine: new Set() }), null);
});

