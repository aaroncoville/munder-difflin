'use strict';
/**
 * The operator's controls are keyed on the seat the app spawned, never on the id the CLI puts in a hook payload.
 *
 * For a Claude Code subagent's tool calls the CLI puts the subagent's own id in `agent_id`. The app never learns that
 * id, so it has no HALT, pause or gated tool for it, and a HALT or pause keyed on `agent_id` let a seat's subagents
 * carry on. The shim adds the seat id from the app-set AGENT_ID as `hive_seat_id`; the HALT gate, the pause and
 * gated-tool gate and the write-roots dry run use it. A frame without one (an older shim) falls back to `agent_id`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase, jailHome } = require('./codex-test-home.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron, filename: electron, loaded: true,
  exports: { Notification: class { show() {} static isSupported() { return false; } } }
};

const { HiveManager } = loadTs('src/main/hive.ts');
const { HookServer } = loadTs('src/main/hooks.ts');
const { ControlRegistry } = loadTs('src/main/control.ts');

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
