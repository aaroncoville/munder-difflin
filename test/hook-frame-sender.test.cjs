'use strict';

/**
 * An oversized hook frame is refused and logged with the sender's ids, read
 * from the first few kilobytes of the frame. The frame here comes from the
 * app's real hook shim, fed the payload shape Claude Code sends for a main
 * agent: no agent_id of its own, so the shim adds it from AGENT_ID.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { removeDir } = require('./codex-test-home.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { Notification: class { static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');

const LIMIT = 256 * 1024;

/** Run the staged shim with `input` on stdin; resolves when it exits. */
function runShim(shim, input, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [shim], { env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => { /* the shim may exit before reading everything */ });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('an oversized frame from the real shim names the agent that sent it', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-frame-sender-')));
  t.after(async () => { await removeDir(base); });
  const hive = new HiveManager(() => path.join(base, 'harness'));
  hive.ensureHive();
  const rt = path.join(base, 'rt');
  hive.setHookRuntime(rt);
  assert.equal(hive.hookRuntimeStatus().ok, true, JSON.stringify(hive.hookRuntimeStatus()));
  const shim = path.join(rt, 'cth-hook.cjs');

  const sock = path.join(base, 'h.sock');
  const logs = [];
  const fakeHive = {
    sockPath: () => sock,
    appendLog: (entry) => logs.push(entry),
    registry: () => ({ agents: { 'worker-big': {} } })
  };
  const server = new HookServer(fakeHive, () => null, () => ({ notifications: false }));
  server.handle = () => ({});
  server.start();
  if (!server.server.listening) await once(server.server, 'listening');
  t.after(() => server.stop());

  // Claude Code's key order for a main agent's PostToolUse: no agent_id, and the
  // tool's output last.
  const payload = JSON.stringify({
    session_id: 's1',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/tmp',
    permission_mode: 'bypassPermissions',
    hook_event_name: 'PostToolUse',
    tool_name: 'Read',
    tool_input: { file_path: '/tmp/big.txt' },
    tool_response: 'x'.repeat(LIMIT + 1024)
  });
  const res = await runShim(shim, payload, { PATH: process.env.PATH, HIVE_SOCK: sock, AGENT_ID: 'worker-big', HOME: base });
  assert.equal(res.code, 0, `shim failed: ${res.stderr}`);
  await new Promise((r) => setTimeout(r, 200));

  const rejected = logs.filter((l) => l.kind === 'hook-frame-rejected');
  assert.equal(rejected.length, 1, JSON.stringify(logs));
  assert.equal(rejected[0].agentId, 'worker-big', 'the rejection row must name the sending agent');
  assert.equal(rejected[0].hookEvent, 'PostToolUse');
  assert.equal(rejected[0].toolName, 'Read');
  assert.doesNotMatch(JSON.stringify(rejected[0]), /xxxx/);
});

test('the shim keeps an agent_id the payload already carries', async (t) => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-frame-sender-')));
  t.after(async () => { await removeDir(base); });
  const hive = new HiveManager(() => path.join(base, 'harness'));
  hive.ensureHive();
  const rt = path.join(base, 'rt');
  hive.setHookRuntime(rt);
  const shim = path.join(rt, 'cth-hook.cjs');

  const sock = path.join(base, 'h.sock');
  const got = [];
  const fakeHive = { sockPath: () => sock, appendLog: () => {}, registry: () => ({ agents: {} }) };
  const server = new HookServer(fakeHive, () => null, () => ({ notifications: false }));
  server.handle = (p) => { got.push(p); return {}; };
  server.start();
  if (!server.server.listening) await once(server.server, 'listening');
  t.after(() => server.stop());

  const payload = JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', agent_id: 'sub-1' });
  const res = await runShim(shim, payload, { PATH: process.env.PATH, HIVE_SOCK: sock, AGENT_ID: 'worker-big', HOME: base });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(got.length, 1);
  assert.equal(got[0].agent_id, 'sub-1', 'a subagent id from the CLI must not be replaced');
  assert.equal(got[0].hook_event_name, 'Stop');
  assert.equal(got[0].session_id, 's1');
});
