'use strict';
// The weekly usage digest: a plain-markdown summary of one ISO week built from
// the hive log, the cost ledger and the owner-side usage files. No LLM, no
// network; ids, counts and durations only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const D = loadTs('src/main/usageDigest.ts');

const MON = Date.parse('2026-11-02T00:00:00Z'); // Monday of ISO week 2026-W45
const H = 3600_000; const MIN = 60_000;
const j = (rows) => rows.map((r) => JSON.stringify(r));

function week() {
  const log = j([
    { ts: MON + H, kind: 'turn', agentId: 'god', startTs: MON + H, durationMs: 10 * MIN, trigger: 'heartbeat' },
    { ts: MON + 2 * H, kind: 'turn', agentId: 'god', startTs: MON + 2 * H, durationMs: 20 * MIN, trigger: 'mail', conversation: 'CARD-1' },
    { ts: MON + 3 * H, kind: 'turn', agentId: 'jc', startTs: MON + 3 * H, durationMs: 30 * MIN, trigger: 'mail', conversation: 'CARD-1' },
    // Hours in a state come from consecutive rows' own timestamps; msInState is ignored.
    { ts: MON + 2 * H, kind: 'card-transition', cardId: 'CARD-1', from: 'todo', to: 'doing' },
    { ts: MON + 4 * H, kind: 'card-transition', cardId: 'CARD-1', from: 'doing', to: 'blocked', msInState: 999 },
    { ts: MON + 5 * H, kind: 'card-transition', cardId: 'CARD-1', from: 'blocked', to: 'done', msInState: 999 },
    // A restart breaks the chain: CARD-3's time before it is not counted.
    { ts: MON + 6 * H, kind: 'card-transition', cardId: 'CARD-3', from: 'todo', to: 'doing' },
    { ts: MON + 7 * H, kind: 'app-start' },
    { ts: MON + 9 * H, kind: 'card-transition', cardId: 'CARD-3', from: 'doing', to: 'done' },
    { ts: MON + 4 * H, kind: 'ask-filed', cardId: 'CARD-1', askKey: 'CARD-1@2026-11-02T04:00:00.000Z' },
    { ts: MON + 5 * H, kind: 'ask-answered', cardId: 'CARD-1', askKey: 'CARD-1@2026-11-02T04:00:00.000Z', msSinceAsked: H, answerLen: 4, answerShape: 'done-ack' },
    { ts: MON + 4 * H, kind: 'ask-filed', cardId: 'CARD-2', askKey: 'CARD-2@2026-11-02T04:00:00.000Z' },
    { ts: MON + 6 * H, kind: 'heavy-lock', action: 'acquire', agentId: 'jc', heavyKind: 'suite', waitMs: 4 * MIN },
    { ts: MON + 7 * H, kind: 'canary', feature: 'memory-search', ok: false, detail: 'refused-422' },
    { ts: MON + 8 * H, kind: 'canary', feature: 'memory-search', ok: true },
    { ts: MON + 8 * H, kind: 'canary', feature: 'hook-socket', ok: true },
    { ts: MON - H, kind: 'turn', agentId: 'god', startTs: MON - H, durationMs: MIN, trigger: 'heartbeat' } // previous week: ignored
  ]);
  const ledger = j([
    { agent_id: 'god', session_id: 's', ts: MON + H, usd: 1 },
    { agent_id: 'god', session_id: 's', ts: MON + H + 5 * MIN, usd: 1.5 },   // +0.5 in the heartbeat turn
    { agent_id: 'god', session_id: 's', ts: MON + 2 * H + 5 * MIN, usd: 3.5 }, // +2 in the mail turn
    { agent_id: 'jc', session_id: 't', ts: MON + 3 * H, usd: 0 },
    { agent_id: 'jc', session_id: 't', ts: MON + 3 * H + 10 * MIN, usd: 4 }    // +4 in jc's turn
  ]);
  const usage = j([
    { ts: MON + 4 * H, kind: 'ui-view', view: 'command-center:human' },
    { ts: MON + 4 * H + MIN, kind: 'ui-view-end', view: 'command-center:human', dwellMs: 3 * MIN },
    { ts: MON + 4 * H, kind: 'ui-view-end', view: 'settings', dwellMs: MIN },
    { ts: MON + 4 * H + 10 * MIN, kind: 'ask-shown', askKey: 'CARD-1@2026-11-02T04:00:00.000Z', ageMs: 10 * MIN },
    { ts: MON + 5 * H, kind: 'ask-submitted', askKey: 'CARD-1@2026-11-02T04:00:00.000Z', msSinceShown: 50 * MIN, answerLen: 4, answerShape: 'done-ack' }
  ]);
  return { log, ledger, usage, cards: new Set(['CARD-1', 'CARD-2']) };
}

test('isoWeek names the ISO week and its Monday', () => {
  assert.deepEqual(D.isoWeek(MON + 3 * 86400_000), { label: '2026-W45', start: MON, end: MON + 7 * 86400_000 });
  assert.equal(D.isoWeek(Date.parse('2026-01-01T12:00:00Z')).label, '2026-W01');
});

test('turns are counted by trigger with their dollars from the ledger', () => {
  const { log, ledger, usage, cards } = week();
  const s = D.summarize({ log, ledger, usage, cards, start: MON, end: MON + 7 * 86400_000 });
  assert.deepEqual(s.turnsByTrigger, { heartbeat: { turns: 1, usd: 0.5 }, mail: { turns: 2, usd: 6 } });
  assert.deepEqual(s.usdByConversation, { 'CARD-1': 6 });
});

test('asks: unseen and thinking times, plus filed-but-never-seen and seen-but-unanswered', () => {
  const { log, ledger, usage, cards } = week();
  const s = D.summarize({ log, ledger, usage, cards, start: MON, end: MON + 7 * 86400_000 });
  assert.equal(s.asks.filed, 2);
  assert.equal(s.asks.answered, 1);
  assert.equal(s.asks.unseenMedianMs, 10 * MIN);
  assert.equal(s.asks.thinkingMedianMs, 50 * MIN);
  assert.deepEqual(s.asks.neverSeen, ['CARD-2@2026-11-02T04:00:00.000Z']);
  assert.deepEqual(s.asks.shapes, { 'done-ack': 1 });
});

test('screens by dwell, card states, lock waits and canary failures', () => {
  const { log, ledger, usage, cards } = week();
  const s = D.summarize({ log, ledger, usage, cards, start: MON, end: MON + 7 * 86400_000 });
  assert.deepEqual(s.views, [{ view: 'command-center:human', opens: 1, dwellMs: 3 * MIN }, { view: 'settings', opens: 0, dwellMs: MIN }]);
  assert.deepEqual(s.stateHours, { doing: 2, blocked: 1 });
  assert.deepEqual(s.lockWaits, { suite: { n: 1, totalMs: 4 * MIN } });
  assert.deepEqual(s.canaryFailures, { 'memory-search': { failed: 1, runs: 2, details: ['refused-422'] } });
});

test('the markdown names the week and carries no text beyond ids and numbers', () => {
  const { log, ledger, usage, cards } = week();
  const md = D.renderDigest(D.summarize({ log, ledger, usage, cards, start: MON, end: MON + 7 * 86400_000 }), '2026-W45');
  assert.match(md, /^# Usage digest 2026-W45/m);
  assert.match(md, /\| heartbeat \| 1 \| \$0\.50 \|/);
  assert.match(md, /CARD-2@2026-11-02T04:00:00.000Z/);
  assert.match(md, /memory-search/);
});

test('the weekly file is written once for the last full week, private, and not rewritten', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-digest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { log, ledger, usage } = week();
  fs.writeFileSync(path.join(root, 'log.jsonl'), log.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'cost-ledger.jsonl'), ledger.join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({ tasks: [{ id: 'CARD-1' }, { id: 'CARD-2' }] }));
  fs.mkdirSync(path.join(root, 'usage'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'usage', '2026-11-02.jsonl'), usage.join('\n') + '\n');
  const now = MON + 7 * 86400_000 + 2 * H; // Monday of the next week
  assert.equal(D.writeWeeklyDigest(root, now), path.join(root, 'usage', 'digest-2026-W45.md'));
  const file = path.join(root, 'usage', 'digest-2026-W45.md');
  assert.match(fs.readFileSync(file, 'utf8'), /Usage digest 2026-W45/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(D.writeWeeklyDigest(root, now + H), null, 'an existing digest is left alone');
});

test('prose written into any string field of the logs never reaches the digest', () => {
  const P = (n) => `the owner's secret plan number ${n}, please keep it`;
  const log = j([
    { ts: MON + H, kind: 'turn', agentId: P(1), startTs: MON + H, durationMs: MIN, trigger: P(2), conversation: P(3) },
    { ts: MON + H, kind: 'turn', agentId: 'god', startTs: MON + H, durationMs: MIN, trigger: P(4), conversation: P(5) },
    { ts: MON + 2 * H, kind: 'card-transition', cardId: 'C-1', from: 'todo', to: P(6) },
    { ts: MON + 3 * H, kind: 'card-transition', cardId: 'C-1', from: P(7), to: 'done' },
    { ts: MON + 4 * H, kind: 'ask-filed', cardId: 'C-1', askKey: P(8) },
    { ts: MON + 4 * H, kind: 'ask-answered', cardId: 'C-1', askKey: P(9), answerShape: P(10) },
    { ts: MON + 5 * H, kind: 'heavy-lock', action: 'acquire', heavyKind: P(11), waitMs: MIN },
    { ts: MON + 6 * H, kind: 'canary', feature: P(12), ok: false, detail: P(13) },
    { ts: MON + 6 * H, kind: 'canary', feature: 'memory-search', ok: false, detail: P(14) }
  ]);
  const usage = j([
    { ts: MON + 4 * H, kind: 'ui-view', view: P(15) },
    { ts: MON + 4 * H, kind: 'ui-view-end', view: P(16), dwellMs: MIN },
    { ts: MON + 4 * H, kind: 'ask-shown', askKey: P(17), ageMs: MIN }
  ]);
  const md = D.renderDigest(D.summarize({ log, ledger: [], usage, start: MON, end: MON + 7 * 86400_000 }), '2026-W45');
  assert.doesNotMatch(md, /secret plan/);
});

test('id-shaped prose is printed only when the app holds it; other conversations print as refs', () => {
  const P = 'Owner-said-the-unreleased-project-is-ORCHID.Owner-said-the-unreleased-project-is';
  const log = j([
    { ts: MON + H, kind: 'turn', agentId: 'god', startTs: MON + H, durationMs: MIN, trigger: 'mail', conversation: P },
    { ts: MON + H, kind: 'turn', agentId: 'god', startTs: MON + H, durationMs: MIN, trigger: 'mail', conversationRef: 'a1b2c3d4e5f6' },
    { ts: MON + H, kind: 'turn', agentId: 'god', startTs: MON + H, durationMs: MIN, trigger: 'mail', conversationRef: P },
    { ts: MON + 4 * H, kind: 'ask-filed', cardId: P, askKey: `${P}@2026-11-02T04:00:00.000Z` },
    { ts: MON + 5 * H, kind: 'heavy-lock', action: 'acquire', heavyKind: P, waitMs: MIN },
    { ts: MON + 6 * H, kind: 'canary', feature: P, ok: false, detail: 'refused-422' },
    { ts: MON + 6 * H, kind: 'canary', feature: 'memory-search', ok: false, detail: P }
  ]);
  const ledger = j([{ agent_id: 'god', session_id: 's', ts: MON, usd: 0 }, { agent_id: 'god', session_id: 's', ts: MON + H + 30_000, usd: 1 }]);
  const s = D.summarize({ log, ledger, usage: [], cards: new Set(['CARD-1']), start: MON, end: MON + 7 * 86400_000 });
  const md = D.renderDigest(s, '2026-W45');
  assert.doesNotMatch(md, /ORCHID/);
  assert.match(md, /ref:a1b2c3d4e5f6/);
  assert.deepEqual(s.canaryFailures, { 'memory-search': { failed: 1, runs: 1, details: ['other'] } });
});
