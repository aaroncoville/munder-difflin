'use strict';
// The lock at the real hook handler. The order of the checks in handle() is the
// point of most of these: each runs the handler rather than the lock directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

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

/** Install the real generated bridge for `provider`, load it, and collect what it sends over a
 *  real socket. `load` hands back a way to fire the provider's native events. */
async function bridge(t, ctx, provider, load) {
  const id = `${provider}-agent`;
  const injection = await ctx.hive.ensureAgent({ id, name: id, provider, cwd: ctx.home });
  const generated = findFile(provider === 'pi' ? injection.env.PI_CODING_AGENT_DIR : ctx.home, 'hive-bridge.js');
  assert.ok(generated, `${provider} bridge installed`);
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-'));
  t.after(() => fs.rmSync(short, { recursive: true, force: true }));
  const frames = [];
  let onFrame = () => {};
  const sock = path.join(short, 's');
  const srv = net.createServer((c) => {
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => { frames.push(JSON.parse(buf)); onFrame(); });
  });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  const env = { sock: process.env.HIVE_SOCK, agent: process.env.AGENT_ID };
  process.env.HIVE_SOCK = sock; process.env.AGENT_ID = id;
  t.after(() => {
    if (env.sock === undefined) delete process.env.HIVE_SOCK; else process.env.HIVE_SOCK = env.sock;
    if (env.agent === undefined) delete process.env.AGENT_ID; else process.env.AGENT_ID = env.agent;
  });
  const fire = await load(generated, short);
  /** Fire a native event, wait for its frame, and run it through the real hook handler. */
  const send = async (...args) => {
    const arrived = new Promise((r) => { onFrame = r; });
    await fire(...args);
    await arrived;
    const frame = frames.at(-1);
    return { frame, reply: ctx.hooks.handle(frame) };
  };
  return { id, send };
}

const loadOpenCode = async (file, dir) => {
  const copy = path.join(dir, 'bridge.mjs');
  fs.copyFileSync(file, copy);
  const { HiveBridge } = await import(require('node:url').pathToFileURL(copy).href);
  const plugin = await HiveBridge();
  return (event, input, output) => plugin[event](input, output);
};
const loadPi = async (file, dir) => {
  const copy = path.join(dir, 'bridge.cjs');
  fs.copyFileSync(file, copy);
  const handlers = new Map();
  globalThis.pi = { on: (name, fn) => handlers.set(name, fn) };
  try { require(copy); } finally { delete globalThis.pi; }
  return async (event, ev) => { handlers.get(event)(ev); };
};

async function server(t, limit = 1) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-heavy-'));
  const previous = process.env.HOME;
  process.env.HOME = home;
  assert.equal(os.homedir(), home, 'HOME jailed before any hive is built');
  const hive = new HiveManager(() => home);
  t.after(() => {
    if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    fs.rmSync(home, { recursive: true, force: true });
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

// These two bridges send and forget, so a deny could never reach the provider. Their jobs are counted
// without being refused: other agents wait for that capacity, and no denial is recorded that the
// provider would ignore.
test('OpenCode: the bridge forwards the command, the job is counted against the limit and never denied', async (t) => {
  const ctx = await server(t);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  const { frame, reply } = await b.send('tool.execute.before', { tool: 'bash', callID: 'c7' }, { args: { command: 'npm test' } });
  assert.deepEqual(frame.tool_input, { command: 'npm test' });
  assert.equal(frame.tool_use_id, 'c7');
  assert.equal(decision(reply), undefined);
  assert.deepEqual(ctx.lock.snapshot().map((h) => h.agentId), [b.id]);
  assert.equal(decision(ctx.fire('a1', 'PreToolUse', 'dotnet build')), 'deny', 'other agents wait for it');
  await b.send('tool.execute.after', { tool: 'bash', callID: 'c7' }, {});
  assert.deepEqual(ctx.lock.snapshot().map((h) => h.agentId), [], 'paired by the call id');
});

test('OpenCode: at the limit the job still runs, is counted over it, and does not join the queue', async (t) => {
  const ctx = await server(t);
  const b = await bridge(t, ctx, 'opencode', loadOpenCode);
  ctx.fire('a1', 'PreToolUse', 'npm ci');
  const { reply } = await b.send('tool.execute.before', { tool: 'bash', callID: 'c8' }, { args: { command: 'npm test' } });
  assert.equal(decision(reply), undefined);
  assert.equal(ctx.lock.snapshot().length, 2);
  assert.deepEqual(ctx.lock.queueSnapshot().waiting, []);
  ctx.fire('a1', 'PostToolUse', 'npm ci');
  assert.equal(decision(ctx.fire('a2', 'PreToolUse', 'npm ci')), 'deny', 'one job still running at a limit of one');
});

test('Pi: the job is counted against the limit, never denied, and its result frees it', async (t) => {
  const ctx = await server(t);
  const b = await bridge(t, ctx, 'pi', loadPi);
  ctx.fire('a1', 'PreToolUse', 'npm ci');
  const { frame, reply } = await b.send('tool_call', { name: 'Bash', input: { command: 'npm test' } });
  assert.deepEqual(frame.tool_input, { command: 'npm test' });
  assert.equal(frame.heavy_count_only, undefined, 'decided from the registry, not by the frame');
  assert.equal(decision(reply), undefined);
  assert.equal(ctx.lock.snapshot().length, 2);
  assert.deepEqual(ctx.lock.queueSnapshot().waiting, []);
  await b.send('tool_result', { name: 'Bash', input: { command: 'npm test' } });
  assert.deepEqual(ctx.lock.snapshot().map((h) => h.agentId), ['a1']);
});

test('a provider that can honour a deny is still denied', async (t) => {
  const { fire } = await server(t);
  fire('a1', 'PreToolUse', 'npm ci');
  assert.equal(decision(fire('a2', 'PreToolUse', 'npm ci')), 'deny');
});
