'use strict';

/**
 * Ids from IPC and voice callers reach the agent folder lookups. Only an agent on
 * the roster with that exact folder gets a path built; the app's IPC handlers show
 * a typed refusal for anything else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { AgentIdError } = loadTs('src/main/messageTarget.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-caller-ids-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  const agents = path.join(home, 'hive', 'agents');
  fs.appendFileSync(path.join(agents, 'worker-1', 'memory.md'), `\nWORKER-NOTE ${'a real note about the work. '.repeat(12)}\n`);
  hive.send({ id: 'to-worker', to: 'worker-1', act: 'inform', subject: 's', body: 'for worker' }, 'god-1');
  hive.send({ id: 'to-god', to: 'god-1', act: 'inform', subject: 's', body: 'for god' }, 'worker-1');
  // Something a traversal would find, if a path were ever built from one.
  const outside = path.join(home, 'outside');
  fs.mkdirSync(path.join(outside, 'inbox'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'outbox'), { recursive: true });
  const stolen = JSON.stringify({ id: 'stolen', body: 'SECRET', from: 'x', to: 'y', act: 'inform', subject: 's' });
  fs.writeFileSync(path.join(outside, 'memory.md'), 'SECRET'.repeat(50));
  fs.writeFileSync(path.join(outside, 'inbox', 'stolen.json'), stolen);
  fs.writeFileSync(path.join(outside, 'outbox', 'stolen.json'), stolen);
  fs.mkdirSync(path.join(agents, 'stray', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(agents, 'stray', 'inbox', 'stolen.json'), stolen);
  fs.writeFileSync(path.join(agents, 'stray', 'memory.md'), 'SECRET'.repeat(50));
  return { hive, home, agents };
}

const REFUSED = {
  traversal: ['../../outside', 'invalid'],
  'one step up': ['../stray', 'invalid'],
  'a separator': ['worker-1/inbox', 'invalid'],
  'an absolute path': ['/etc', 'invalid'],
  'a Windows path': ['C:\\x', 'invalid'],
  empty: ['', 'invalid'],
  'a NUL byte': ['worker-1\u0000', 'invalid'],
  oversize: ['x'.repeat(5000), 'invalid'],
  'not text': [42, 'invalid'],
  unknown: ['nobody', 'unknown'],
  'a folder not on the roster': ['stray', 'unknown'],
  'an inherited name': ['__proto__', 'unknown'],
  'an app sender': ['heartbeat', 'reserved'],
  'an app sender in another case': ['HeartBeat', 'reserved'],
  broadcast: ['broadcast', 'reserved']
};

for (const [label, [id, code]] of Object.entries(REFUSED)) {
  test(`checkAgentId refuses ${label} with a typed error`, async (t) => {
    const { hive } = await floor(t);
    assert.throws(() => hive.checkAgentId(id), (e) => e instanceof AgentIdError && e.code === code && e.message.includes(code));
  });

  test(`${label} reads nothing through memory, hasMemory, inbox, outbox, backlog or voice`, async (t) => {
    const { hive } = await floor(t);
    assert.equal(hive.memory(id), '');
    assert.equal(hive.hasMemory(id), false);
    assert.deepEqual(hive.inbox(id), []);
    assert.deepEqual(hive.outbox(id), []);
    assert.equal(hive.inboxBacklog(id), 0);
    assert.deepEqual(hive.voiceMessages({ agentId: id }), typeof id === 'string' && id !== '' ? [] : hive.voiceMessages({}));
  });
}

test('a roster id with no folder is refused as having none', async (t) => {
  const { hive } = await floor(t);
  const file = path.join(hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.agents.gone = { id: 'gone', name: 'x', provider: 'claude', cwd: '.' };
  fs.writeFileSync(file, JSON.stringify(reg));

  assert.throws(() => hive.checkAgentId('gone'), (e) => e.code === 'no-folder');
  assert.equal(hive.memory('gone'), '');
});

test('a refused id in a voice lookup also fails at the check the handler runs', async (t) => {
  const { hive } = await floor(t);
  assert.throws(() => hive.checkAgentId('../../outside'), AgentIdError);
  assert.deepEqual(hive.voiceMessages({ agentId: '../../outside', includeArchived: true }), []);
});

for (const [label, id, canonical] of [
  ['a roster id', 'worker-1', 'worker-1'],
  ['a case variant', 'WORKER-1', 'worker-1'],
  ['the name god', 'god', 'god-1'],
  ['the name human', 'human', 'god-1']
]) {
  test(`${label} resolves and reads that agent`, async (t) => {
    const { hive } = await floor(t);
    assert.equal(hive.checkAgentId(id), canonical);
    const wanted = canonical === 'worker-1' ? 'for worker' : 'for god';
    assert.equal(hive.inbox(id)[0].body, wanted);
    assert.equal(hive.inboxBacklog(id), 1);
    assert.equal(hive.voiceMessages({ agentId: id }).some((m) => m.body === wanted), true);
  });
}

test('a case variant reads that agent\'s memory', async (t) => {
  const { hive } = await floor(t);
  assert.match(hive.memory('WORKER-1'), /WORKER-NOTE/);
  assert.equal(hive.hasMemory('WORKER-1'), true);
});

test('a voice lookup with no agent still lists everyone', async (t) => {
  const { hive } = await floor(t);
  const bodies = hive.voiceMessages({}).map((m) => m.body);
  assert.ok(bodies.includes('for worker'));
  assert.ok(bodies.includes('for god'));
});

test('the app handlers check caller ids before reading', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  assert.match(source, /'hive:memory', \(_evt, id: unknown\) => hive\.memory\(hive\.checkAgentId\(id\)\)/);
  assert.match(source, /'hive:inbox', \(_evt, id: unknown\) => hive\.inbox\(hive\.checkAgentId\(id\)\)/);
  assert.match(source, /'hive:messages', \(_evt, opts: unknown\) =>\s*hive\.voiceMessages\(hive\.checkedVoiceOptions\(opts\)\)/);
});

test('the voice options check refuses a bad agent and passes the rest through', async (t) => {
  const { hive } = await floor(t);
  assert.throws(() => hive.checkedVoiceOptions({ agentId: '../../outside' }), AgentIdError);
  assert.deepEqual(hive.checkedVoiceOptions({ agentId: 'WORKER-1', limit: 3 }), { agentId: 'worker-1', limit: 3 });
  assert.deepEqual(hive.checkedVoiceOptions({ limit: 3 }), { limit: 3 });
  assert.deepEqual(hive.checkedVoiceOptions(null), {});
});

test('settling a refused id moves nothing outside the roster', async (t) => {
  const { hive, home } = await floor(t);
  assert.equal(hive.settleInbox('../../outside').moved, 0);
  assert.equal(fs.existsSync(path.join(home, 'outside', 'inbox', 'stolen.json')), true);
  assert.equal(fs.existsSync(path.join(home, 'outside', 'inbox', '.done')), false);
});

test('settling a roster id in another case files that agent\'s mail', async (t) => {
  const { hive } = await floor(t);
  assert.equal(hive.settleInbox('WORKER-1').moved, 1);
  assert.deepEqual(hive.inbox('worker-1'), []);
});

test('the stop drain reads nothing for a refused id, and still works for a roster id', async (t) => {
  const { hive } = await floor(t);
  const before = fs.readFileSync(path.join(hive.root(), 'agents', 'worker-1', 'inbox', 'to-worker.json'), 'utf8');
  const outside = path.join(path.dirname(hive.root()), 'outside');
  const inOutside = () => fs.readdirSync(outside, { recursive: true }).map(String).sort();
  const untouched = inOutside();
  assert.deepEqual(hive.drainForStop('../../outside'), { block: false });
  assert.deepEqual(inOutside(), untouched, 'no cursor is written there');
  assert.equal(typeof hive.drainForStop('worker-1').block, 'boolean');
  assert.equal(fs.readFileSync(path.join(hive.root(), 'agents', 'worker-1', 'inbox', 'to-worker.json'), 'utf8'), before);
});
