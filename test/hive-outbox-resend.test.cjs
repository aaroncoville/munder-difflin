'use strict';
/**
 * An agent that checks its outbox to confirm a send finds it already empty, because the router
 * files a routed message under outbox/.sent within a second or two, and writes the message again.
 * The recipient then gets the same message twice and acts on it twice. The router now delivers a
 * message once when the same sender writes the same message to the same recipient again within a
 * short window, including after the app restarts.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

const MINUTE = 60_000;

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resend-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Other', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  let n = 0;
  const post = (h, msg, now = Date.now(), from = 'worker-1') => {
    fs.writeFileSync(path.join(agents, from, 'outbox', `m-${n++}.json`), JSON.stringify(msg));
    return h.routeOnce(now);
  };
  const got = (agent, subject) => hive.inbox(agent).filter((m) => m.subject === subject).length;
  const log = () => fs.readFileSync(path.join(home, 'hive', 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { home, hive, agents, post, got, log };
}

const done = { to: 'god', act: 'done', subject: 'finished', body: 'PR #1 open', in_reply_to: 'req-1', conversation: 'C-1' };

test('the same message written again within the window is delivered once', async (t) => {
  const { hive, agents, post, got, log } = await floor(t);
  const now = Date.now();
  assert.equal(post(hive, done, now), 1);
  assert.equal(post(hive, done, now + 36_000), 0, 'the repeat is not routed');
  assert.equal(got('god-1', 'finished'), 1);
  const outbox = path.join(agents, 'worker-1', 'outbox');
  assert.deepEqual(fs.readdirSync(outbox).filter((f) => f.endsWith('.json')), [], 'the repeat leaves the outbox');
  assert.ok(fs.readdirSync(path.join(outbox, '.sent')).includes('dup-m-1.json'), 'and is filed as a duplicate');
  const row = log().find((r) => r.kind === 'outbox-duplicate');
  assert.ok(row, 'and logged');
  assert.equal(row.from, 'worker-1');
  assert.equal(row.file, 'm-1.json');
});

test('the same message written again after the window is delivered again', async (t) => {
  const { hive, post, got } = await floor(t);
  const now = Date.now();
  post(hive, done, now);
  assert.equal(post(hive, done, now + 10 * MINUTE + 1), 1);
  assert.equal(got('god-1', 'finished'), 2);
});

test('a message that differs in any field the recipient reads is delivered', async (t) => {
  const { hive, post, got } = await floor(t);
  const now = Date.now();
  post(hive, done, now);
  for (const change of [
    { body: 'PR #2 open' },
    { subject: 'finished ' },
    { act: 'inform' },
    { in_reply_to: 'req-2' },
    { conversation: 'C-2' },
    { to: 'worker-2' }
  ]) {
    assert.equal(post(hive, { ...done, ...change }, now + 1000), 1, JSON.stringify(change));
  }
  assert.equal(got('god-1', 'finished') + got('god-1', 'finished ') + got('worker-2', 'finished'), 7);
});

test('the same message from another sender is delivered', async (t) => {
  const { hive, post, got } = await floor(t);
  const now = Date.now();
  post(hive, done, now, 'worker-1');
  assert.equal(post(hive, done, now + 1000, 'worker-2'), 1);
  assert.equal(got('god-1', 'finished'), 2);
});

test('a repeat written after the app restarts is delivered once', async (t) => {
  const { home, hive, post, got } = await floor(t);
  post(hive, done);
  const restarted = new HiveManager(() => home);
  assert.equal(post(restarted, done), 0);
  assert.equal(got('god-1', 'finished'), 1);
});

test('a message that could not be delivered does not hold back the same message written again', async (t) => {
  const { hive, agents, post, got } = await floor(t);
  const inbox = path.join(agents, 'god-1', 'inbox');
  const now = Date.now();
  fs.renameSync(inbox, `${inbox}.away`);
  assert.equal(post(hive, done, now), 0, 'not delivered: the recipient has no inbox');
  fs.renameSync(`${inbox}.away`, inbox);
  assert.equal(post(hive, done, now + 1000), 1);
  assert.equal(got('god-1', 'finished'), 1);
});

const bare = { to: 'god', act: 'done', subject: 'bare', body: 'PR #3 open', in_reply_to: 'req-3' };

test('a repeat whose sender left out the conversation is delivered once', async (t) => {
  const { hive, post, got } = await floor(t);
  const now = Date.now();
  post(hive, bare, now);
  assert.equal(post(hive, bare, now + 1000), 0);
  assert.equal(got('god-1', 'bare'), 1);
});

test('a repeat whose sender left out the conversation is delivered once after the app restarts', async (t) => {
  const { home, hive, post, got } = await floor(t);
  post(hive, bare);
  assert.equal(post(new HiveManager(() => home), bare), 0);
  assert.equal(got('god-1', 'bare'), 1);
});

/** Files `msg` under worker-1's outbox/.sent as if it had been routed, with the given mtime. */
function filed(agents, name, msg, mtimeMs, pad = '') {
  const file = path.join(agents, 'worker-1', 'outbox', '.sent', name);
  fs.writeFileSync(file, JSON.stringify(msg) + pad);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

test('after a restart, a message set aside as undelivered does not hold back the same message', async (t) => {
  const { home, hive, agents, post, got } = await floor(t);
  const inbox = path.join(agents, 'god-1', 'inbox');
  fs.renameSync(inbox, `${inbox}.away`);
  assert.equal(post(hive, done), 0);
  fs.renameSync(`${inbox}.away`, inbox);
  assert.equal(post(new HiveManager(() => home), done), 1);
  assert.equal(got('god-1', 'finished'), 1);
});

test('after a restart, the window runs from when the original was routed, not from a repeat filed as dup-', async (t) => {
  const { home, hive, agents, post, got } = await floor(t);
  const now = Date.now();
  post(hive, done, now);
  post(hive, done, now);
  const sent = path.join(agents, 'worker-1', 'outbox', '.sent');
  fs.utimesSync(path.join(sent, 'm-0.json'), (now - 9 * MINUTE) / 1000, (now - 9 * MINUTE) / 1000);
  fs.utimesSync(path.join(sent, 'dup-m-1.json'), (now - MINUTE) / 1000, (now - MINUTE) / 1000);
  assert.equal(post(new HiveManager(() => home), done, now + 2 * MINUTE), 1, 'the original was routed 11 minutes before');
  assert.equal(got('god-1', 'finished'), 2);
});

test('after a restart, a link, or a copy too large to be a message, under .sent is not read back', async (t) => {
  const { home, agents, post, got } = await floor(t);
  const elsewhere = path.join(home, 'elsewhere.json');
  fs.writeFileSync(elsewhere, JSON.stringify({ ...done, from: 'worker-1' }));
  fs.symlinkSync(elsewhere, path.join(agents, 'worker-1', 'outbox', '.sent', 'linked.json'));
  filed(agents, 'huge.json', { ...bare, from: 'worker-1' }, Date.now(), ' '.repeat(1_100_000));
  const restarted = new HiveManager(() => home);
  assert.equal(post(restarted, done), 1);
  assert.equal(post(restarted, bare), 1);
  assert.equal(got('god-1', 'finished') + got('god-1', 'bare'), 2);
});

test('after a restart, a copy dated in the future counts from now, not from its date', async (t) => {
  const { home, agents, post, got } = await floor(t);
  const now = Date.now();
  filed(agents, 'ahead.json', { ...done, from: 'worker-1' }, now + 60 * MINUTE);
  const restarted = new HiveManager(() => home);
  post(restarted, { to: 'god', act: 'inform', subject: 'first', body: 'reads .sent back' }, now);
  assert.equal(post(restarted, done, now + 11 * MINUTE), 1);
  assert.equal(got('god-1', 'finished'), 1);
});
