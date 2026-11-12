'use strict';
// The router's side of the pipeline (spec 5.1). A message addressed to "pipeline" is
// handed to the conductor, never to an inbox; its payload is read strictly from the
// file the agent wrote (a name given twice is refused) and validated before the
// conductor sees it; anything else is refused back to the sender with the reasons.
// With no conductor attached (the pipeline off), every such message is refused.
// A payload on mail between agents is dropped: only the app's own sender carries one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const core = require('../src/main/pipeline/mr-core.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const S = 'eecd72bae05026701fee211b6c96774e33585587';
const SUBMIT = { schema: 'mr.submit/1', card: 'WF-FB-VEHICLES', repo: 'wayfarer', mr: 181, head_sha: S, kind: 'initial', answers: null, dispositions: [], tests: [], summary: 's', decisions_taken: [], needs_owner: null };

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pipe-route-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Other', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  const outbox = path.join(agents, 'worker-1', 'outbox');
  const postText = (text) => { fs.writeFileSync(path.join(outbox, `m-${Math.random()}.json`), text); return hive.routeOnce(); };
  const post = (msg) => postText(JSON.stringify(msg));
  const log = () => fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { hive, agents, outbox, post, postText, log };
}
const toPipeline = (payload, over = {}) => ({ to: 'pipeline', act: 'done', subject: 'submit', body: 'b', conversation: 'WF-FB-VEHICLES', payload, ...over });
const refusals = (hive) => hive.inbox('worker-1').filter((m) => m.from === 'pipeline' && m.act === 'refuse');

test('with no conductor attached, a message to the pipeline is refused to its sender, and god hears nothing', async (t) => {
  const { hive, outbox, post } = await floor(t);
  post(toPipeline(SUBMIT));
  const r = refusals(hive);
  assert.equal(r.length, 1);
  assert.match(r[0].body, /not enabled|not on/i);
  assert.deepEqual(hive.inbox('god-1'), []);
  assert.deepEqual(fs.readdirSync(outbox).filter((f) => f.endsWith('.json')), [], 'the file is filed, not left to retry');
});

test('a corrected payload sent with the same subject and body is not taken for a resend', async (t) => {
  const { hive, post } = await floor(t);
  const got = [];
  hive.setPipelineSink((msg) => { got.push(msg); });
  post(toPipeline({ ...SUBMIT, kind: 'initial' }));
  post(toPipeline({ ...SUBMIT, kind: 'rebase' }));
  post(toPipeline({ ...SUBMIT, kind: 'rebase' }));
  assert.deepEqual(got.map((m) => m.payload.kind), ['initial', 'rebase'], 'the exact resend is still filed as a repeat');
});

test('with a conductor attached, a valid payload reaches it from the sender\'s own folder, and no inbox gets it', async (t) => {
  const { hive, post, log } = await floor(t);
  const got = [];
  hive.setPipelineSink((msg) => { got.push(msg); });
  post(toPipeline(SUBMIT, { from: 'god-1' }));
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'worker-1', 'the sender is the folder, never what the file says');
  assert.deepEqual(got[0].payload, SUBMIT);
  assert.deepEqual(hive.inbox('god-1'), []);
  assert.deepEqual(refusals(hive), []);
  const row = log().find((l) => l.kind === 'message' && l.to === 'pipeline');
  assert.deepEqual(row.delivered, ['pipeline']);
  assert.equal(row.schema, 'mr.submit/1');
});

test('an invalid payload is refused with every failed field, and the conductor never sees it', async (t) => {
  const { hive, post } = await floor(t);
  const got = [];
  hive.setPipelineSink((msg) => { got.push(msg); });
  post(toPipeline({ ...SUBMIT, head_sha: S.slice(0, 8), mr: -1 }));
  post(toPipeline(undefined));
  post(toPipeline({ schema: 'mr.review-request/1', card: 'WF-FB-VEHICLES' }));
  assert.equal(got.length, 0);
  const r = refusals(hive);
  assert.equal(r.length, 3);
  assert.match(r[0].body, /head_sha/);
  assert.match(r[0].body, /mr/);
});

test('a message file that gives a name twice is refused, at the top or inside the payload', async (t) => {
  const { hive, postText } = await floor(t);
  const got = [];
  hive.setPipelineSink((msg) => { got.push(msg); });
  const body = JSON.stringify(toPipeline(SUBMIT));
  postText(body.replace('"to":"pipeline"', '"to":"pipeline","to":"pipeline"'));
  postText(body.replace(`"head_sha":"${S}"`, `"head_sha":"${S}","head_sha":"${'1'.repeat(40)}"`));
  assert.equal(got.length, 0);
  assert.equal(refusals(hive).length, 2);
  assert.match(refusals(hive)[1].body, /twice/);
});

test('a payload on mail between agents is dropped and logged: only the app sends payloads to agents', async (t) => {
  const { hive, post, log } = await floor(t);
  post({ to: 'worker-2', act: 'request', subject: 'review this', body: 'b', payload: { schema: 'mr.review-request/1', card: 'X', request_id: 'X:r1:worker-2', sha: S, round: 1 } });
  const m = hive.inbox('worker-2').find((x) => x.subject === 'review this');
  assert.ok(m, 'the message itself is delivered');
  assert.equal('payload' in m, false);
  assert.ok(log().some((l) => l.kind === 'payload-dropped' && l.from === 'worker-1'));
});

test('property: any text written to the pipeline is filed, never throws, and only valid payloads reach the conductor', async (t) => {
  const { hive, outbox, postText } = await floor(t);
  const got = [];
  hive.setPipelineSink((msg) => { got.push(msg); });
  let seed = 11;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const base = JSON.stringify(toPipeline(SUBMIT));
  for (let i = 0; i < 200; i++) {
    let text = base;
    const k = Math.floor(rnd() * 4);
    if (k === 0) { const at = Math.floor(rnd() * text.length); text = text.slice(0, at) + text.slice(at + 1 + Math.floor(rnd() * 5)); }
    if (k === 1) { const at = Math.floor(rnd() * text.length); text = text.slice(0, at) + '{}[]",:\\0a'[Math.floor(rnd() * 10)] + text.slice(at); }
    if (k === 2) text = text.replace(/"(mr|round|kind|card|schema)":("[^"]*"|\d+)/, (m0, f) => `"${f}":${JSON.stringify(['x', -1, null, [], {}, 1e999][Math.floor(rnd() * 6)])}`);
    assert.doesNotThrow(() => postText(text));
  }
  for (const m of got) assert.equal(core.validatePayload(m.payload).ok, true, JSON.stringify(m.payload).slice(0, 120));
  // Every file was filed, except text JSON.parse cannot read at all: the existing retry for half-written files holds those.
  for (const f of fs.readdirSync(outbox).filter((x) => x.endsWith('.json'))) {
    assert.throws(() => JSON.parse(fs.readFileSync(path.join(outbox, f), 'utf8')), f);
  }
});

// --- what agents are told (PROTOCOL.md and their brief) ---

const promptOf = (inj) => inj.args[inj.args.findIndex((a) => a === '--append-system-prompt' || a === '--prompt') + 1];

test('agents are told about hive-mr only while a conductor is attached with its path', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-pipe-brief-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  const cli = '/Applications/Munder Difflin.app/Contents/Resources/hive-mr.cjs';
  const off = promptOf(await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true }));
  assert.doesNotMatch(off, /hive-mr/);
  hive.setPipelineSink(() => {}, cli);
  const on = promptOf(await hive.ensureAgent({ id: 'worker-9', name: 'W', provider: 'claude', cwd: home }));
  assert.ok(on.includes(`"${cli}" submit`) && on.includes(`"${cli}" verdict --request`));
  hive.setPipelineSink(null, cli);
  const detached = promptOf(await hive.ensureAgent({ id: 'worker-8', name: 'V', provider: 'claude', cwd: home }));
  assert.doesNotMatch(detached, /hive-mr/);
  const protocol = fs.readFileSync(path.join(home, 'hive', 'PROTOCOL.md'), 'utf8');
  assert.match(protocol, /## The merge-request pipeline/);
  assert.match(protocol, /hive-mr submit --card/);
  assert.match(protocol, /hive-mr verdict --request/);
  assert.match(protocol, /Do not write or edit those\s+by hand/);
});

// --- review round 1 ---

test('M1: a message the conductor threw on is refused to its sender, not logged as delivered, and its resend goes through', async (t) => {
  const { hive, post, log } = await floor(t);
  let fail = true;
  const got = [];
  hive.setPipelineSink((m) => { if (fail) throw new Error('conductor down'); got.push(m); });
  post(toPipeline(SUBMIT));
  assert.equal(refusals(hive).length, 1);
  assert.match(refusals(hive)[0].body, /could not take|send it again/i);
  assert.equal(log().filter((l) => l.kind === 'message' && l.to === 'pipeline').length, 0, 'nothing logged as delivered');
  fail = false;
  post(toPipeline(SUBMIT));
  assert.equal(got.length, 1, 'the resend is not taken for a repeat');
});

test('M1: a message refused while the pipeline was off goes through when sent again once it is on', async (t) => {
  const { hive, post } = await floor(t);
  post(toPipeline(SUBMIT));
  assert.equal(refusals(hive).length, 1);
  const got = [];
  hive.setPipelineSink((m) => got.push(m));
  post(toPipeline(SUBMIT));
  assert.equal(got.length, 1);
});

test('L1: the same payload sent again under a new message id is a repeat, and the conductor gets a stable key that survives a restart', async (t) => {
  const { hive, post, agents } = await floor(t);
  const got = [];
  hive.setPipelineSink((m) => got.push(m));
  post({ ...toPipeline(SUBMIT), id: 'first-run' });
  post({ ...toPipeline(SUBMIT), id: 'second-run' });
  assert.equal(got.length, 1, 're-running hive-mr is a repeat');
  assert.match(got[0].key, /^[0-9a-f]{64}$/);
  // After a restart the router's memory is gone: the conductor must dedupe on the key.
  const home = path.dirname(path.dirname(agents));
  const again = new HiveManager(() => home);
  const later = [];
  again.setPipelineSink((m) => later.push(m));
  fs.writeFileSync(path.join(agents, 'worker-1', 'outbox', 'third.json'), JSON.stringify({ ...toPipeline(SUBMIT), id: 'third-run' }));
  again.routeOnce();
  assert.equal(later.length, 1);
  assert.equal(later[0].key, got[0].key, 'the same sender and payload give the same key');
  const other = await (async () => { const g = []; again.setPipelineSink((m) => g.push(m)); fs.writeFileSync(path.join(agents, 'worker-1', 'outbox', 'fourth.json'), JSON.stringify(toPipeline({ ...SUBMIT, kind: 'rebase' }))); again.routeOnce(); return g; })();
  assert.notEqual(other[0].key, got[0].key);
  // The same payload from another sender is another message.
  const fromOther = [];
  again.setPipelineSink((m) => fromOther.push(m));
  fs.writeFileSync(path.join(agents, 'worker-2', 'outbox', 'w2.json'), JSON.stringify(toPipeline(SUBMIT)));
  again.routeOnce();
  assert.equal(fromOther.length, 1);
  assert.notEqual(fromOther[0].key, got[0].key, 'the sender is part of the key');
});

test('L2: the conductor gets only typed envelope fields; a subject or body that is not text is refused', async (t) => {
  const { hive, post } = await floor(t);
  const got = [];
  hive.setPipelineSink((m) => got.push(m));
  post(toPipeline(SUBMIT, { subject: { evil: true } }));
  post(toPipeline(SUBMIT, { body: ['x'] }));
  assert.equal(got.length, 0);
  assert.equal(refusals(hive).length, 2);
  post(toPipeline(SUBMIT, { extra: 'field', needs_human: 'yes' }));
  assert.equal(got.length, 1);
  assert.deepEqual(Object.keys(got[0]).sort(), ['act', 'body', 'conversation', 'created_at', 'from', 'id', 'in_reply_to', 'key', 'payload', 'subject']);
  for (const k of ['act', 'body', 'conversation', 'created_at', 'from', 'id', 'subject', 'key']) assert.equal(typeof got[0][k], 'string', k);
});

test('L3: mr.command is accepted only from god', async (t) => {
  const { hive, post, agents } = await floor(t);
  const got = [];
  hive.setPipelineSink((m) => got.push(m));
  const cmd = { schema: 'mr.command/1', card: 'WF-FB-VEHICLES', command: 'pause', args: {}, reason: 'r' };
  post(toPipeline(cmd));
  assert.equal(got.length, 0);
  assert.match(refusals(hive)[0].body, /god/);
  fs.writeFileSync(path.join(agents, 'god-1', 'outbox', 'c.json'), JSON.stringify(toPipeline(cmd)));
  hive.routeOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].from, 'god-1');
});

test('L7: mail to the pipeline under another case is refused with the right name, and god hears nothing', async (t) => {
  const { hive, post } = await floor(t);
  const got = [];
  hive.setPipelineSink((m) => got.push(m));
  post(toPipeline(SUBMIT, { to: 'Pipeline' }));
  post(toPipeline(SUBMIT, { to: 'PIPELINE' }));
  assert.equal(got.length, 0);
  assert.equal(refusals(hive).length, 2);
  assert.match(refusals(hive)[0].body, /"pipeline"/);
  assert.deepEqual(hive.inbox('god-1'), []);
});

test('(c) a refusal that cannot be delivered is not dropped: the file is set aside and someone is told', async (t) => {
  const { hive, post, outbox, agents, log } = await floor(t);
  fs.rmSync(path.join(agents, 'worker-1', 'inbox'), { recursive: true, force: true });
  post(toPipeline(SUBMIT));
  assert.ok(log().some((l) => l.kind !== 'message' && JSON.stringify(l).includes('not-delivered')), 'the failure is logged');
  const sent = fs.existsSync(path.join(outbox, '.sent')) ? fs.readdirSync(path.join(outbox, '.sent')).filter((f) => f.endsWith('.json')) : [];
  assert.ok(sent.length === 1 && sent[0].startsWith('bad-'), `set aside as undelivered, not filed as sent: ${sent}`);
  assert.ok(hive.inbox('god-1').length >= 1, 'god is told, since the sender cannot be');
});
