'use strict';

/**
 * outbox/.sent means delivered. A message that landed nowhere must not be filed
 * there under its own name, and a sender whose message failed must hear about it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-undelivered-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  // A provider with no hook bridge: direct mail to it bounces to god when nothing can take a handoff.
  await hive.ensureAgent({ id: 'hopless-1', name: 'Hookless', provider: 'kimi', cwd: home });
  const agent = (id) => path.join(home, 'hive', 'agents', id);
  const write = (from, file, content) =>
    fs.writeFileSync(path.join(agent(from), 'outbox', file), typeof content === 'string' ? content : JSON.stringify(content));
  const sent = (from, file) => fs.existsSync(path.join(agent(from), 'outbox', '.sent', file));
  const pending = (from, file) => fs.existsSync(path.join(agent(from), 'outbox', file));
  const log = () => hive.logTail(200);
  return { hive, agent, write, sent, pending, log };
}

/** Routes one pass with a read-only inbox, which makes the real write fail. Restored so the temporary folder can be removed. */
function routeWithBlockedInbox(hive, agentDir) {
  const inbox = path.join(agentDir, 'inbox');
  fs.chmodSync(inbox, 0o555);
  try {
    return hive.routeOnce();
  } finally {
    fs.chmodSync(inbox, 0o755);
  }
}

const MESSAGE = { to: 'god', act: 'inform', subject: 'hello', body: 'world' };

test('a hop-capped message is not filed as sent, is logged, and its sender is told', async (t) => {
  const { hive, write, sent, log } = await floor(t);
  write('worker-1', 'loop.json', { to: 'hopless-1', act: 'inform', subject: 'loop', body: 'b', hops: 12 });

  assert.equal(hive.routeOnce(), 0);

  assert.equal(sent('worker-1', 'loop.json'), false);
  assert.equal(sent('worker-1', 'bad-loop.json'), true);
  assert.equal(hive.inbox('god-1').length, 0);
  assert.ok(log().some((r) => r.kind === 'drop' && r.reason === 'hop-cap'));
  const notices = hive.inbox('worker-1');
  assert.equal(notices.length, 1);
  assert.match(notices[0].subject, /not delivered/i);
  assert.match(notices[0].body, /loop\.json/);
});

test('a bounce to god counts as landed: filed as sent, and no failure notice', async (t) => {
  const { hive, write, sent } = await floor(t);
  write('worker-1', 'to-hookless.json', { to: 'hopless-1', act: 'inform', subject: 's', body: 'b' });

  assert.equal(hive.routeOnce(), 1);

  assert.equal(sent('worker-1', 'to-hookless.json'), true);
  assert.equal(hive.inbox('god-1').length, 1);
  assert.equal(hive.inbox('worker-1').length, 0);
});

test('mail to an unknown id bounces to god and counts as landed', async (t) => {
  const { hive, write, sent } = await floor(t);
  write('worker-1', 'unknown.json', { to: 'nobody', act: 'inform', subject: 's', body: 'b' });

  assert.equal(hive.routeOnce(), 1);

  assert.equal(sent('worker-1', 'unknown.json'), true);
  assert.equal(hive.inbox('worker-1').length, 0);
});

test('a message from god to the human has no delivery target and is not a failure', async (t) => {
  const { hive, write, sent, log } = await floor(t);
  write('god-1', 'ask.json', { to: 'human', act: 'query', subject: 'a question', body: 'b' });

  assert.equal(hive.routeOnce(), 1);

  assert.equal(sent('god-1', 'ask.json'), true);
  assert.equal(hive.inbox('god-1').length, 0);
  assert.equal(log().some((r) => r.kind === 'outbox-error'), false);
});

test('a routing failure is logged and the sender is told it may have partly delivered', async (t) => {
  const { hive, agent, write, sent, log } = await floor(t);
  write('worker-1', 'fails.json', MESSAGE);

  assert.equal(routeWithBlockedInbox(hive, agent('god-1')), 0);

  assert.equal(sent('worker-1', 'fails.json'), false);
  assert.equal(sent('worker-1', 'bad-fails.json'), true);
  assert.ok(log().some((r) => r.kind === 'outbox-error' && r.stage === 'route' && r.file === 'fails.json'));
  const notices = hive.inbox('worker-1');
  assert.equal(notices.length, 1);
  assert.match(notices[0].body, /may have reached/i);
});

test('a file that parses but is not a message is reported, not silently set aside', async (t) => {
  const { hive, write, sent, log } = await floor(t);
  write('worker-1', 'null.json', 'null');

  assert.equal(hive.routeOnce(), 0);

  assert.equal(sent('worker-1', 'bad-null.json'), true);
  assert.ok(log().some((r) => r.kind === 'outbox-error' && r.file === 'null.json'));
  assert.equal(hive.inbox('worker-1').length, 1);
});

test('a failure report does not quote the error text', async (t) => {
  const { hive, agent, write, log } = await floor(t);
  write('worker-1', 'fails.json', MESSAGE);

  routeWithBlockedInbox(hive, agent('god-1'));

  const home = path.dirname(path.dirname(agent('god-1')));
  assert.equal(hive.inbox('worker-1')[0].body.includes(home), false, 'the notice holds no absolute path');
  const row = log().find((r) => r.kind === 'outbox-error' && r.file === 'fails.json');
  assert.equal(JSON.stringify(row).includes(home), false, 'the log row holds no absolute path');
});

test('when only the archive step fails the sender is told not to resend', async (t) => {
  const { hive, agent, write, sent, log } = await floor(t);
  // A directory with something in it cannot be renamed over.
  fs.mkdirSync(path.join(agent('worker-1'), 'outbox', '.sent', 'arch.json', 'x'), { recursive: true });
  write('worker-1', 'arch.json', MESSAGE);

  assert.equal(hive.routeOnce(), 0);

  assert.equal(hive.inbox('god-1').length, 1, 'it was delivered');
  assert.equal(sent('worker-1', 'bad-arch.json'), true);
  assert.ok(log().some((r) => r.kind === 'outbox-error' && r.stage === 'archive'));
  assert.match(hive.inbox('worker-1')[0].body, /do not resend/i);
});

test('a file that cannot be set aside is logged and does not notify on every pass', async (t) => {
  const { hive, agent, write, pending, log } = await floor(t);
  fs.rmSync(path.join(agent('worker-1'), 'outbox', '.sent'), { recursive: true });
  write('worker-1', 'stuck.json', 'null');

  hive.routeOnce();
  hive.routeOnce();

  assert.equal(pending('worker-1', 'stuck.json'), true);
  assert.equal(hive.inbox('worker-1').length, 0);
  assert.ok(log().some((r) => r.kind === 'outbox-error' && r.quarantine === 'failed' && r.file === 'stuck.json'));
});
