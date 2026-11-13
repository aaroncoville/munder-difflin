'use strict';
// The lock at the real hook handler. The order of the checks in handle() is the
// point of most of these: each runs the handler rather than the lock directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, removeDir } = require('./codex-test-home.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HeavyJobLock } = loadTs('src/main/heavyJob.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const REPO = path.resolve(__dirname, '..');
const net = require('node:net');

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
  }
  return null;
}

/** Install the real generated bridge for `provider`, load it, and connect it over a real socket to
 *  the hook server's real connection handler. Hands back the provider's native events, and returns
 *  what the provider itself would see from them. */
async function bridge(t, ctx, provider, load, options = {}) {
  const id = `${provider}-agent`;
  const injection = await ctx.hive.ensureAgent({ id, name: id, provider, cwd: ctx.home });
  const generated = findFile(provider === 'pi' ? injection.env.PI_CODING_AGENT_DIR : ctx.home, 'hive-bridge.js');
  assert.ok(generated, `${provider} bridge installed`);
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  t.after(async () => removeDir(short));
  const frames = [];
  const handle = ctx.hooks.handle.bind(ctx.hooks);
  ctx.hooks.handle = (p) => { if (p.agent_id === id) frames.push(p); return handle(p); };
  const sock = path.join(short, 's');
  const srv = net.createServer((c) => ctx.hooks.serve(c));
  if (!options.noServer) {
    await new Promise((r) => srv.listen(sock, r));
    t.after(() => srv.close());
  }
  const env = { sock: process.env.HIVE_SOCK, agent: process.env.AGENT_ID, auto: process.env.HIVE_AUTO_APPROVE };
  process.env.HIVE_SOCK = sock; process.env.AGENT_ID = id;
  if (options.auto) process.env.HIVE_AUTO_APPROVE = '1'; else delete process.env.HIVE_AUTO_APPROVE;
  t.after(() => {
    for (const [name, value] of [['HIVE_SOCK', env.sock], ['AGENT_ID', env.agent], ['HIVE_AUTO_APPROVE', env.auto]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  });
  const fire = await load(generated, short);
  /** Wait for a fire-and-forget frame to reach the handler. */
  const reached = async (count) => {
    const until = Date.now() + 2000;
    while (frames.length < count && Date.now() < until) await new Promise((r) => setTimeout(r, 5));
    assert.equal(frames.length, count, 'frames reached the hook server');
  };
  return { id, fire, frames, reached };
}

const loadOpenCode = async (file, dir) => {
  const copy = path.join(dir, 'bridge.mjs');
  fs.copyFileSync(file, copy);
  const { HiveBridge } = await import(`${require('node:url').pathToFileURL(copy).href}?${Math.random()}`);
  const plugin = await HiveBridge();
  return (event, input, output) => plugin[event](input, output);
};
const loadPi = async (file, dir) => {
  const copy = path.join(dir, 'bridge.cjs');
  fs.copyFileSync(file, copy);
  const handlers = new Map();
  globalThis.pi = { on: (name, fn) => handlers.set(name, fn) };
  try { require(copy); } finally { delete globalThis.pi; }
  return (event, ev) => handlers.get(event)(ev);
};

async function server(t, limit = 1) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-heavy-'));
  // HOME is a folder of its own, not the agents' working directory: a working directory that holds HOME holds the
  // Codex agents' homes (~/.mdc), and the app refuses to start an agent that could write them.
  const userHome = codexTestBase(t, 'md-heavy-home-');
  const previous = process.env.HOME;
  process.env.HOME = userHome;
  assert.equal(os.homedir(), userHome, 'HOME jailed before any hive is built');
  const hive = new HiveManager(() => home);
  t.after(async () => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    await removeDir(home);
  });
  for (const id of ['a1', 'a2']) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  const control = { takeSteer: () => null, shouldHalt: () => false, toolDecision: () => ({ deny: false }) };
  const hooks = new HookServer(hive, () => null, () => ({ notifications: false }), control, undefined);
  const told = [];
  const lock = new HeavyJobLock({ limit: () => limit, setTimer: () => ({}), clearTimer: () => {}, notify: (a) => told.push(a) });
  hooks.setHeavyLock(lock);
  const fire = (agent_id, hook_event_name, command, extra = {}) => hooks.handle({ agent_id, hook_event_name, session_id: 's', tool_name: 'Bash', tool_input: { command }, ...extra });
  return { hive, hooks, lock, control, told, fire, home };
}
const decision = (r) => r.hookSpecificOutput?.permissionDecision;

test('a heavy PreToolUse past the limit is denied, a light one is untouched, and PostToolUse frees the slot', async (t) => {
  const { lock, fire } = await server(t);
  assert.equal(decision(fire('a1', 'PreToolUse', 'npm ci', { tool_use_id: 'u1' })), undefined, 'a1 takes the slot');
  const r = fire('a2', 'PreToolUse', 'dotnet build');
  assert.equal(decision(r), 'deny');
  assert.match(r.hookSpecificOutput.permissionDecisionReason, /held by a1 \(install: npm ci/);
  assert.equal(decision(fire('a2', 'PreToolUse', 'node --test test/one.test.cjs')), undefined, 'light: never gated');
  fire('a1', 'PostToolUse', 'npm ci', { tool_use_id: 'u1' });
  assert.equal(lock.snapshot().length, 0);
});

test('a refused agent is told when the slot frees, and can then run', async (t) => {
  const { told, fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm test');
  assert.equal(decision(fire('a2', 'PreToolUse', 'npm test')), 'deny');
  assert.deepEqual(told, []);
  fire('a1', 'PostToolUse', 'npm test');
  assert.deepEqual(told, ['a2']);
  assert.equal(decision(fire('a2', 'PreToolUse', 'npm test')), undefined);
});

test('slot after approval: a heavy call the approval gate denies takes no slot, so another agent can', async (t) => {
  const { lock, control, fire } = await server(t);
  control.toolDecision = (id) => (id === 'a1' ? { deny: true, reason: 'paused' } : { deny: false });
  const r = fire('a1', 'PreToolUse', 'npm ci', { tool_use_id: 'u9' });
  assert.equal(r.hookSpecificOutput.permissionDecisionReason, 'paused');
  assert.equal(lock.snapshot().length, 0);
  assert.deepEqual(lock.queueSnapshot().waiting, [], 'and it is not queued either');
  assert.equal(decision(fire('a2', 'PreToolUse', 'npm ci')), undefined);
});

test('a command that exits non-zero frees its slot through PostToolUseFailure', async (t) => {
  const { lock, fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm test', { tool_use_id: 'u1' });
  fire('a1', 'PostToolUseFailure', 'npm test', { tool_use_id: 'u1' });
  assert.equal(lock.snapshot().length, 0);
});

test('a call rejected at the permission prompt, which gets no PostToolUse, is freed when the turn ends', async (t) => {
  const { lock, fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm test');
  fire('a1', 'SubagentStop');
  assert.equal(lock.snapshot().length, 1, 'a subagent ending is not the agent\'s turn ending');
  fire('a1', 'Stop');
  assert.equal(lock.snapshot().length, 0);
});

test('a rejected call is also freed when the agent goes idle at its prompt, but a permission prompt frees nothing', async (t) => {
  const { lock, fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm test');
  fire('a1', 'Notification', undefined, { notification_type: 'permission_prompt' });
  assert.equal(lock.snapshot().length, 1);
  fire('a1', 'Notification', undefined, { notification_type: 'idle_prompt' });
  assert.equal(lock.snapshot().length, 0);
});

test('an interrupted call, which gets no Stop either, is freed by the next prompt', async (t) => {
  const { lock, fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm test');
  fire('a1', 'UserPromptSubmit');
  assert.equal(lock.snapshot().length, 0);
});

test('a PostToolUse still frees the slot when the agent is halted, or when a steer returns early', async (t) => {
  const { lock, control, fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm test');
  control.shouldHalt = () => true;
  assert.equal(fire('a1', 'PostToolUse', 'npm test').continue, false, 'the halt gate answered');
  assert.equal(lock.snapshot().length, 0);
  control.shouldHalt = () => false;
  fire('a1', 'PreToolUse', 'npm test');
  control.takeSteer = () => 'note';
  assert.ok(fire('a1', 'PostToolUse', 'npm test').hookSpecificOutput.additionalContext.includes('note'));
  assert.equal(lock.snapshot().length, 0);
});

test('a halted agent\'s PreToolUse takes no slot', async (t) => {
  const { lock, control, fire } = await server(t);
  control.shouldHalt = () => true;
  fire('a1', 'PreToolUse', 'npm test');
  assert.equal(lock.snapshot().length, 0);
});

test('the hook health that goes into fleet.json shows the limit, the holders and the queue', async (t) => {
  const { hooks, fire } = await server(t);
  fire('a1', 'PreToolUse', 'TOKEN=hunter2 npm test');
  fire('a2', 'PreToolUse', 'dotnet build');
  const { heavyLock } = hooks.health();
  assert.equal(heavyLock.limit, 1);
  assert.deepEqual(heavyLock.holders.map((h) => [h.agentId, h.job]), [['a1', 'npm test']]);
  assert.deepEqual(heavyLock.waiting.map((w) => [w.agentId, w.kind]), [['a2', 'build']]);
  assert.deepEqual(heavyLock.reservations, []);
  assert.equal(JSON.stringify(heavyLock).includes('hunter2'), false);
});

test('with no lock wired, nothing changes', async (t) => {
  const { hooks, fire } = await server(t);
  hooks.setHeavyLock(null);
  assert.equal(hooks.health().heavyLock, undefined);
  for (const a of ['a1', 'a2']) assert.equal(decision(fire(a, 'PreToolUse', 'npm ci')), undefined);
});

test('Claude agents get PostToolUseFailure hooks, or a failing suite would hold its slot', async (t) => {
  const { hive, home } = await server(t);
  const settings = hive.hookSettings(path.join(home, 'shim.cjs'), home, {});
  assert.ok(Array.isArray(settings.hooks.PostToolUseFailure));
  assert.equal(settings.hooks.PostToolUseFailure[0].matcher, settings.hooks.PostToolUse[0].matcher);
  assert.deepEqual(settings.hooks.PostToolUseFailure[0].hooks, settings.hooks.PostToolUse[0].hooks);
});

// index.ts runs at import and needs a live Electron, so its wiring can only be read. Comments are
// stripped first so that a commented-out line cannot satisfy these.
const liveSource = (file) => fs.readFileSync(path.join(REPO, file), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

test('index.ts builds the lock from the live setting, wires it in, and frees slots at teardown and every bulk kill', () => {
  const idx = liveSource('src/main/index.ts');
  assert.match(idx, /const heavyLock = new HeavyJobLock\(\{\s*limit: \(\) => heavyLimit\(readConfig\(\)\.heavyJobsAtOnce\),/);
  assert.match(idx, /probe: probeProcesses,/);
  assert.match(idx, /hookServer\.setHeavyLock\(heavyLock\);/);
  assert.match(idx, /if \(!\[\.\.\.ptyToAgent\.values\(\)\]\.includes\(agentId\)\) \{ try \{ heavyLock\.agentGone\(agentId\); \}/);
  const lines = idx.split('\n');
  const kills = lines.flatMap((l, i) => (/ptyManager\.killAll\(\)/.test(l) ? [i] : []));
  assert.equal(kills.length, 3, 'quit, reset and change of home');
  for (const i of kills) assert.match(lines[i - 1], /heavyLock\.agentsGone\(ptyToAgent\.values\(\)\)/, lines[i]);
});

test('the default is two slots, in the shipped config', () => {
  assert.match(liveSource('src/main/config.ts'), /^\s*heavyJobsAtOnce: 2,$/m);
});

// These two bridges must ask and wait, because each provider's own block path is the only thing that
// stops the job. Each assertion is on what the provider's callback does, not on the socket's reply.
const native = {
  opencode: {
    load: loadOpenCode,
    call: (b, id, command) => b.fire('tool.execute.before', { tool: 'bash', sessionID: 's', callID: id }, { args: { command } }),
    done: (b, id) => b.fire('tool.execute.after', { tool: 'bash', sessionID: 's', callID: id }, { output: '' })
  },
  pi: {
    load: loadPi,
    call: (b, id, command) => b.fire('tool_call', { toolName: 'bash', toolCallId: id, input: { command } }),
    done: (b, id, command) => b.fire('tool_result', { toolName: 'bash', toolCallId: id, input: { command } })
  }
};
const blocked = {
  opencode: async (p) => { await assert.rejects(p, /heavy-job lock.*held by a1/); },
  pi: async (p) => { const r = await p; assert.equal(r.block, true); assert.match(r.reason, /heavy-job lock.*held by a1/); }
};

for (const provider of ['opencode', 'pi']) {
  const n = native[provider];

  test(`${provider}: at the limit the provider's own block path fires, nothing runs past the limit, and the agent is queued`, async (t) => {
    const ctx = await server(t);
    const b = await bridge(t, ctx, provider, n.load);
    ctx.fire('a1', 'PreToolUse', 'npm ci');
    await blocked[provider](n.call(b, 'c1', 'npm test'));
    assert.deepEqual(ctx.lock.snapshot().map((h) => h.agentId), ['a1'], 'no holder past the limit');
    assert.deepEqual(ctx.lock.queueSnapshot().waiting.map((w) => w.agentId), [b.id]);
    assert.deepEqual(b.frames[0].tool_input, { command: 'npm test' });
    assert.equal(b.frames[0].tool_use_id, 'c1');
    ctx.fire('a1', 'PostToolUse', 'npm ci');
    assert.deepEqual(ctx.told, [b.id], 'told when the slot frees');
  });

  test(`${provider}: below the limit the job runs, holds a slot, and its result frees it by the call id`, async (t) => {
    const ctx = await server(t);
    const b = await bridge(t, ctx, provider, n.load);
    assert.equal(await n.call(b, 'c1', 'npm test'), undefined);
    assert.deepEqual(ctx.lock.snapshot().map((h) => h.agentId), [b.id]);
    assert.equal(decision(ctx.fire('a1', 'PreToolUse', 'dotnet build')), 'deny', 'other agents wait for it');
    await n.done(b, 'c1', 'npm test');
    await b.reached(2);
    assert.deepEqual(ctx.lock.snapshot().map((h) => h.agentId), []);
  });

  test(`${provider}: light work passes straight through`, async (t) => {
    const ctx = await server(t);
    const b = await bridge(t, ctx, provider, n.load);
    ctx.fire('a1', 'PreToolUse', 'npm ci');
    assert.equal(await n.call(b, 'c1', 'git status'), undefined);
  });

  test(`${provider}: an unreachable hook server lets the call through rather than wedging the agent`, async (t) => {
    const ctx = await server(t);
    const b = await bridge(t, ctx, provider, n.load, { noServer: true });
    assert.equal(await n.call(b, 'c1', 'npm test'), undefined);
  });
}

test('opencode: a call with no callID still runs, and the turn ending frees it', async (t) => {
  const ctx = await server(t);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  await b.fire('tool.execute.before', { tool: 'bash', sessionID: 'root' }, { args: { command: 'npm test' } });
  assert.equal(ctx.lock.snapshot().length, 1);
  await b.fire('event', { event: { type: 'session.idle', properties: { sessionID: 'root' } } });
  await b.reached(2);
  assert.equal(ctx.lock.snapshot().length, 0);
});

test('pi: auto-approval still reaches the provider when the call is allowed, and a block overrides it', async (t) => {
  const ctx = await server(t);
  const b = await bridge(t, ctx, 'pi', loadPi, { auto: true });
  assert.deepEqual(await native.pi.call(b, 'c1', 'git status'), { approve: true });
  ctx.fire('a1', 'PreToolUse', 'npm ci');
  const r = await native.pi.call(b, 'c2', 'npm test');
  assert.equal(r.block, true);
  assert.equal(r.approve, undefined);
});

test('an operator pause now reaches these providers too, through the same block path', async (t) => {
  const ctx = await server(t);
  const b = await bridge(t, ctx, 'pi', loadPi);
  ctx.control.toolDecision = () => ({ deny: true, reason: 'paused' });
  assert.deepEqual(await native.pi.call(b, 'c1', 'git status'), { block: true, reason: 'paused' });
});

// A subagent is a child session under the same PTY, and it goes idle while its parent is still busy.
const opencodeCall = (b, sessionID, callID, command = 'npm test') => b.fire('tool.execute.before', { tool: 'bash', sessionID, callID }, { args: { command } });
const opencodeEvent = (b, type, properties) => b.fire('event', { event: { type, properties } });

test('opencode: a child session going idle leaves its parent\'s two slots held, and a third call waits', async (t) => {
  const ctx = await server(t, 2);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  await opencodeCall(b, 'root', 'c1');
  await opencodeCall(b, 'root', 'c2');
  assert.equal(ctx.lock.snapshot().length, 2);
  await opencodeEvent(b, 'session.created', { info: { id: 'child', parentID: 'root' } });
  await opencodeEvent(b, 'session.idle', { sessionID: 'child' });
  await b.reached(3);
  assert.equal(b.frames.at(-1).hook_event_name, 'SubagentStop', 'a child ending is not the agent\'s turn ending');
  assert.equal(b.frames.at(-1).session_id, undefined, 'a child id must not become the session the agent resumes');
  assert.equal(ctx.lock.snapshot().length, 2);
  assert.equal(decision(ctx.fire('a1', 'PreToolUse', 'npm ci')), 'deny');
  await b.fire('tool.execute.after', { tool: 'bash', sessionID: 'root', callID: 'c1' }, {});
  await b.reached(4);
  assert.equal(ctx.lock.snapshot().length, 1, 'each is freed by its own completion');
});

test('opencode: a child going idle frees only the child\'s own call', async (t) => {
  const ctx = await server(t, 2);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  await opencodeEvent(b, 'session.updated', { info: { id: 'child', parentID: 'root' } });
  await opencodeCall(b, 'root', 'c1', 'npm test');
  await opencodeCall(b, 'child', 'c2', 'npm run build');
  await opencodeEvent(b, 'session.idle', { sessionID: 'child' });
  await b.reached(3);
  assert.equal(b.frames.at(-1).hook_event_name, 'SubagentStop', 'recognised as a child from session.updated');
  assert.deepEqual(ctx.lock.snapshot().map((h) => h.job), ['npm test']);
});

test('opencode: the root going idle ends the turn but leaves a child\'s running call held', async (t) => {
  const ctx = await server(t, 2);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  await opencodeEvent(b, 'session.created', { info: { id: 'root' } });
  await opencodeEvent(b, 'session.created', { info: { id: 'child', parentID: 'root' } });
  await opencodeCall(b, 'root', 'c1', 'npm test');
  await opencodeCall(b, 'child', 'c2', 'npm run build');
  await opencodeEvent(b, 'session.idle', { sessionID: 'root' });
  await b.reached(3);
  assert.equal(b.frames.at(-1).hook_event_name, 'Stop');
  assert.deepEqual(ctx.lock.snapshot().map((h) => h.job), ['npm run build']);
});

test('opencode: an idle from a session the bridge never heard about, or with no session, frees nobody else\'s slots', async (t) => {
  const ctx = await server(t, 2);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  await opencodeCall(b, 'root', 'c1');
  await opencodeEvent(b, 'session.idle', { sessionID: 'stranger' });
  await opencodeEvent(b, 'session.idle', {});
  await b.reached(3);
  assert.equal(ctx.lock.snapshot().length, 1);
});
