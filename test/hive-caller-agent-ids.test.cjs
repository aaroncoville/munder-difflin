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
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const { AgentIdError, shortTarget } = loadTs('src/main/messageTarget.ts');

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-caller-ids-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
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

// ---- the real IPC handlers, taken from index.ts, against a real HiveManager ----

function liveHandlers(hive) {
  const source = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/index.ts'), 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
  const handlers = {};
  for (const channel of ['hive:memory', 'hive:inbox', 'hive:messages', 'hive:patchAgentRole']) {
    const node = ast.statements.find((n) => ts.isExpressionStatement(n) && n.getText(ast).startsWith(`ipcMain.handle('${channel}'`));
    assert.ok(node, `${channel} is registered at the top level of index.ts`);
    const js = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(js, { hive, ipcMain: { handle: (name, fn) => { handlers[name] = fn; } } });
  }
  // What the renderer receives from a handler that throws.
  const invoke = async (channel, ...args) => {
    try {
      return { value: await handlers[channel]({}, ...args) };
    } catch (e) {
      return { thrown: e, wire: `Error invoking remote method '${channel}': ${e}` };
    }
  };
  return invoke;
}

for (const [label, id, code] of [
  ['a traversal', '../../outside', 'invalid'],
  ['an absolute path', '/etc', 'invalid'],
  ['a value that is not text', 7, 'invalid'],
  ['an unknown id', 'nobody', 'unknown'],
  ['one of the app\'s names', 'heartbeat', 'reserved'],
  ['a folder not on the roster', 'stray', 'unknown']
]) {
  for (const [channel, args] of [['hive:memory', [id]], ['hive:inbox', [id]], ['hive:messages', [{ agentId: id }]]]) {
    test(`${channel} refuses ${label}, and only the code and the short id cross to the renderer`, async (t) => {
      const { hive, home } = await floor(t);
      const { thrown, wire, value } = await liveHandlers(hive)(channel, ...args);
      assert.equal(value, undefined, 'it answered instead of refusing');
      assert.equal(thrown.name, 'AgentIdError');
      assert.equal(thrown.code, code);
      assert.equal(wire, `Error invoking remote method '${channel}': AgentIdError: Agent id ${shortTarget(id)} refused (${code})`, 'nothing else may cross');
      assert.equal(wire.includes(home), false, `a path crossed to the renderer: ${wire}`);
      assert.equal(wire.includes('SECRET'), false);
    });
  }
}

test('the handlers answer for a real agent', async (t) => {
  const { hive } = await floor(t);
  const invoke = liveHandlers(hive);
  assert.match((await invoke('hive:memory', 'worker-1')).value, /WORKER-NOTE/);
  assert.deepEqual((await invoke('hive:inbox', 'WORKER-1')).value.map((m) => m.id), ['to-worker']);
  assert.ok((await invoke('hive:messages', { agentId: 'worker-1' })).value.some((m) => m.body === 'for worker'));
});

function addRosterEntry(hive, id) {
  const file = path.join(hive.root(), 'registry.json');
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  reg.agents[id] = { id, name: 'Legacy', provider: 'claude', cwd: '.', role: 'old' };
  fs.writeFileSync(file, JSON.stringify(reg));
}

// A malformed or imported registry is exactly what these checks must survive.
for (const via of ['the handler', 'the method']) {
  test(`a role edit through ${via} cannot write outside the agents folder through a registry key`, async (t) => {
    const { hive, home } = await floor(t);
    addRosterEntry(hive, '../../outside');
    const identity = path.join(home, 'outside', 'identity.md');
    fs.writeFileSync(identity, 'SENTINEL');
    const before = fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8');

    const result = via === 'the handler'
      ? (await liveHandlers(hive)('hive:patchAgentRole', '../../outside', 'attacker-role')).value
      : hive.patchAgentRole('../../outside', 'attacker-role');

    assert.equal(fs.readFileSync(identity, 'utf8'), 'SENTINEL', 'the write left the agents folder');
    assert.equal(result.ok, false);
    assert.match(result.error, /refused \(invalid\)/);
    assert.equal(result.error.includes(home), false);
    assert.equal(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8'), before, 'nothing half-applied');
  });
}

test('a role edit refuses a roster entry whose exact folder is missing, leaving the roster as it was', async (t) => {
  const { hive } = await floor(t);
  addRosterEntry(hive, 'no-folder-agent');
  const result = hive.patchAgentRole('no-folder-agent', 'new');
  assert.equal(result.ok, false);
  assert.match(result.error, /refused \(no-folder\)/);
  assert.equal(hive.registry().agents['no-folder-agent'].role, 'old');
});

test('a role edit in another case changes the real agent and adds no second key', async (t) => {
  const { hive, agents } = await floor(t);
  const keys = Object.keys(hive.registry().agents);
  assert.deepEqual(await liveHandlers(hive)('hive:patchAgentRole', 'WORKER-1', 'new role').then((r) => ({ ...r.value })), { ok: true });
  assert.equal(hive.registry().agents['worker-1'].role, 'new role');
  assert.deepEqual(Object.keys(hive.registry().agents), keys);
  assert.match(fs.readFileSync(path.join(agents, 'worker-1', 'identity.md'), 'utf8'), /new role/);
});

// A disk that ignores case would hide a write through the wrong spelling, so this
// uses two names that fold together but stay separate folders.
test('a role edit by a near spelling writes the real agent\'s folder, not a folder from that spelling', async (t) => {
  const { hive, agents, home } = await floor(t);
  await hive.ensureAgent({ id: 'i', name: 'I', provider: 'claude', cwd: home });
  assert.deepEqual({ ...hive.patchAgentRole('\u0131', 'new role') }, { ok: true });
  assert.match(fs.readFileSync(path.join(agents, 'i', 'identity.md'), 'utf8'), /new role/);
  assert.equal(fs.readdirSync(agents).includes('\u0131'), false);
});

// ---- a voice read with no agent named ----

function strayMessage(agents, folder, id, body) {
  fs.mkdirSync(path.join(agents, folder, 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(agents, folder, 'inbox', `${id}.json`), JSON.stringify({ id, body, from: 'x', to: 'y', act: 'inform', subject: 's' }));
}

test('a voice read naming no agent does not show a folder that has no roster entry', async (t) => {
  const { hive, agents } = await floor(t);
  strayMessage(agents, 'stray', 'stray-msg', 'PRIVATE STRAY BODY');
  const invoke = liveHandlers(hive);
  for (const opts of [{}, { limit: 40 }, { id: 'stray-msg' }, { id: 'stray-msg', includeArchived: false }]) {
    const { value } = await invoke('hive:messages', opts);
    assert.deepEqual(value.filter((m) => m.body === 'PRIVATE STRAY BODY'), [], `visible through ${JSON.stringify(opts)}`);
    assert.deepEqual(value.filter((m) => m.owner === 'stray'), []);
  }
  assert.deepEqual((await invoke('hive:messages', { id: 'stolen' })).value, [], 'the folder from setup is hidden too');
});

test('a folder a voice read skips is logged once, not on every read, and a dot folder not at all', async (t) => {
  const { hive, agents } = await floor(t);
  fs.mkdirSync(path.join(agents, '.hidden'));
  hive.voiceMessages();
  hive.voiceMessages({ limit: 1 });
  const rows = hive.logTail(500).filter((r) => r.kind === 'voice-folder-skipped');
  assert.deepEqual(rows.map((r) => r.folder), ['"stray"']);
});

test('a stale folder folding onto a live id stays hidden while that agent stays visible', async (t) => {
  const { hive, agents, home } = await floor(t);
  await hive.ensureAgent({ id: 'i', name: 'I', provider: 'claude', cwd: home });
  const stale = 'ı';
  strayMessage(agents, stale, 'stale-msg', 'STALE BODY');
  strayMessage(agents, 'i', 'real-msg', 'REAL BODY');
  if (!fs.readdirSync(agents).includes(stale) || !fs.readdirSync(agents).includes('i')) t.skip('this disk merges the two names');
  const bodies = hive.voiceMessages().map((m) => m.body);
  assert.equal(bodies.includes('STALE BODY'), false);
  assert.equal(bodies.includes('REAL BODY'), true);
});

test('a voice read still shows active and archived agents on the roster, with a retained folder', async (t) => {
  const { hive } = await floor(t);
  hive.setArchived('worker-1', true);
  const owners = new Set(hive.voiceMessages().map((m) => m.owner));
  assert.equal(owners.has('worker-1'), true, 'an archived agent is still on the roster');
  assert.equal(owners.has('god-1'), true);
});

test('a roster spelling that only reaches a folder through a disk ignoring case is not read', async (t) => {
  const { hive, agents } = await floor(t);
  strayMessage(agents, 'stray', 'near-msg', 'NEAR BODY');
  addRosterEntry(hive, 'STRAY');
  assert.equal(hive.voiceMessages().map((m) => m.body).includes('NEAR BODY'), false);
  assert.equal(hive.voiceMessages({ id: 'near-msg' }).length, 0);
});

test('a roster entry named after an app sender or missing its folder is not read', async (t) => {
  const { hive, agents } = await floor(t);
  addRosterEntry(hive, 'heartbeat');
  strayMessage(agents, 'heartbeat', 'alias-msg', 'ALIAS BODY');
  addRosterEntry(hive, 'no-folder-agent');
  const bodies = hive.voiceMessages().map((m) => m.body);
  assert.equal(bodies.includes('ALIAS BODY'), false);
  assert.ok(bodies.length > 0);
});
