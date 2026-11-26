'use strict';
/**
 * The write check is keyed on the seat, never on the id the CLI puts in a hook payload.
 *
 * Claude puts a subagent's own id in `agent_id` for the subagent's tool calls, and the hook shim kept it, so a write
 * check keyed on `agent_id` found no seat and let the write through: any seat could get round it by delegating to a
 * subagent. The shim now always adds the seat id the app gave it (its AGENT_ID) as `hive_seat_id`, overwriting any
 * value the payload carried and leaving the CLI's `agent_id` as it was. The write check uses `hive_seat_id`, and with
 * scoped roots on a protected write whose seat is missing or unknown is refused.
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
const { seatGate } = loadTs('src/core/writeRoots.ts');

async function floor(t, { configOn = true } = {}) {
  const base = codexTestBase(t, 'mdsid-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdsid-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  const spawned = {
    ag: { cwd: work, provider: 'claude', isGod: false, scoped: true },
    other: { cwd: work, provider: 'claude', isGod: false, scoped: true },
    old: { cwd: work, provider: 'claude', isGod: false, scoped: false },
  };
  const tokens = {};
  for (const [id, s] of Object.entries(spawned)) tokens[id] = (await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: s.cwd }, { spawnId: `pty-${id}`, scopedRoots: s.scoped })).env.HIVE_SPAWN_TOKEN;
  const server = new HookServer(hive, () => null, () => ({ notifications: false, scopedRoots: configOn }), undefined, undefined);
  // As index.ts wires it: the spawn the call's token names, else the agent's spawn record.
  server.setWriteGate((seat, token) => seatGate(hive.root(), seat, token, (tk) => hive.spawnPolicy(tk), (id) => spawned[id]));
  const root = hive.root();
  // The token is the one the seat's own spawn was given, as its shim sends it.
  const pre = (extra, tool_name = 'Write', tool_input = { file_path: path.join(root, 'agents', 'other', 'outbox', 'forged.json'), content: '{}' }) =>
    server.handle({ session_id: 's', hook_event_name: 'PreToolUse', cwd: work, ...(tokens[extra.hive_seat_id] ? { hive_spawn: tokens[extra.hive_seat_id] } : {}), tool_name, tool_input, ...extra });
  return { root, runtime, server, pre };
}

const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

test('a subagent\'s write to another seat\'s outbox is judged as its seat\'s, and denied', async (t) => {
  const f = await floor(t);
  const r = await f.pre({ agent_id: 'a3f9c1subagent', hive_seat_id: 'ag' });
  assert.ok(denied(r), JSON.stringify(r));
  assert.ok(r.hookSpecificOutput.permissionDecisionReason.includes('other agent folder'));
  // The same seat writing its own folder through a subagent is allowed.
  const own = await f.pre({ agent_id: 'a3f9c1subagent', hive_seat_id: 'ag' }, 'Write', { file_path: path.join(f.root, 'agents', 'ag', 'notes.md'), content: 'x' });
  assert.equal(denied(own), false);
});

test('scoped roots on: a protected write with no seat id, or one the app did not spawn, is refused', async (t) => {
  const f = await floor(t);
  for (const extra of [{ agent_id: 'ag' }, { agent_id: 'ag', hive_seat_id: null }, { agent_id: 'ag', hive_seat_id: 'stranger' }, { hive_seat_id: '' }]) {
    const r = await f.pre(extra);
    assert.ok(denied(r), `${JSON.stringify(extra)}: ${JSON.stringify(r)}`);
  }
  assert.equal(denied(await f.pre({ hive_seat_id: 'stranger' }, 'Read', { file_path: '/x' })), false, 'an unprotected tool is not judged');
  assert.equal(denied(await f.pre({ hive_seat_id: 'old' })), false, 'a seat spawned with scoped roots off keeps its old answer');
});

test('scoped roots off: a write with no seat id is answered as before', async (t) => {
  const f = await floor(t, { configOn: false });
  assert.deepEqual(await f.pre({ agent_id: 'ag' }), {});
  assert.deepEqual(await f.pre({ hive_seat_id: 'stranger' }), {});
});

/** Run the staged shim against a socket that records the frame it gets and allows. */
async function shimFrame(t, f, payload, env) {
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'sid-'));
  t.after(async () => removeDir(short));
  const sock = path.join(short, 's');
  let frame = '';
  const srv = net.createServer((c) => { c.on('data', (d) => { frame += d; if (frame.includes('\n')) c.end('{}'); }); });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(f.runtime, 'cth-hook.cjs')], { env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', HIVE_SOCK: sock, ...env } });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
  return JSON.parse(frame.split('\n')[0]);
}

test('the shim adds the seat id from its environment, keeps the CLI\'s agent_id, and overwrites a planted seat id', async (t) => {
  const f = await floor(t);
  const sub = await shimFrame(t, f, { hook_event_name: 'PreToolUse', tool_name: 'Write', agent_id: 'a3f9c1subagent', hive_seat_id: 'other' }, { AGENT_ID: 'ag' });
  assert.equal(sub.agent_id, 'a3f9c1subagent', 'the CLI\'s id is kept');
  assert.equal(sub.hive_seat_id, 'ag', 'the seat id is the app\'s, whatever the payload said');
  assert.equal(Object.keys(sub)[0], 'hive_seat_id', 'first, so an oversized frame still names its seat');
  const top = await shimFrame(t, f, { hook_event_name: 'PreToolUse', tool_name: 'Write' }, { AGENT_ID: 'ag' });
  assert.equal(top.agent_id, 'ag', 'no CLI id: filled in from the environment as before');
  assert.equal(top.hive_seat_id, 'ag');
});
