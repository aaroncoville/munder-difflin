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

// ── the sender's archived copy, and a burst ──────────────────────────────────

/** A floor whose sender and recipient folders sort in the given order, so either copy is met first. */
async function pair(t, senderId, godId) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-created-at-pair-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: godId, name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: senderId, name: 'Helper', provider: 'claude', cwd: home });
  const outbox = path.join(home, 'hive', 'agents', senderId, 'outbox');
  return { hive, outbox };
}

for (const [senderId, godId] of [['a-sender', 'z-god'], ['z-sender', 'a-god']]) {
  test(`every read orders a routed message by its routed time, whichever copy is met first (${senderId} to ${godId})`, async (t) => {
    const { hive, outbox } = await pair(t, senderId, godId);
    fs.writeFileSync(path.join(outbox, 'probe.json'), JSON.stringify({ id: 'probe-1', to: 'god', act: 'inform', subject: 'probe', body: 'b', created_at: '2030-01-01T00:00:00.000Z' }));
    const span = during(() => hive.routeOnce());

    const all = hive.voiceMessages({}).filter((m) => m.id === 'probe-1');
    assert.equal(all.length, 1, 'once');
    assert.ok(within(all[0].created_at, span), `global read: ${all[0].created_at}`);
    assert.ok(within(hive.voiceMessages({ id: 'probe-1' })[0].created_at, span), 'by id');
    for (const agentId of [senderId, godId]) {
      const mine = hive.voiceMessages({ agentId }).filter((m) => m.id === 'probe-1');
      assert.equal(mine.length, 1, agentId);
      assert.ok(within(mine[0].created_at, span), `${agentId}: ${mine[0].created_at}`);
    }
    const sent = JSON.parse(fs.readFileSync(path.join(outbox, '.sent', 'probe.json'), 'utf8'));
    assert.equal(sent.client_created_at, '2030-01-01T00:00:00.000Z', "the sender's time is kept");
    assert.equal(sent.subject, 'probe');
    assert.equal(sent.id, 'probe-1', 'the id stays as the sender wrote it');
    assert.deepEqual(fs.readdirSync(path.join(outbox, '.sent')), ['probe.json'], 'no temporary file left behind');
  });
}

test('a burst written in one go keeps the order of its file names, even within one millisecond', async (t) => {
  const { hive, outbox } = await pair(t, 'sender-1', 'god-1');
  // Written newest-dated first, and stamped by the router well inside one millisecond of each other.
  ['3', '2', '1'].forEach((n, i) => fs.writeFileSync(path.join(outbox, `b${n}.json`),
    JSON.stringify({ to: 'god', act: 'inform', subject: `b${n}`, body: 'b', created_at: `2030-01-01T00:00:0${i}.000Z` })));
  // A frozen clock: every stamp in this routing pass falls in the same millisecond.
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T12:00:00.000Z') });
  hive.routeOnce();
  t.mock.timers.reset();
  const stamped = ['b1', 'b2', 'b3'].map((s) => hive.inbox('god-1').find((m) => m.subject === s).created_at);
  assert.ok(stamped[0] < stamped[1] && stamped[1] < stamped[2], stamped.join(' < '));
  assert.deepEqual(hive.voiceMessages({ agentId: 'god-1' }).map((m) => m.subject), ['b3', 'b2', 'b1'], 'newest first, in routing order');
});

// ── the router writes inside the sender's folder: every name there is hostile ──

const { ROUTED_LEAD_MS } = loadTs('src/main/hive.ts');

/** A file outside every agent folder that a planted link points at. */
function outsideFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-outside-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'precious.txt');
  fs.writeFileSync(file, 'keep me');
  return { dir, file };
}
const probe = { id: 'probe-1', to: 'god', act: 'inform', subject: 'probe', body: 'b', created_at: '2030-01-01T00:00:00.000Z' };

test('a link planted at the old temporary name is never written through', async (t) => {
  const { hive, outbox } = await pair(t, 'a-sender', 'z-god');
  const outside = outsideFile(t);
  fs.symlinkSync(outside.file, path.join(outbox, '.sent', `probe.json.${process.pid}.stamp.tmp`));
  fs.writeFileSync(path.join(outbox, 'probe.json'), JSON.stringify(probe));
  hive.routeOnce();
  assert.equal(fs.readFileSync(outside.file, 'utf8'), 'keep me');
  assert.ok(hive.inbox('z-god').some((m) => m.id === 'probe-1'), 'delivered');
});

test('a link planted at the archive name is left alone, and the copy is filed beside it', async (t) => {
  const { hive, outbox } = await pair(t, 'a-sender', 'z-god');
  const outside = outsideFile(t);
  fs.symlinkSync(outside.file, path.join(outbox, '.sent', 'probe.json'));
  fs.writeFileSync(path.join(outbox, 'probe.json'), JSON.stringify(probe));
  hive.routeOnce();
  assert.equal(fs.readFileSync(outside.file, 'utf8'), 'keep me');
  assert.ok(fs.lstatSync(path.join(outbox, '.sent', 'probe.json')).isSymbolicLink(), 'the link is not replaced or followed');
  const filed = JSON.parse(fs.readFileSync(path.join(outbox, '.sent', '1-probe.json'), 'utf8'));
  assert.notEqual(filed.created_at, probe.created_at, 'the copy filed beside it carries the routed time');
  assert.ok(hive.inbox('z-god').some((m) => m.id === 'probe-1'), 'delivered');
});

test('a .sent folder that is a link is not written into, the refusal is logged, and the message is delivered', async (t) => {
  const { hive, outbox } = await pair(t, 'a-sender', 'z-god');
  const outside = outsideFile(t);
  fs.rmSync(path.join(outbox, '.sent'), { recursive: true });
  fs.symlinkSync(outside.dir, path.join(outbox, '.sent'));
  fs.writeFileSync(path.join(outbox, 'probe.json'), JSON.stringify(probe));
  hive.routeOnce();
  assert.equal(fs.readFileSync(outside.file, 'utf8'), 'keep me');
  assert.ok(hive.inbox('z-god').some((m) => m.id === 'probe-1'), 'delivered');
  assert.ok(hive.logTail(50).some((r) => r.kind === 'sent-stamp-refused' && r.from === 'a-sender'), 'logged');
  assert.equal(fs.readdirSync(outside.dir).some((f) => f.endsWith('.tmp')), false, 'no temporary file written there');
});

test('a sender cannot forge from, hops or created_at into any read', async (t) => {
  const { hive, outbox } = await pair(t, 'a-sender', 'z-god');
  fs.writeFileSync(path.join(outbox, 'forged.json'), JSON.stringify({ ...probe, id: 'forged', from: 'z-god', hops: 999 }));
  const span = during(() => hive.routeOnce());
  const reads = [hive.voiceMessages({}), hive.voiceMessages({ id: 'forged' }), hive.voiceMessages({ agentId: 'a-sender' }), hive.voiceMessages({ agentId: 'z-god' })];
  for (const read of reads) {
    const m = read.find((x) => x.id === 'forged');
    assert.equal(m.from, 'a-sender');
    assert.ok(within(m.created_at, span), m.created_at);
  }
  const filed = JSON.parse(fs.readFileSync(path.join(outbox, '.sent', 'forged.json'), 'utf8'));
  assert.equal(filed.from, 'a-sender');
  assert.ok(filed.hops <= 12, `hops ${filed.hops} is the router's clamp`);
  assert.equal(filed.client_created_at, probe.created_at);
});

test('a large burst in one instant stays within the clock lead and in file-name order', async (t) => {
  const { hive, outbox } = await pair(t, 'sender-1', 'god-1');
  const names = Array.from({ length: 300 }, (_, i) => `b${String(i).padStart(3, '0')}`);
  for (const n of [...names].reverse()) fs.writeFileSync(path.join(outbox, `${n}.json`), JSON.stringify({ to: 'god', act: 'inform', subject: n, body: 'b' }));
  const frozen = Date.parse('2026-11-09T12:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: frozen });
  hive.routeOnce();
  t.mock.timers.reset();
  const byName = new Map(hive.inbox('god-1').map((m) => [m.subject, Date.parse(m.created_at)]));
  const stamps = names.map((n) => byName.get(n));
  assert.ok(stamps.every((s, i) => i === 0 || s >= stamps[i - 1]), 'never out of order');
  assert.ok(Math.max(...stamps) - frozen <= ROUTED_LEAD_MS, `lead ${Math.max(...stamps) - frozen} ms`);
  assert.ok(stamps.slice(0, ROUTED_LEAD_MS).every((s, i) => i === 0 || s > stamps[i - 1]), 'distinct while within the lead');
});
