'use strict';

/**
 * registry() answers a failed read with an empty roster. ensureAgent then added its one agent to that and replaced the
 * file, so a transient bad read lost every other agent and god's id for good. send() read the same empty roster, could
 * deliver neither the message nor its refusal notice, and the body was gone. A failed read now refuses the write, and a
 * send waits for a pass that can read the registry.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { RegistryUnreadable } = loadTs('src/main/messageTarget.ts');

async function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-registry-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'One', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Two', provider: 'claude', cwd: home });
  const file = path.join(hive.root(), 'registry.json');
  const good = fs.readFileSync(file, 'utf8');
  return { hive, home, file, good, agents: path.join(hive.root(), 'agents'), repair: () => fs.writeFileSync(file, good) };
}

const BAD = {
  'not JSON': '{"agents":',
  'empty': '',
  'an array': '[]',
  'null': 'null',
  'a number': '7',
  'an object with no roster': '{}',
  'a roster that is null': '{"godId":"god-1","agents":null}',
  'a roster that is an array': '{"godId":"god-1","agents":[]}',
  'a roster that is text': '{"godId":"god-1","agents":"x"}'
};
const rows = (hive, kind) => hive.logTail(500).filter((e) => e.kind === kind);

for (const [label, content] of Object.entries(BAD)) {
  test(`with a registry that is ${label}, a new agent is refused and the file is left exactly as it was`, async (t) => {
    const f = await setup(t);
    fs.writeFileSync(f.file, content);

    await assert.rejects(
      f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home }),
      (e) => e instanceof RegistryUnreadable
    );

    assert.equal(fs.readFileSync(f.file, 'utf8'), content, 'the file was replaced');
    assert.equal(fs.existsSync(path.join(f.agents, 'worker-3')), false, 'no workspace either');
    assert.equal(rows(f.hive, 'registry-write-refused').length, 1);

    f.repair();
    await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
    assert.deepEqual(Object.keys(f.hive.registry().agents).sort(), ['god-1', 'worker-1', 'worker-2', 'worker-3'], 'every agent survived');
    assert.equal(f.hive.registry().godId, 'god-1');
  });
}

test('an existing agent is refused too: restoring one must not replace the roster with it alone', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  await assert.rejects(f.hive.ensureAgent({ id: 'worker-1', name: 'One', provider: 'claude', cwd: f.home }), RegistryUnreadable);
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{');
});

test('the refusal says what is wrong, and names no path', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  await assert.rejects(f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home }), (e) => {
    assert.match(e.message, /registry/i);
    assert.equal(e.message.includes(f.home), false);
    return true;
  });
});

test('a first agent on a new hive, with no file yet, still provisions', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-registry-guard-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  assert.equal(hive.registry().godId, 'god-1');
});

test('a valid empty roster is a roster: an agent can join it', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{"godId":null,"agents":{}}');
  await f.hive.ensureAgent({ id: 'worker-3', name: 'Three', provider: 'claude', cwd: f.home });
  assert.deepEqual(Object.keys(f.hive.registry().agents), ['worker-3']);
});

// These already stop at "agent not found" on a failed read. Pinned so that stays true.
for (const [label, write] of [
  ['setArchived', (h) => h.setArchived('worker-1', true)],
  ['patchAgentRole', (h) => h.patchAgentRole('worker-1', 'new role')],
  ['setAgentHold', (h) => h.setAgentHold('worker-1', true)],
  ['renameAgent', (h) => h.renameAgent('worker-1', 'New Name')],
  ['recordSession', (h) => h.recordSession('worker-1', 'session-1')]
]) {
  test(`${label} leaves a registry it cannot read exactly as it was`, async (t) => {
    const f = await setup(t);
    assert.equal(typeof f.hive[label], 'function', `no ${label} on the hive`);
    fs.writeFileSync(f.file, '{"agents":');
    write(f.hive);
    assert.equal(fs.readFileSync(f.file, 'utf8'), '{"agents":');
  });
}

// ---- send ----

const message = (to, body = 'the unique body') => ({ to, act: 'inform', subject: 'subject', body });
const everywhere = (f) => fs.readdirSync(f.agents).flatMap((id) => f.hive.inbox(id)).map((m) => m.body);

test('a send with an unreadable registry waits, and its body arrives once a pass can read it', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');

  const sent = f.hive.send(message('worker-2'), 'worker-1');

  assert.equal(sent.body, 'the unique body');
  assert.equal(f.hive.routeOnce(), 0, 'nothing to judge it by yet');
  f.repair();
  assert.deepEqual(everywhere(f), [], 'not delivered before a pass');
  f.hive.routeOnce();
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => [m.id, m.from, m.body]), [[sent.id, 'worker-1', 'the unique body']]);
  assert.equal(rows(f.hive, 'send-waiting').length, 1);
  f.hive.routeOnce();
  assert.equal(f.hive.inbox('worker-2').length, 1, 'delivered once');
});

test('the log says a send is waiting without holding its body', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  f.hive.send(message('worker-2', 'SECRET-BODY'), 'worker-1');
  const [row] = rows(f.hive, 'send-waiting');
  assert.equal(row.from, '"worker-1"');
  assert.equal(JSON.stringify(row).includes('SECRET-BODY'), false);
});

test('waiting sends go out in order', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  for (const n of [1, 2, 3]) f.hive.send({ ...message('worker-2', `body ${n}`), id: `m-${n}`, created_at: `2026-01-01T00:00:0${n}.000Z` }, 'worker-1');
  f.repair();
  const order = [];
  f.hive.setRoutedObserver((m) => order.push(m.id));
  f.hive.routeOnce();
  assert.deepEqual(order, ['m-1', 'm-2', 'm-3']);
});

test('a waiting send to a target that turns out unknown still reaches its sender as a notice, with the body', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  f.hive.send(message('nobody'), 'worker-1');
  f.repair();
  f.hive.routeOnce();
  const [notice] = f.hive.inbox('worker-1');
  assert.match(notice.subject, /not delivered/);
  assert.match(notice.body, /the unique body/);
});

test('a send from an app sender, which has no folder, also survives', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  f.hive.send(message('god'), 'scheduler');
  f.repair();
  f.hive.routeOnce();
  assert.deepEqual(f.hive.inbox('god-1').map((m) => [m.from, m.body]), [['scheduler', 'the unique body']]);
});

test('a waiting send cannot be injected: nothing is read from disk to deliver it', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  f.hive.send(message('worker-2'), 'worker-1');
  const before = fs.readdirSync(f.hive.root()).sort();
  f.repair();
  assert.deepEqual(fs.readdirSync(f.hive.root()).sort(), before);
  assert.equal(fs.readdirSync(f.hive.root()).some((n) => /wait|pending|spool/i.test(n)), false, 'a folder here is writable by agents, who could then forge a sender');
});

test('a waiting send that throws stays waiting, and does not hold up other mail or the next pass', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  f.hive.send({ ...message('worker-2', 'held body'), id: 'held-1' }, 'worker-1');
  f.hive.send({ ...message('worker-2', 'second held body'), id: 'held-2' }, 'worker-1');
  f.repair();
  fs.writeFileSync(path.join(f.agents, 'worker-1', 'outbox', 'x.json'), JSON.stringify(message('worker-2', 'outbox body')));
  const route = f.hive.routeMessage;
  let failures = 1;
  f.hive.routeMessage = function (msg) {
    if (msg.id === 'held-1' && failures-- > 0) throw new Error('disk full');
    return route.call(this, msg);
  };

  assert.equal(f.hive.routeOnce(), 1, 'outbox mail is not held up');

  assert.deepEqual(f.hive.inbox('worker-2').map((m) => m.body), ['outbox body']);
  assert.deepEqual(rows(f.hive, 'send-failed').map((r) => r.id), ['held-1']);
  f.hive.routeOnce();
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => m.body).sort(), ['held body', 'outbox body', 'second held body'], 'nothing lost, nothing repeated');
});

test('past its limit a send fails visibly rather than growing forever or vanishing', async (t) => {
  const f = await setup(t);
  fs.writeFileSync(f.file, '{');
  const LIMIT = 1000;
  for (let n = 0; n < LIMIT; n++) f.hive.send(message('worker-2', `body ${n}`), 'worker-1');
  assert.throws(() => f.hive.send(message('worker-2', 'one too many'), 'worker-1'), RegistryUnreadable);
  assert.equal(rows(f.hive, 'send-refused').length, 1);
  f.repair();
  f.hive.routeOnce();
  assert.equal(f.hive.inbox('worker-2').length, LIMIT, 'none of the waiting ones were lost');
});

test('with a readable registry a send goes straight out, as ever', async (t) => {
  const f = await setup(t);
  f.hive.send(message('worker-2'), 'worker-1');
  assert.deepEqual(f.hive.inbox('worker-2').map((m) => m.body), ['the unique body']);
  assert.deepEqual(rows(f.hive, 'send-waiting'), []);
});

test('a hive with no home still takes a send without throwing', () => {
  const hive = new HiveManager(() => null);
  // Nothing can ever release a send here, so nothing may be held: the limit would make the next one throw.
  for (let n = 0; n < 1001; n++) assert.doesNotThrow(() => hive.send(message('worker-2'), 'worker-1'));
});
