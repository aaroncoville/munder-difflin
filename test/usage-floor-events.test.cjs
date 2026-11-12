'use strict';
// Floor-side usage events: turn spans, card and ask transitions from tasks.json,
// heavy-lock waits, and who sent an oversized hook message. Ids, counts and
// durations only: no message, question or answer text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const U = loadTs('src/main/usageEvents.ts');
const { HeavyJobLock } = loadTs('src/main/heavyJob.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const crypto = require('node:crypto');

// The harness's own sets: agents on the roster, cards in tasks.json, and a keyed
// digest for anything else that has to be groupable.
const AGENTS = ['jc', 'god', 'worker-ysabet'];
const CARDS = ['CARD-1', 'A', 'B'];
const ref = (v) => crypto.createHmac('sha256', 'test-secret').update(v).digest('hex').slice(0, 12);
const IDS = { isAgent: (id) => AGENTS.includes(id), isCard: (id) => CARDS.includes(id), ref };
const isAgent = IDS.isAgent;
const MINTED_ID = '2026-11-12T15-38-04-411Z-e9dd00';

// ── turns ────────────────────────────────────────────────────────────────────

test('a turn runs from prompt to stop and names the delivery that started it', () => {
  const t = new U.TurnTracker(IDS);
  t.noteDelivery('jc', { from: 'god', id: MINTED_ID, conversation: 'CARD-1' }, 1000);
  t.prompt('jc', 1500);
  assert.deepEqual(t.stop('jc', 9500), {
    kind: 'turn', agentId: 'jc', startTs: 1500, durationMs: 8000, trigger: 'mail', from: 'god', triggerId: MINTED_ID, conversation: 'CARD-1'
  });
});

test('ids the router did not mint and conversations that are not cards are logged only as keyed digests', () => {
  const t = new U.TurnTracker(IDS);
  t.noteDelivery('jc', { from: 'god', id: 'god-chose-this-id', conversation: 'MD-launch-plan' }, 1000);
  t.prompt('jc', 1500);
  const ev = t.stop('jc', 9500);
  assert.equal(ev.triggerId, undefined);
  assert.equal(ev.triggerRef, ref('god-chose-this-id'));
  assert.equal(ev.conversation, undefined);
  assert.equal(ev.conversationRef, ref('MD-launch-plan'));
  t.noteDelivery('jc', { from: 'god', id: MINTED_ID, conversation: 'conv-a1b2c3' }, 10_000);
  t.prompt('jc', 10_500);
  assert.equal(t.stop('jc', 11_000).conversation, 'conv-a1b2c3', 'a router-minted conversation is kept');
});

test('agent ids are kept only when the roster or the fixed system senders hold them', () => {
  const t = new U.TurnTracker(IDS);
  t.noteDelivery('stranger-agent', { from: 'someone-else', id: MINTED_ID }, 1000);
  t.prompt('stranger-agent', 1500);
  const ev = t.stop('stranger-agent', 2000);
  assert.equal(ev.agentId, undefined);
  assert.equal(ev.from, undefined);
  assert.equal(ev.trigger, 'mail');
  t.noteDelivery('jc', { from: 'pipeline', id: MINTED_ID }, 3000);
  t.prompt('jc', 3500);
  assert.equal(t.stop('jc', 4000).from, 'pipeline');
});

test('a sender named after an object property is mail, not an inherited value', () => {
  const t = new U.TurnTracker(IDS);
  for (const from of ['__proto__', 'constructor', 'toString']) {
    t.noteDelivery('jc', { from, id: MINTED_ID }, 0);
    t.prompt('jc', 10);
    assert.equal(t.stop('jc', 20).trigger, 'mail', from);
  }
});

test('heartbeat, scheduler and breaker deliveries are their own triggers', () => {
  const t = new U.TurnTracker(IDS);
  for (const [from, trigger] of [['heartbeat', 'heartbeat'], ['scheduler', 'scheduler'], ['breaker', 'breaker'], ['system', 'system']]) {
    t.noteDelivery('god', { from, id: `${from}-1` }, 0);
    t.prompt('god', 10);
    assert.equal(t.stop('god', 20).trigger, trigger, from);
  }
});

test('a prompt with no recent delivery is a direct prompt, and a delivery is used by one turn only', () => {
  const t = new U.TurnTracker(IDS);
  t.noteDelivery('jc', { from: 'god', id: 'g' }, 0);
  t.prompt('jc', 10); t.stop('jc', 20);
  t.prompt('jc', 30);
  assert.equal(t.stop('jc', 40).trigger, 'direct');
  t.noteDelivery('jc', { from: 'god', id: 'old' }, 0);
  t.prompt('jc', U.TRIGGER_WINDOW_MS + 1);
  assert.equal(t.stop('jc', U.TRIGGER_WINDOW_MS + 2).trigger, 'direct', 'a stale delivery does not count');
});

test('a conversation that is not id-shaped is left out of the turn row', () => {
  const t = new U.TurnTracker(IDS);
  t.noteDelivery('jc', { from: 'god', id: 'god-1', conversation: 'please fix the login bug for Pam' }, 1000);
  t.prompt('jc', 1500);
  const ev = t.stop('jc', 9500);
  assert.equal(ev.conversation, undefined);
  assert.doesNotMatch(JSON.stringify(ev), /login bug/);
});

test('a stop with no prompt yields nothing', () => {
  assert.equal(new U.TurnTracker(IDS).stop('jc', 5), null);
});

// ── tasks.json diff ──────────────────────────────────────────────────────────

const card = (id, status, extra = {}) => ({ id, status, updatedAt: '2026-11-12T10:00:00.000Z', ...extra });
const NOW = Date.parse('2026-11-12T12:00:00.000Z');

test('sampled task rows never claim a time in state', () => {
  // doing -> done between reads may hide doing -> blocked -> done, so no dwell is trustworthy.
  const rows = [
    ...U.diffTasks([card('A', 'todo')], [card('A', 'doing')], NOW),
    ...U.diffTasks([card('A', 'doing')], [card('A', 'done')], NOW + 60_000)
  ];
  assert.deepEqual(rows, [
    { kind: 'card-transition', sampled: true, cardId: 'A', from: 'todo', to: 'doing' },
    { kind: 'card-transition', sampled: true, cardId: 'A', from: 'doing', to: 'done' }
  ]);
});

test('a new card is reported with its first status; unchanged cards are silent', () => {
  const ev = U.diffTasks([card('A', 'todo')], [card('A', 'todo'), card('B', 'blocked')], NOW);
  assert.deepEqual(ev, [{ kind: 'card-transition', sampled: true, cardId: 'B', from: null, to: 'blocked' }]);
});

test('asks are reported filed and answered with latency and an answer shape, never their text', () => {
  const q = { q: '**Secret question text?**', askedAt: '2026-11-12T11:00:00.000Z' };
  const before = [card('A', 'blocked', { humanQA: [] })];
  const filed = [card('A', 'blocked', { humanQA: [q] })];
  const answered = [card('A', 'blocked', { humanQA: [{ ...q, a: 'done', answeredAt: '2026-11-12T11:30:00.000Z' }] })];
  const e1 = U.diffTasks(before, filed, NOW);
  assert.deepEqual(e1, [{ kind: 'ask-filed', sampled: true, cardId: 'A', askKey: 'A@2026-11-12T11:00:00.000Z' }]);
  const e2 = U.diffTasks(filed, answered, NOW);
  assert.deepEqual(e2, [{ kind: 'ask-answered', sampled: true, cardId: 'A', askKey: 'A@2026-11-12T11:00:00.000Z', msSinceAsked: 1800_000, answerLen: 4, answerShape: 'done-ack' }]);
  assert.doesNotMatch(JSON.stringify([...e1, ...e2]), /Secret|question text/);
});

test('answer shapes', () => {
  assert.equal(U.answerShape('ack'), 'done-ack');
  assert.equal(U.answerShape('B'), 'option');
  assert.equal(U.answerShape('2'), 'option');
  assert.equal(U.answerShape('merge it'), 'short');
  assert.equal(U.answerShape('x'.repeat(100)), 'sentence');
  assert.equal(U.answerShape('x'.repeat(400)), 'long');
});

test('an unreadable or non-list ledger diffs to nothing', () => {
  assert.deepEqual(U.diffTasks(null, [card('A', 'todo')], NOW), []);
  assert.deepEqual(U.diffTasks([card('A', 'todo')], 'garbage', NOW), []);
});

// ── oversized hook messages ──────────────────────────────────────────────────

test('ids are read from the head of an oversized hook message; anything not id-shaped is dropped', () => {
  const head = Buffer.from('{"hook_event_name":"PostToolUse","agent_id":"worker-ysabet","tool_name":"Read","tool_response":"' + 'x'.repeat(5000));
  assert.deepEqual(U.frameIds(head, isAgent), { agentId: 'worker-ysabet', hookEvent: 'PostToolUse', toolName: 'Read' });
  assert.deepEqual(U.frameIds(Buffer.from('{"agent_id":"has spaces and text"}'), isAgent), {});
});

test('a hook agent id off the roster is dropped; unknown events and tools are "other"', () => {
  const long = 'Owner-said-the-unreleased-project-is-ORCHID.Owner-said-the-unreleased-project-is';
  const head = Buffer.from(JSON.stringify({ hook_event_name: long, agent_id: long, tool_name: long }) + 'x'.repeat(10));
  assert.deepEqual(U.frameIds(head, isAgent), { hookEvent: 'other', toolName: 'other' });
  const mcp = Buffer.from('{"hook_event_name":"PreToolUse","agent_id":"jc","tool_name":"mcp__notes__read_secret_file"}');
  assert.deepEqual(U.frameIds(mcp, isAgent), { agentId: 'jc', hookEvent: 'PreToolUse', toolName: 'other' });
});

// ── heavy-lock waits ─────────────────────────────────────────────────────────

test('a queued agent\'s acquire logs how long it waited', () => {
  let now = 1_000_000; const logs = [];
  const l = new HeavyJobLock({
    limit: () => 2, suiteLimit: () => 1, now: () => now, setTimer: () => ({}), clearTimer: () => {},
    log: (r) => logs.push(r), notify: () => true
  });
  const SUITE = { heavy: true, kind: 'suite', why: 'e2e.sh' };
  l.acquire('a', SUITE, 'e2e', 'a1', false);
  assert.equal(l.acquire('b', SUITE, 'e2e', 'b1', false).allow, false);
  now += 60_000;
  l.callDone('a', 'a1');
  now += 5_000;
  l.acquire('b', SUITE, 'e2e', 'b1', false);
  const acq = logs.filter((r) => r.action === 'acquire');
  assert.equal(acq[0].waitMs, undefined, 'no wait for a free slot');
  assert.equal(acq[1].waitMs, 65_000);
});

// ── nothing but validated ids, enums and numbers reaches a row ───────────────

test('probe: a sentence used as a conversation is not logged', () => {
  const t = new U.TurnTracker(IDS);
  t.noteDelivery('jc', { from: 'god', id: 'god-1', conversation: 'Owner said the unreleased project is ORCHID' }, 1000);
  t.prompt('jc', 1500);
  assert.doesNotMatch(JSON.stringify(t.stop('jc', 9000)), /ORCHID/);
  t.noteDelivery('jc', { from: 'god', id: MINTED_ID, conversation: 'Owner-said-the-unreleased-project-is-ORCHID.Owner-said-the-unreleased-project-is' }, 10_000);
  t.prompt('jc', 10_500);
  assert.doesNotMatch(JSON.stringify(t.stop('jc', 11_000)), /ORCHID/);
});

test('probe: free-text statuses, ask times and card ids are dropped field by field', () => {
  const prev = [{ id: 'card-secret-customer-name', status: 'todo', humanQA: [] }];
  const next = [{ id: 'card-secret-customer-name', status: 'paste private status here', humanQA: [{ q: 'q', askedAt: 'private question copied as key' }] },
    { id: 'a card id with spaces', status: 'doing' }];
  const rows = U.diffTasks(prev, next, NOW, new Map());
  const text = JSON.stringify(rows);
  assert.doesNotMatch(text, /paste private status|private question copied|a card id with spaces/);
  const moved = rows.find((r) => r.kind === 'card-transition' && r.cardId === 'card-secret-customer-name');
  assert.ok(moved, 'the row stays, without the bad field');
  assert.equal(moved.to, undefined);
  assert.equal(moved.from, 'todo');
});

test('probe: hook ids are read from the top level only, never from nested tool input', () => {
  const head = Buffer.from(JSON.stringify({
    tool_input: { agent_id: 'nested-agent', tool_name: 'NestedTool', hook_event_name: 'Nested' },
    hook_event_name: 'PostToolUse', agent_id: 'worker-ysabet', tool_name: 'Read'
  }).slice(0, -1) + ',"tool_response":"' + 'x'.repeat(5000));
  assert.deepEqual(U.frameIds(head, isAgent), { agentId: 'worker-ysabet', hookEvent: 'PostToolUse', toolName: 'Read' });
  const onlyNested = Buffer.from('{"tool_input":{"agent_id":"nested-agent","tool_name":"NestedTool"},"tool_response":"' + 'y'.repeat(5000));
  assert.deepEqual(U.frameIds(onlyNested, isAgent), {});
});

test('property: random prose in every input field never appears in any emitted row', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const WORDS = ['owner', 'secret', 'Pam', 'invoice', 'ORCHID', 'is', 'the', 'project', 'please', 'paste', 'here', 'v2', 'a-b'];
  const words = () => Array.from({ length: 3 + Math.floor(rand() * 5) }, () => WORDS[Math.floor(rand() * WORDS.length)]);
  // Half the inputs are plain prose; half are prose joined so it fits an id's character set.
  const prose = () => (rand() < 0.5
    ? words().join(rand() < 0.5 ? ' ' : ', ') + (rand() < 0.5 ? '.' : '?')
    : words().join(['.', '-', ':', '_'][Math.floor(rand() * 4)]).slice(0, 80));
  for (let i = 0; i < 300; i++) {
    const p = Array.from({ length: 12 }, prose);
    const rows = [];
    const t = new U.TurnTracker(IDS);
    t.noteDelivery(p[0], { from: p[1], id: p[2], conversation: p[3] }, 1000);
    t.prompt(p[0], 1500);
    rows.push(t.stop(p[0], 2000));
    rows.push(...U.diffTasks(
      // Card ids are the one input whose authority is tasks.json itself, so they are fixed here.
      [{ id: 'C-2', status: p[5], updatedAt: p[6], humanQA: [] }, { id: 'C-1', status: 'todo', humanQA: [] }],
      [{ id: 'C-2', status: p[7], humanQA: [{ q: p[8], askedAt: p[9], a: p[10], answeredAt: p[11] }] },
        { id: 'C-1', status: p[5], humanQA: [{ q: p[8], askedAt: p[9], a: p[10] }] }],
      NOW, new Map()));
    rows.push(U.frameIds(Buffer.from(JSON.stringify({ agent_id: p[0], hook_event_name: p[1], tool_name: p[2], tool_input: { agent_id: 'x' } })), isAgent));
    const text = JSON.stringify(rows);
    for (const s of p) assert.equal(text.includes(s), false, `prose reached a row: ${s}`);
  }
});

// ── sampled task rows ────────────────────────────────────────────────────────

// ── delivered, not intended ──────────────────────────────────────────────────

test('the delivery listener hears only recipients that took delivery', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-landed-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  hive.setGitCommitsDisabled?.(true);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Gone', provider: 'claude', cwd: home });
  // On the roster, but its inbox is gone: the message is dropped and bounced.
  fs.rmSync(path.join(home, 'hive', 'agents', 'worker-2', 'inbox'), { recursive: true, force: true });
  const heard = [];
  hive.setDeliveryListener((msg, landed) => heard.push([msg.id, [...landed]]));
  hive.send({ id: 'to-gone', to: 'worker-2', act: 'inform', subject: 's', body: 'b' }, 'worker-1');
  hive.send({ id: 'to-worker', to: 'worker-1', act: 'inform', subject: 's', body: 'b' }, 'god-1');
  assert.deepEqual(heard.find(([id]) => id === 'to-gone'), ['to-gone', []]);
  assert.deepEqual(heard.find(([id]) => id === 'to-worker'), ['to-worker', ['worker-1']]);
});
