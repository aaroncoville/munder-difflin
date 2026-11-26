'use strict';
/**
 * The operator's controls are keyed on the seat the app spawned, never on the id the CLI puts in a hook payload.
 *
 * For a Claude Code subagent's tool calls the CLI puts the subagent's own id in `agent_id`. The app never learns that
 * id, so it has no HALT, pause or gated tool for it, and a HALT or pause keyed on `agent_id` let a seat's subagents
 * carry on. The shim adds the seat id from the app-set AGENT_ID as `hive_seat_id`; the HALT gate, the pause and
 * gated-tool gate and the write-roots dry run use it. A frame without one (an older shim) falls back to `agent_id`.
 *
 * Every CLI bridge must therefore send `hive_seat_id`. Each one here is the real generated file, run against a socket.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome, removeDir } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { ControlRegistry } = loadTs('src/core/control.ts');

const SEAT = 'seat-a';
const SUB = 'a3f9c1subagent';

async function floor(t) {
  const base = codexTestBase(t, 'mdgate-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  hive.ensureHive();
  await hive.ensureAgent({ id: SEAT, name: SEAT, provider: 'claude', cwd: work });
  const control = new ControlRegistry();
  const sent = [];
  const web = { send: (channel, payload) => sent.push({ channel, payload }) };
  const server = new HookServer(hive, () => web, () => ({ notifications: false }), control, undefined);
  const observed = [];
  server.setWriteObserver((id, event) => observed.push({ id, event }));
  const pre = (extra, tool_name = 'Bash') =>
    server.handle({ session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input: { command: 'ls' }, ...extra });
  return { server, control, sent, observed, pre };
}

const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const subFrame = { agent_id: SUB, hive_seat_id: SEAT };

test('a halted seat\'s subagent is stopped at its next hook', async (t) => {
  const f = await floor(t);
  f.control.halt(SEAT);
  const r = await f.pre(subFrame);
  assert.equal(r.continue, false, JSON.stringify(r));
  assert.deepEqual(f.sent.filter((s) => s.channel === 'hive:hookEvent').map((s) => s.payload.agentId), [SEAT]);
});

test('a paused seat\'s subagent is denied its tool call', async (t) => {
  const f = await floor(t);
  f.control.pause(SEAT, true);
  const r = await f.pre(subFrame);
  assert.ok(denied(r), JSON.stringify(r));
  assert.deepEqual(f.sent.filter((s) => s.channel === 'control:approvalRequest').map((s) => s.payload.agentId), [SEAT]);
});

test('a tool gated for a seat is denied to its subagent', async (t) => {
  const f = await floor(t);
  f.control.gateTool(SEAT, 'Bash', true);
  assert.ok(denied(await f.pre(subFrame)));
  assert.equal(denied(await f.pre(subFrame, 'Read')), false, 'an ungated tool still runs');
});

test('the write-roots dry run is told the seat, not the subagent', async (t) => {
  const f = await floor(t);
  await f.pre(subFrame);
  assert.deepEqual(f.observed, [{ id: SEAT, event: 'PreToolUse' }]);
});

test('a frame with no seat id is judged on its agent_id, as before', async (t) => {
  const f = await floor(t);
  f.control.halt(SEAT);
  assert.equal((await f.pre({ agent_id: SEAT })).continue, false);
  assert.equal((await f.pre({ agent_id: SEAT, hive_seat_id: '' })).continue, false);
  assert.notEqual((await f.pre({ agent_id: SUB })).continue, false, 'a bare subagent id still has no controls');
  assert.deepEqual(f.observed.map((o) => o.id), [SEAT, SEAT, SUB]);
});

test('a seat id with no controls gets none, even when its agent_id has them', async (t) => {
  const f = await floor(t);
  f.control.halt(SEAT);
  f.control.pause(SEAT, true);
  const r = await f.pre({ agent_id: SEAT, hive_seat_id: 'stranger' });
  assert.notEqual(r.continue, false);
  assert.equal(denied(r), false, JSON.stringify(r));
});

// ─── the other CLIs' bridges ──────────────────────────────────────────────

function findFile(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && e.name === name) return p;
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
  }
  return null;
}

/** Stage `provider`'s real bridge and return its file. */
async function staged(t, provider, name) {
  const base = codexTestBase(t, 'mdbr-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  fs.mkdirSync(harness, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  hive.ensureHive();
  const injection = await hive.ensureAgent({ id: `${provider}-seat`, name: provider, provider, cwd: base });
  const file = findFile(provider === 'pi' ? injection.env.PI_CODING_AGENT_DIR : base, name);
  assert.ok(file, `${provider}: ${name} staged`);
  return file;
}

/** Run `args` in a child with AGENT_ID and HIVE_SOCK set, and return the first frame it sends to the socket. */
async function frameFrom(t, args, stdin) {
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'sg-'));
  t.after(async () => removeDir(short));
  const sock = path.join(short, 's');
  let frame = '';
  const srv = net.createServer((c) => { c.on('data', (d) => { frame += d; if (frame.includes('\n')) c.end('{}'); }); });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  await new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: short, env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', HIVE_SOCK: sock, AGENT_ID: SEAT } });
    child.on('close', resolve);
    child.stdin.end(stdin ?? '');
  });
  assert.ok(frame.includes('\n'), 'the bridge sent a frame');
  return JSON.parse(frame.split('\n')[0]);
}

function assertSeated(frame) {
  assert.equal(frame.hive_seat_id, SEAT, JSON.stringify(frame));
  assert.equal(Object.keys(frame)[0], 'hive_seat_id', 'first, so an oversized frame still names its seat');
  assert.equal(frame.agent_id, SEAT, 'agent_id is what the bridge sent before');
}

test('the agy bridge sends the seat id', async (t) => {
  const shim = await staged(t, 'antigravity', 'agy-hook.cjs');
  const frame = await frameFrom(t, [shim, 'PreToolUse'], JSON.stringify({ conversationId: 'c', toolCall: { name: 'Bash', args: {} } }));
  assertSeated(frame);
  assert.equal(frame.hook_event_name, 'PreToolUse');
});

test('the gemini bridge sends the seat id, replacing one the payload carried', async (t) => {
  const shim = await staged(t, 'gemini', 'gemini-hook.cjs');
  const frame = await frameFrom(t, [shim], JSON.stringify({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', hive_seat_id: 'other' }));
  assertSeated(frame);
  assert.equal(frame.hook_event_name, 'PreToolUse');
});

test('the grok bridge sends the seat id', async (t) => {
  const shim = await staged(t, 'grok', 'grok-hook.cjs');
  const frame = await frameFrom(t, [shim], JSON.stringify({ hookEventName: 'pre_tool_use', toolName: 'Bash', toolInput: {} }));
  assertSeated(frame);
  assert.equal(frame.hook_event_name, 'PreToolUse');
});

test('the opencode plugin sends the seat id, on the call it waits for and on the one it does not', async (t) => {
  const file = await staged(t, 'opencode', 'hive-bridge.js');
  const copy = path.join(path.dirname(file), 'bridge-under-test.mjs');
  fs.copyFileSync(file, copy);
  for (const [hook, event] of [['tool.execute.before', 'PreToolUse'], ['tool.execute.after', 'PostToolUse']]) {
    const drive = `const { HiveBridge } = await import(${JSON.stringify(require('node:url').pathToFileURL(copy).href)});
      const plugin = await HiveBridge();
      await plugin[${JSON.stringify(hook)}]({ tool: 'bash', callID: 'c1', sessionID: 's1', args: {} }, { args: {} });`;
    const frame = await frameFrom(t, ['--input-type=module', '-e', drive]);
    assertSeated(frame);
    assert.equal(frame.hook_event_name, event);
  }
});

test('the pi extension sends the seat id, on the call it waits for and on the one it does not', async (t) => {
  const file = await staged(t, 'pi', 'hive-bridge.js');
  const copy = path.join(path.dirname(file), 'bridge-under-test.cjs');
  fs.copyFileSync(file, copy);
  for (const [hook, event] of [['tool_call', 'PreToolUse'], ['tool_result', 'PostToolUse']]) {
    const drive = `const handlers = new Map();
      globalThis.pi = { on: (name, fn) => handlers.set(name, fn) };
      require(${JSON.stringify(copy)});
      Promise.resolve(handlers.get(${JSON.stringify(hook)})({ toolName: 'bash', toolCallId: 'c1', input: {} }));`;
    const frame = await frameFrom(t, ['-e', drive]);
    assertSeated(frame);
    assert.equal(frame.hook_event_name, event);
  }
});
