'use strict';

/**
 * A message's "to" is written by an agent, and an agent id becomes a folder name.
 * Only a roster id or a known name may go on to route; nothing else gets a path
 * built from it, and the sender is told.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { isKnownTarget, isRosterId } = loadTs('src/main/messageTarget.ts');

async function floor(t, emit) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-message-target-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home, emit);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'worker-2', name: 'Other', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  const write = (file, to) => fs.writeFileSync(
    path.join(agents, 'worker-1', 'outbox', file),
    JSON.stringify({ to, act: 'inform', subject: 's', body: 'b' })
  );
  const sent = (file) => fs.existsSync(path.join(agents, 'worker-1', 'outbox', '.sent', file));
  return { hive, home, agents, write, sent };
}

/** Every file under `dir` outside the sender's outbox and the log, so a stray write shows up. */
function files(dir) {
  return fs.readdirSync(dir, { recursive: true }).map(String)
    .filter((f) => !f.endsWith('log.jsonl') && !f.split(path.sep).includes('.git') && !f.split(path.sep).includes('outbox') && !f.split(path.sep).includes('.claims'))
    .sort();
}

const REFUSED = {
  'parent traversal': '../../outside',
  'one step up': '../worker-2',
  'traversal back to a roster id': 'worker-1/../worker-2',
  'a separator': 'worker-2/inbox',
  'a backslash': '..\\worker-2',
  'an absolute path': '/tmp/outside',
  'a Windows absolute path': 'C:\\outside',
  'an empty string': '',
  'a space': ' ',
  'an unknown id': 'nobody',
  'a NUL byte': 'worker-2\u0000',
  'an oversize value': 'x'.repeat(5000),
  'an inherited property': '__proto__',
  'another inherited property': 'constructor'
};

for (const [label, to] of Object.entries(REFUSED)) {
  test(`refused, with a notice and nothing written for it: ${label}`, async (t) => {
    const { hive, home, write, sent } = await floor(t);
    const before = files(home);

    assert.equal((write('m.json', to), hive.routeOnce()), 0);

    assert.equal(sent('m.json'), false, 'not filed as sent');
    assert.equal(sent('bad-m.json'), true, 'set aside');
    const notices = hive.inbox('worker-1');
    assert.equal(notices.length, 1);
    assert.match(notices[0].subject, /not delivered/i);
    assert.match(notices[0].body, /recipient/);
    assert.match(notices[0].body, /roster/);
    assert.deepEqual(hive.inbox('god-1'), [], 'it does not reach god either');
    assert.deepEqual(hive.inbox('worker-2'), []);
    const added = files(home).filter((f) => !before.includes(f));
    assert.equal(added.length, 1, `only the notice: ${added}`);
    assert.ok(added[0].includes(path.join('worker-1', 'inbox')));
    assert.ok(hive.logTail(50).some((r) => r.kind === 'drop' && r.reason === 'unknown-recipient'));
  });
}

test('a folder outside the agents folder is never written into', async (t) => {
  const { hive, home, write } = await floor(t);
  const outside = path.join(home, 'outside', 'inbox');
  fs.mkdirSync(outside, { recursive: true });

  write('m.json', '../../outside');
  hive.routeOnce();

  assert.deepEqual(fs.readdirSync(outside), []);
});

test('an agent folder with no roster entry is not delivered to', async (t) => {
  const { hive, agents, write, sent } = await floor(t);
  fs.mkdirSync(path.join(agents, 'stray', 'inbox'), { recursive: true });

  write('m.json', 'stray');
  hive.routeOnce();

  assert.deepEqual(fs.readdirSync(path.join(agents, 'stray', 'inbox')), []);
  assert.equal(sent('bad-m.json'), true);
});

test('a target that is not text is refused', async (t) => {
  const { hive, write, sent } = await floor(t);
  write('m.json', 42);
  hive.routeOnce();
  assert.equal(sent('bad-m.json'), true);
  assert.equal(hive.inbox('worker-1').length, 1);
});

test('the log holds a shortened target, and the notice a shortened one too', async (t) => {
  const { hive, write } = await floor(t);
  write('m.json', 'x'.repeat(5000));
  hive.routeOnce();
  const row = hive.logTail(50).find((r) => r.reason === 'unknown-recipient');
  assert.ok(String(row.to).length <= 80);
  assert.ok(hive.inbox('worker-1')[0].body.length < 500);
});

test('a roster id in the wrong case reaches that agent', async (t) => {
  const { hive, write } = await floor(t);
  write('m.json', 'WORKER-2');
  assert.equal(hive.routeOnce(), 1);
  assert.equal(hive.inbox('worker-2').length, 1);
});

test('a roster id is delivered', async (t) => {
  const { hive, write, sent } = await floor(t);
  write('m.json', 'worker-2');
  assert.equal(hive.routeOnce(), 1);
  assert.equal(sent('m.json'), true);
  assert.equal(hive.inbox('worker-2').length, 1);
});

for (const alias of ['god', 'human']) {
  test(`the name ${alias} reaches god`, async (t) => {
    const { hive, write, sent } = await floor(t);
    write('m.json', alias);
    assert.equal(hive.routeOnce(), 1);
    assert.equal(sent('m.json'), true);
    assert.equal(hive.inbox('god-1').length, 1);
    assert.equal(hive.inbox('worker-1').length, 0);
  });
}

test('broadcast reaches the roster', async (t) => {
  const { hive, write, sent } = await floor(t);
  write('m.json', 'broadcast');
  assert.equal(hive.routeOnce(), 1);
  assert.equal(sent('m.json'), true);
  assert.equal(hive.inbox('worker-2').length, 1);
});

for (const sender of ['heartbeat', 'scheduler', 'breaker', 'system', 'router', 'ephemeral-worker', 'webhook']) {
  test(`a reply to the app's own sender ${sender} surfaces to god without an inbox being made`, async (t) => {
    const { hive, agents, write, sent } = await floor(t);
    write('m.json', sender);

    assert.equal(hive.routeOnce(), 1);

    assert.equal(sent('m.json'), true);
    assert.equal(hive.inbox('worker-1').length, 0);
    assert.equal(hive.inbox('god-1').length, 1);
    assert.equal(fs.existsSync(path.join(agents, sender)), false);
  });
}

test('an app-sent message to an unknown id tells god, with its content, when the sender has no inbox', async (t) => {
  const { hive } = await floor(t);

  hive.send({ to: 'gone-1', act: 'request', subject: 'mission', body: 'do the thing' }, 'scheduler');

  const [notice] = hive.inbox('god-1');
  assert.match(notice.subject, /not delivered/i);
  assert.match(notice.body, /gone-1/);
  assert.match(notice.subject, /mission/);
  assert.match(notice.body, /do the thing/);
});

test('an agent-sent message through send() to an unknown id tells that agent', async (t) => {
  const { hive } = await floor(t);

  hive.send({ to: '../../x', act: 'request', subject: 'mission', body: 'do it' }, 'worker-1');

  assert.equal(hive.inbox('worker-1').length, 1);
  assert.equal(hive.inbox('god-1').length, 0);
});

test('the validators reject what they should directly', () => {
  const agents = { a: {} };
  assert.equal(isRosterId(agents, 'a'), true);
  assert.equal(isRosterId(agents, 'god'), false);
  assert.equal(isRosterId(agents, '__proto__'), false);
  assert.equal(isRosterId(agents, 7), false);
  assert.equal(isKnownTarget(agents, 'a'), true);
  assert.equal(isKnownTarget(agents, 'god'), true);
  assert.equal(isKnownTarget(agents, 'human'), true);
  assert.equal(isKnownTarget(agents, 'broadcast'), true);
  assert.equal(isKnownTarget(agents, 'toString'), false);
  assert.equal(isKnownTarget(agents, undefined), false);
});

test('a roster id in another alphabet is delivered', async (t) => {
  const { hive, home, write, sent } = await floor(t);
  await hive.ensureAgent({ id: '\u5c0f\u5e2e-1', name: 'x', provider: 'claude', cwd: home });
  write('m.json', '\u5c0f\u5e2e-1');

  assert.equal(hive.routeOnce(), 1);

  assert.equal(sent('m.json'), true);
  assert.equal(hive.inbox('\u5c0f\u5e2e-1').length, 1);
});

test('a roster entry whose id is not a plain folder name is not delivered to', async (t) => {
  const { hive, home, write } = await floor(t);
  const outside = path.join(home, 'outside', 'inbox');
  fs.mkdirSync(outside, { recursive: true });
  const file = path.join(hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.agents['../../outside'] = { id: '../../outside', name: 'x', provider: 'claude', cwd: '.' };
  fs.writeFileSync(file, JSON.stringify(reg));

  write('m.json', '../../outside');
  hive.routeOnce();

  assert.deepEqual(fs.readdirSync(outside), []);
});

test('a folder named after one of the app senders is not delivered to', async (t) => {
  const { hive, agents, write } = await floor(t);
  const inbox = path.join(agents, 'heartbeat', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });

  write('m.json', 'heartbeat');
  hive.routeOnce();

  assert.deepEqual(fs.readdirSync(inbox), []);
  assert.equal(hive.inbox('god-1').length, 1, 'it surfaces to god instead');
});

test('a god id on disk that is a path is not delivered to', async (t) => {
  const { hive, home, write } = await floor(t);
  const outside = path.join(home, 'outside', 'inbox');
  fs.mkdirSync(outside, { recursive: true });
  const file = path.join(hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.godId = '../../outside';
  reg.agents['../../outside'] = { id: '../../outside', name: 'x', provider: 'claude', cwd: '.', isGod: true };
  fs.writeFileSync(file, JSON.stringify(reg));

  write('m.json', 'god');
  hive.routeOnce();

  assert.deepEqual(fs.readdirSync(outside), []);
});

for (const id of ['heartbeat', 'HEARTBEAT', 'Scheduler', 'system', 'router', 'ephemeral-worker', 'webhook', 'breaker', 'broadcast', 'human']) {
  test(`an agent cannot be provisioned under the reserved name ${id}`, async (t) => {
    const { hive, agents, home } = await floor(t);
    await assert.rejects(hive.ensureAgent({ id, name: 'x', provider: 'claude', cwd: home }), /reserved/);
    assert.equal(fs.existsSync(path.join(agents, id)), false);
    assert.equal(Object.keys(hive.registry().agents).includes(id), false);
  });
}

const COLLIDING = {
  'another case': ['Agent', 'agent'],
  'a non-ASCII letter in another case': ['Ägent', 'ägent'],
  'composed and decomposed forms': ['café', 'café'],
  'a sharp s': ['straße', 'STRASSE']
};

for (const [label, [first, second]] of Object.entries(COLLIDING)) {
  test(`a new id colliding through ${label} is refused, with no folder or roster entry`, async (t) => {
    const { hive, agents, home } = await floor(t);
    await hive.ensureAgent({ id: first, name: 'x', provider: 'claude', cwd: home });
    const before = fs.readdirSync(agents).sort();

    await assert.rejects(hive.ensureAgent({ id: second, name: 'y', provider: 'claude', cwd: home }), /already/);

    assert.deepEqual(fs.readdirSync(agents).sort(), before);
    assert.equal(Object.keys(hive.registry().agents).includes(second), false);
  });

  test(`mail to a spelling differing by ${label} reaches that one agent`, async (t) => {
    const { hive, home, agents } = await floor(t);
    await hive.ensureAgent({ id: first, name: 'x', provider: 'claude', cwd: home });
    fs.writeFileSync(path.join(agents, 'worker-1', 'outbox', 'm.json'), JSON.stringify({ to: second, act: 'inform', subject: 's', body: 'b' }));

    assert.equal(hive.routeOnce(), 1);

    assert.equal(hive.inbox(first).length, 1);
    assert.equal(hive.logTail(50).some((r) => r.kind === 'message' && r.delivered?.[0] === first), true);
  });
}

test('provisioning an existing agent again is allowed', async (t) => {
  const { hive, home } = await floor(t);
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  assert.equal(hive.registry().agents['worker-1'].name, 'Helper');
});

for (const id of ['a.', 'a ', 'CON', 'nul', 'com1.txt', 'a/b', '..', '', 'x'.repeat(201)]) {
  test(`an agent cannot be provisioned under the unsafe folder name ${JSON.stringify(id.slice(0, 12))}`, async (t) => {
    const { hive, home } = await floor(t);
    await assert.rejects(hive.ensureAgent({ id, name: 'x', provider: 'claude', cwd: home }), /folder name/);
  });
}

function addRosterEntry(hive, id, extra = {}) {
  const file = path.join(hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.agents[id] = { id, name: 'x', provider: 'claude', cwd: '.', ...extra };
  fs.writeFileSync(file, JSON.stringify(reg));
}

test('a roster entry named after an app sender does not capture replies to it', async (t) => {
  const { hive, agents, write } = await floor(t);
  addRosterEntry(hive, 'heartbeat');
  const inbox = path.join(agents, 'heartbeat', 'inbox');
  fs.mkdirSync(path.join(inbox, '.done'), { recursive: true });

  write('m.json', 'heartbeat');
  assert.equal(hive.routeOnce(), 1);

  assert.deepEqual(fs.readdirSync(inbox).filter((f) => f.endsWith('.json')), []);
  assert.equal(hive.inbox('god-1').length, 1, 'the name means the app, so it surfaces to god');
});

test('a reply to an app sender in another case surfaces the same way', async (t) => {
  const { hive, write, sent } = await floor(t);
  write('m.json', 'HeartBeat');
  assert.equal(hive.routeOnce(), 1);
  assert.equal(sent('m.json'), true);
  assert.equal(hive.inbox('god-1').length, 1);
});

test('a broadcast skips a roster entry named after an app sender', async (t) => {
  const { hive, agents, write } = await floor(t);
  addRosterEntry(hive, 'scheduler');
  const inbox = path.join(agents, 'scheduler', 'inbox');
  fs.mkdirSync(inbox, { recursive: true });

  write('m.json', 'broadcast');
  hive.routeOnce();

  assert.deepEqual(fs.readdirSync(inbox), []);
});

test('two roster spellings of one folder: the one with no exact folder entry is not delivered to', async (t) => {
  const { hive, home, agents, write } = await floor(t);
  await hive.ensureAgent({ id: 'Agent', name: 'x', provider: 'claude', cwd: home });
  addRosterEntry(hive, 'agent');

  write('m.json', 'agent');
  hive.routeOnce();

  assert.equal(fs.readdirSync(agents).includes('agent'), false);
  assert.deepEqual(fs.readdirSync(path.join(agents, 'Agent', 'inbox')).filter((f) => f.endsWith('.json')), [], 'the other agent gets none of it');
  assert.equal(hive.inbox('god-1').length, 1, 'it surfaces to god');
});

test('an inexact spelling matching two roster entries is refused', async (t) => {
  const { hive, home, agents, write, sent } = await floor(t);
  await hive.ensureAgent({ id: 'Agent', name: 'x', provider: 'claude', cwd: home });
  addRosterEntry(hive, 'agent');

  write('m.json', 'AGENT');
  hive.routeOnce();

  assert.equal(sent('bad-m.json'), true);
  assert.deepEqual(fs.readdirSync(path.join(agents, 'Agent', 'inbox')).filter((f) => f.endsWith('.json')), []);
});

// The terminal handoff hands the whole message to a renderer before the inbox sink
// is ever reached, so a check only at the inbox leaves that channel open.
function handoffs() {
  const sent = [];
  const emit = (channel, payload) => {
    if (channel === 'hive:terminalHandoff') sent.push(payload);
    return true;
  };
  return { sent, emit };
}

for (const [label, id, extra, to] of [
  ['a hookless entry', 'heartbeat', { provider: 'custom' }, 'heartbeat'],
  ['a proxy-tier entry', 'scheduler', { provider: 'qwen' }, 'scheduler'],
  ['an archived entry', 'breaker', { provider: 'custom', archived: true }, 'breaker'],
  ['an assistant entry', 'router', { provider: 'custom', isAssistant: true }, 'router'],
  ['an entry in another case, named exactly', 'HEARTBEAT', { provider: 'custom' }, 'HEARTBEAT'],
  ['an entry in another case, named differently', 'HEARTBEAT', { provider: 'custom' }, 'heartbeat']
]) {
  test(`a reply to an app sender surfaces to god and reaches no channel of ${label}`, async (t) => {
    const { sent, emit } = handoffs();
    const { hive, agents, write } = await floor(t, emit);
    addRosterEntry(hive, id, extra);
    const inbox = path.join(agents, id, 'inbox');
    fs.mkdirSync(path.join(inbox, '.done'), { recursive: true });

    write('m.json', to);
    assert.equal(hive.routeOnce(), 1);

    assert.deepEqual(sent, [], 'the whole message went to a terminal under the app\'s name');
    assert.deepEqual(fs.readdirSync(inbox).filter((f) => f.endsWith('.json')), []);
    const mail = hive.inbox('god-1');
    assert.equal(mail.length, 1, 'the name means the app, so it surfaces to god');
    assert.equal(mail[0].body, 'b', 'with its content, which nobody else now has');
  });
}

test('a reply to an app sender with no roster entry is not counted as handed to a terminal', async (t) => {
  const { sent, emit } = handoffs();
  const { hive, write } = await floor(t, emit);
  write('m.json', 'webhook');
  assert.equal(hive.routeOnce(), 1);
  assert.deepEqual(sent, []);
  assert.equal(hive.inbox('god-1').length, 1);
});

test('a broadcast hands nothing to a hookless entry named after an app sender, and still reaches a real one', async (t) => {
  const { sent, emit } = handoffs();
  const { hive, write } = await floor(t, emit);
  addRosterEntry(hive, 'scheduler', { provider: 'custom' });
  addRosterEntry(hive, 'real-hookless', { provider: 'custom' });
  write('m.json', 'broadcast');
  hive.routeOnce();
  assert.deepEqual(sent.map((m) => m.to), ['real-hookless']);
  assert.equal(hive.inbox('god-1').filter((m) => m.subject.includes('scheduler')).length, 0, 'a skip, not a bounce per broadcast');
});

test('a hookless agent with an ordinary name still gets its terminal handoff', async (t) => {
  const { sent, emit } = handoffs();
  const { hive, write } = await floor(t, emit);
  addRosterEntry(hive, 'real-hookless', { provider: 'custom' });
  write('m.json', 'real-hookless');
  assert.equal(hive.routeOnce(), 1);
  assert.deepEqual(sent.map((m) => m.to), ['real-hookless']);
  assert.deepEqual(hive.inbox('god-1'), []);
});
