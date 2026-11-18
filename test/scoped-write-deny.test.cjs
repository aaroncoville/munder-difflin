'use strict';
/**
 * Under scoped roots, the PreToolUse hook refuses file writes outside the seat's roots.
 *
 * The OS sandbox narrows what a seat's shell commands may write, but Claude's Edit, Write, MultiEdit and NotebookEdit
 * tools and Codex's apply_patch are judged by the CLI itself, and in bypass mode nothing prompts. So with the
 * scopedRoots setting on, the hook answers a call of one of those tools with a deny when it would write somewhere the
 * seat's roots do not cover, using the same model the dry run records with (writeRoots.ts observeTool): the reason
 * names the path's class, never the path. Allowed paths, other tools, and every seat spawned with the setting off are
 * answered exactly as before.
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
const { enforcedRoots } = loadTs('src/main/writeRoots.ts');

async function floor(t, scoped) {
  const base = codexTestBase(t, 'mdwd-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  for (const d of [harness, work]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  hive.ensureHive();
  const root = hive.root();
  // What the app records for each spawn (index.ts spawnRoots), here for three seats.
  const spawned = {
    ag: { cwd: work, provider: 'claude', isGod: false, scoped },
    other: { cwd: work, provider: 'claude', isGod: false, scoped },
    cx: { cwd: work, provider: 'codex', isGod: false, scoped },
    god: { cwd: harness, provider: 'claude', isGod: true, scoped },
  };
  for (const [id, s] of Object.entries(spawned)) {
    await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: s.cwd, isGod: s.isGod }, { spawnId: `pty-${id}`, scopedRoots: scoped });
  }
  const server = new HookServer(hive, () => null, () => ({ notifications: false, scopedRoots: scoped }), undefined, undefined);
  server.setWriteGate((agentId) => enforcedRoots(hive.root(), agentId, spawned[agentId]));
  const bare = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  // As the shim sends it: the CLI's agent_id, and the seat the app spawned as hive_seat_id.
  const call = (srv, agentId, tool_name, tool_input, extra = {}) => srv.handle({ hive_seat_id: agentId, agent_id: agentId, session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input, ...extra });
  return { base, harness, work, root, server, bare, call, fire: (...a) => call(server, ...a) };
}

const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

function assertDeny(f, r, cls, what) {
  assert.ok(denied(r), `${what} is denied: ${JSON.stringify(r)}`);
  assert.equal(r.hookSpecificOutput.hookEventName, 'PreToolUse');
  const why = r.hookSpecificOutput.permissionDecisionReason;
  assert.ok(why.includes(cls), `${what}: the reason names the class (${why})`);
  for (const p of [f.base, f.root, 'outbox', 'tasks.json']) if (p !== cls) assert.equal(why.includes(p), false, `${what}: the reason carries no path (${p})`);
}

test('flag off: every PreToolUse reply is what it was, for writes anywhere', async (t) => {
  const f = await floor(t, false);
  const calls = [
    ['ag', 'Write', { file_path: path.join(f.root, 'agents', 'other', 'outbox', 'm.json'), content: 'x' }],
    ['ag', 'Edit', { file_path: path.join(f.root, 'tasks.json'), old_string: 'a', new_string: 'b' }],
    ['cx', 'apply_patch', { input: `*** Begin Patch\n*** Add File: ${path.join(f.root, 'agents', 'other', 'inbox', 'x.json')}\n+{}\n*** End Patch\n` }],
    ['ag', 'Bash', { command: 'ls' }],
  ];
  for (const [id, tool, input] of calls) {
    const r = await f.fire(id, tool, input);
    assert.deepEqual(r, await f.call(f.bare, id, tool, input), `${id} ${tool}`);
    assert.equal(denied(r), false, `${id} ${tool}`);
  }
});

test('flag on: a write to another seat\'s outbox, the task list or a hook config in the hive is denied', async (t) => {
  const f = await floor(t, true);
  const outbox = path.join(f.root, 'agents', 'other', 'outbox', 'forged.json');
  assertDeny(f, await f.fire('ag', 'Write', { file_path: outbox, content: '{}' }), 'other agent folder', 'Write to another outbox');
  assertDeny(f, await f.fire('ag', 'Edit', { file_path: outbox, old_string: 'a', new_string: 'b' }), 'other agent folder', 'Edit of another outbox');
  assertDeny(f, await f.fire('ag', 'MultiEdit', { file_path: outbox, edits: [] }), 'other agent folder', 'MultiEdit of another outbox');
  assertDeny(f, await f.fire('ag', 'NotebookEdit', { notebook_path: path.join(f.root, 'agents', 'other', 'n.ipynb') }), 'other agent folder', 'NotebookEdit');
  assertDeny(f, await f.fire('ag', 'Write', { file_path: path.join(f.root, 'tasks.json'), content: '[]' }), 'tasks.json', 'Write to tasks.json');
  assertDeny(f, await f.fire('ag', 'Write', { file_path: path.join(f.root, '.claude', 'settings.json'), content: '{}' }), 'hive root (other)', 'Write to a hook config in the hive');
  // A relative path is read against the seat's working folder, as the CLI reads it.
  assertDeny(f, await f.fire('ag', 'Write', { file_path: path.relative(f.work, path.join(f.root, 'registry.json')), content: '{}' }), 'registry.json', 'relative Write');
});

test('flag on: the deny holds in bypass mode, where nothing prompts', async (t) => {
  const f = await floor(t, true);
  const r = await f.fire('ag', 'Write', { file_path: path.join(f.root, 'tasks.json'), content: '[]' }, { permission_mode: 'bypassPermissions' });
  assertDeny(f, r, 'tasks.json', 'bypass mode');
});

test('flag on: a Codex patch touching another seat\'s folder is denied, whatever else it touches', async (t) => {
  const f = await floor(t, true);
  const own = path.join(f.root, 'agents', 'cx', 'notes.md');
  const patch = `*** Begin Patch\n*** Update File: ${own}\n@@\n-a\n+b\n*** Add File: ${path.join(f.root, 'agents', 'other', 'inbox', 'x.json')}\n+{}\n*** End Patch\n`;
  assertDeny(f, await f.fire('cx', 'apply_patch', { input: patch }), 'other agent folder', 'apply_patch');
  assertDeny(f, await f.fire('cx', 'apply_patch', { command: ['apply_patch', patch] }), 'other agent folder', 'apply_patch as argv');
});

test('flag on: the seat\'s own folder, evidence/ and an outside worktree are allowed, as before', async (t) => {
  const f = await floor(t, true);
  const ok = [
    ['ag', 'Write', { file_path: path.join(f.root, 'agents', 'ag', 'outbox', 'm.json'), content: '{}' }],
    ['ag', 'Edit', { file_path: path.join(f.root, 'agents', 'ag', 'memory.md'), old_string: 'a', new_string: 'b' }],
    ['ag', 'Write', { file_path: path.join(f.root, 'evidence', 'run.log'), content: 'x' }],
    ['ag', 'Write', { file_path: path.join(f.work, 'src', 'x.ts'), content: 'x' }],
    ['ag', 'Write', { file_path: 'relative/in/worktree.ts', content: 'x' }],
    ['cx', 'apply_patch', { input: `*** Begin Patch\n*** Add File: src/y.ts\n+x\n*** End Patch\n` }],
    ['god', 'Write', { file_path: path.join(f.root, 'tasks.json'), content: '[]' }],
    ['god', 'Write', { file_path: path.join(f.root, 'agents', 'ag', 'inbox', 'x.json'), content: '{}' }],
  ];
  for (const [id, tool, input] of ok) {
    const r = await f.fire(id, tool, input);
    assert.equal(denied(r), false, `${id} ${tool} ${JSON.stringify(input)}`);
    assert.deepEqual(r, await f.call(f.bare, id, tool, input), `${id} ${tool}: answered as without the check`);
  }
});

test('flag on: other tools are left to the sandbox, and a write from a seat the app did not spawn is refused', async (t) => {
  const f = await floor(t, true);
  const other = path.join(f.root, 'agents', 'other', 'outbox', 'm.json');
  assert.equal(denied(await f.fire('ag', 'Bash', { command: `rm ${other}` })), false, 'Bash');
  assert.equal(denied(await f.fire('ag', 'Read', { file_path: other })), false, 'Read');
  assert.ok(denied(await f.fire('stranger', 'Write', { file_path: other, content: '' })), 'an id the app did not spawn has no roots, so nothing it may write');
});
