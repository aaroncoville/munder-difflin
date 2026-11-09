'use strict';
/**
 * The router stamps created_at from its own clock as it routes a message, and keeps the
 * sender's value as client_created_at. A sender's clock can run ahead or behind; the stall
 * timer and every created_at-ordered read should measure from routing, not from it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-created-at-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Other', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  const post = (msg) => {
    fs.writeFileSync(path.join(agents, 'worker-1', 'outbox', `m-${Math.random()}.json`), JSON.stringify(msg));
    return hive.routeOnce();
  };
  return { hive, agents, post };
}

/** Run `fn` and return [before, after] in ms, to check a stamp fell inside the call. */
function during(fn) {
  const before = Date.now(); fn(); return [before, Date.now()];
}
const within = (iso, [a, b]) => { const t = Date.parse(iso); return t >= a && t <= b; };

test('a created_at ahead of the clock is replaced by the routing time, and kept as client_created_at', async (t) => {
  const { hive, post } = await floor(t);
  const ahead = new Date(Date.now() + 34 * 60_000).toISOString();
  const span = during(() => post({ to: 'god', act: 'inform', subject: 'ahead', body: 'b', created_at: ahead }));
  const m = hive.inbox('god-1').find((x) => x.subject === 'ahead');
  assert.ok(within(m.created_at, span), `${m.created_at} is the routing time`);
  assert.equal(m.client_created_at, ahead);
});

test('a created_at behind the clock is replaced too', async (t) => {
  const { hive, post } = await floor(t);
  const behind = '2026-01-01T00:00:00.000Z';
  const span = during(() => post({ to: 'god', act: 'inform', subject: 'behind', body: 'b', created_at: behind }));
  const m = hive.inbox('god-1').find((x) => x.subject === 'behind');
  assert.ok(within(m.created_at, span));
  assert.equal(m.client_created_at, behind);
});

test('a message with no created_at gets one, and no client_created_at', async (t) => {
  const { hive, post } = await floor(t);
  const span = during(() => post({ to: 'god', act: 'inform', subject: 'none', body: 'b' }));
  const m = hive.inbox('god-1').find((x) => x.subject === 'none');
  assert.ok(within(m.created_at, span));
  assert.equal('client_created_at' in m, false);
});

test('a message sent by the app is stamped the same way', async (t) => {
  const { hive } = await floor(t);
  let sent;
  const span = during(() => { sent = hive.send({ to: 'worker-1', act: 'inform', subject: 'app', body: 'b', created_at: '2030-01-01T00:00:00.000Z' }, 'system'); });
  assert.ok(within(sent.created_at, span));
  const m = hive.inbox('worker-1').find((x) => x.subject === 'app');
  assert.equal(m.created_at, sent.created_at);
  assert.equal(m.client_created_at, '2030-01-01T00:00:00.000Z');
});

test('every copy of a broadcast carries the one stamp, and the sender id is kept as written', async (t) => {
  const { hive, post } = await floor(t);
  post({ id: 'kept-id', to: 'broadcast', act: 'inform', subject: 'all', body: 'b', created_at: '2030-01-01T00:00:00.000Z' });
  const copies = ['god-1', 'worker-2'].map((a) => hive.inbox(a).find((x) => x.subject === 'all'));
  assert.equal(copies.length, 2);
  assert.ok(copies.every(Boolean));
  assert.equal(new Set(copies.map((c) => c.created_at)).size, 1, 'stamped once, not per copy');
  for (const c of copies) { assert.equal(c.client_created_at, '2030-01-01T00:00:00.000Z'); assert.equal(c.id, 'kept-id'); }
});

test('the stall timer reads the routing time: oldest pending mail is measured from when it was routed', async (t) => {
  const { hive, post } = await floor(t);
  const span = during(() => post({ to: 'god', act: 'inform', subject: 'old', body: 'b', created_at: new Date(Date.now() + 3_600_000).toISOString() }));
  // This is the read the stall rule makes: the earliest created_at across the agent's pending mail.
  const oldest = Math.min(...hive.inbox('god-1').map((m) => Date.parse(m.created_at)));
  assert.ok(oldest >= span[0] && oldest <= span[1], 'not an hour in the future');
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(source, /const mail = hive\.inbox\(agentId\);[\s\S]{0,400}Date\.parse\(m\.created_at \?\? ''\)/, 'the stall timer reads hive.inbox created_at');
});

test('a message already in an inbox with only the old field still reads, unchanged', async (t) => {
  const { hive, agents } = await floor(t);
  const legacy = { id: 'legacy-1', conversation: 'c', in_reply_to: null, from: 'worker-1', to: 'god-1', act: 'inform', subject: 'legacy', body: 'b', hops: 0, requires_reply: false, needs_human: false, created_at: '2026-11-09T05:10:00.000Z' };
  fs.writeFileSync(path.join(agents, 'god-1', 'inbox', 'legacy-1.json'), JSON.stringify(legacy));
  fs.writeFileSync(path.join(agents, 'god-1', 'inbox', '.done', 'legacy-2.json'), JSON.stringify({ ...legacy, id: 'legacy-2', subject: 'filed' }));
  const m = hive.inbox('god-1').find((x) => x.id === 'legacy-1');
  assert.equal(m.created_at, '2026-11-09T05:10:00.000Z');
  assert.equal(m.client_created_at, undefined);
  const voiced = hive.voiceMessages({ agentId: 'god-1', includeArchived: true });
  assert.ok(voiced.some((v) => v.id === 'legacy-1' && v.created_at === '2026-11-09T05:10:00.000Z'));
  assert.ok(voiced.some((v) => v.id === 'legacy-2'));
});
