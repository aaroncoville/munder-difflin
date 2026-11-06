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
const outboxFailure = loadTs('src/main/outboxFailure.ts');
const ts = require('typescript');

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

/** The archive step fails once, as when the disk refuses it, and the file can still be set aside. */
function failArchiveOnce(t) {
  t.mock.method(outboxFailure, 'archiveOutboxFile', () => { throw Object.assign(new Error('refused'), { code: 'EIO' }); }, { times: 1 });
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
  const { hive, write, sent, log } = await floor(t);
  failArchiveOnce(t);
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

test('a second failed file of the same name does not overwrite the first', async (t) => {
  const { hive, agent, write } = await floor(t);
  const sentDir = path.join(agent('worker-1'), 'outbox', '.sent');
  // Both parse but are not messages, and the second reuses the first's file name.
  write('worker-1', 'again.json', 'null');
  hive.routeOnce();
  write('worker-1', 'again.json', ' null');
  hive.routeOnce();

  const kept = fs.readdirSync(sentDir).filter((f) => f.includes('again.json'));
  assert.equal(kept.length, 2);
  assert.deepEqual(kept.map((f) => fs.readFileSync(path.join(sentDir, f), 'utf8')).sort(), [' null', 'null']);
  const notices = hive.inbox('worker-1').map((m) => m.body).join('\n');
  for (const f of kept) assert.ok(notices.includes(f), `the sender is told where ${f} is`);
});

test('a second malformed file of the same name does not overwrite the first', async (t) => {
  const { hive, agent, write } = await floor(t);
  const sentDir = path.join(agent('worker-1'), 'outbox', '.sent');
  const T0 = 1_000_000;
  write('worker-1', 'broken.json', '{ first');
  hive.routeOnce(T0);
  hive.routeOnce(T0 + 10_000);
  write('worker-1', 'broken.json', '{ second');
  hive.routeOnce(T0 + 20_000);
  hive.routeOnce(T0 + 30_000);

  const kept = fs.readdirSync(sentDir).filter((f) => f.includes('broken.json'));
  assert.deepEqual(kept.map((f) => fs.readFileSync(path.join(sentDir, f), 'utf8')).sort(), ['{ first', '{ second']);
  const notices = hive.inbox('worker-1').map((m) => m.body).join('\n');
  for (const f of kept) assert.ok(notices.includes(f), `the sender is told where ${f} is`);
});

test('a directory with a message-like name can still be set aside', async (t) => {
  const { hive, agent, sent, pending } = await floor(t);
  fs.mkdirSync(path.join(agent('worker-1'), 'outbox', 'dir.json'));

  hive.routeOnce();

  assert.equal(pending('worker-1', 'dir.json'), false);
  assert.equal(sent('worker-1', 'bad-dir.json'), true);
});

test('a sender at the relay limit gets no new budget when its archive step fails', async (t) => {
  const { hive, agent, write } = await floor(t);
  failArchiveOnce(t);
  write('hopless-1', 'cap.json', { to: 'worker-1', act: 'inform', subject: 's', body: 'b', hops: 12 });

  hive.routeOnce();

  assert.equal(hive.inbox('worker-1').length, 1, 'it was delivered');
  assert.equal(hive.inbox('god-1').length, 0, 'the notice to a hookless sender at the limit must not bounce on');
});

test('a sender at the relay limit gets no new budget when routing throws', async (t) => {
  const { hive, agent, write } = await floor(t);
  write('hopless-1', 'cap.json', { to: 'worker-1', act: 'inform', subject: 's', body: 'b', hops: 12 });

  routeWithBlockedInbox(hive, agent('worker-1'));

  assert.equal(hive.inbox('god-1').length, 0, 'the notice to a hookless sender at the limit must not bounce on');
});

test('a second delivered file of the same name keeps the first in .sent', async (t) => {
  const { hive, agent, write } = await floor(t);
  const sentDir = path.join(agent('worker-1'), 'outbox', '.sent');
  write('worker-1', 'report.json', { ...MESSAGE, id: 'first', body: 'one' });
  assert.equal(hive.routeOnce(), 1);
  write('worker-1', 'report.json', { ...MESSAGE, id: 'second', body: 'two' });
  assert.equal(hive.routeOnce(), 1);

  const bodies = fs.readdirSync(sentDir).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(sentDir, f), 'utf8')).body).sort();
  assert.deepEqual(bodies, ['one', 'two']);
});

test('a message with no recipient copy keeps its only record when the file name is reused', async (t) => {
  const { hive, agent, write } = await floor(t);
  write('god-1', 'ask.json', { to: 'human', act: 'query', subject: 'first question', body: 'b', id: 'q1' });
  hive.routeOnce();
  write('god-1', 'ask.json', { to: 'human', act: 'query', subject: 'second question', body: 'b', id: 'q2' });
  hive.routeOnce();

  const ids = hive.voiceMessages({ agentId: 'god-1' }).map((m) => m.id).sort();
  assert.deepEqual(ids, ['q1', 'q2']);
  assert.equal(fs.readdirSync(path.join(agent('god-1'), 'outbox')).filter((f) => f.endsWith('.json')).length, 0);
});

test('the voice reader finds an archived message under a suffixed name', async (t) => {
  const { hive, write } = await floor(t);
  write('worker-1', 'r.json', { ...MESSAGE, id: 'first' });
  hive.routeOnce();
  write('worker-1', 'r.json', { ...MESSAGE, id: 'second' });
  hive.routeOnce();

  assert.equal(hive.voiceMessages({ agentId: 'worker-1', id: 'second' }).length, 1, 'read from the sending agent archive');
  assert.equal(hive.voiceMessages({ agentId: 'worker-1', id: 'first' }).length, 1, 'read from the sending agent archive');
});

/** The app's entry point cannot be loaded outside Electron, so this runs the real function's own text. */
function loadWorkerDoneAt(hiveRoot) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const file = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const fn = file.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'workerDoneAt');
  const js = ts.transpileModule(fn.getText(file), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const { existsSync, readdirSync, readFileSync, statSync } = fs;
  return new Function('hive', 'join', 'existsSync', 'readdirSync', 'readFileSync', 'statSync', `${js}; return workerDoneAt;`)(
    { root: () => hiveRoot }, path.join, existsSync, readdirSync, readFileSync, statSync
  );
}

test('the worker reader finds the newest done under a suffixed name', async (t) => {
  const { hive, agent, write } = await floor(t);
  const sentDir = path.join(agent('worker-1'), 'outbox', '.sent');
  write('worker-1', 'done.json', { to: 'god', act: 'done', subject: 'a', body: 'b' });
  hive.routeOnce();
  write('worker-1', 'done.json', { to: 'god', act: 'done', subject: 'a', body: 'c' });
  hive.routeOnce();
  // The reader goes by when each file was written.
  fs.utimesSync(path.join(sentDir, 'done.json'), 1_000, 1_000);
  fs.utimesSync(path.join(sentDir, '1-done.json'), 2_000, 2_000);

  const workerDoneAt = loadWorkerDoneAt(path.dirname(path.dirname(agent('worker-1'))));
  assert.equal(workerDoneAt('worker-1', 0), 2_000_000);
});

test('a directory at the archive name does not stop the file being archived', async (t) => {
  const { hive, agent, write, pending } = await floor(t);
  fs.mkdirSync(path.join(agent('worker-1'), 'outbox', '.sent', 'taken.json', 'x'), { recursive: true });
  write('worker-1', 'taken.json', MESSAGE);

  assert.equal(hive.routeOnce(), 1);

  assert.equal(pending('worker-1', 'taken.json'), false);
  assert.equal(hive.inbox('worker-1').length, 0);
});
