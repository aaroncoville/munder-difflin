'use strict';
/**
 * Under scoped roots, a protected write is allowed only inside the seat's own roots or its temp folder.
 *
 * The write check refused only writes into the hive that scoped roots would not grant; a path outside the hive passed
 * unjudged. In bypass mode Claude's Edit and Write tools can write anywhere, so a seat could still write the app's own
 * folders outside the hive (the seat settings folder, Codex agents' homes, the hook runtime) or anything in the home
 * folder. The check is now an allow check: every path a protected write touches must be inside the roots the seat was
 * given (writeRoots.ts seatRoots, plus explicit grants such as the shared memory folder) or one of its temp folders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
const { enforcedRoots } = loadTs('src/main/writeRoots.ts');

async function floor(t, scoped) {
  const base = codexTestBase(t, 'mdwa-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  const palace = path.join(harness, 'palace');
  const tmp = path.join(base, 'seat-tmp');
  for (const d of [harness, work, palace, tmp]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdwa-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  // What the app records for each spawn (index.ts spawnRoots): the relocation part of its environment and its grants.
  const spawned = {
    ag: { cwd: work, provider: 'claude', isGod: false, scoped, env: { HOME: base, TMPDIR: tmp }, grants: [palace] },
    cx: { cwd: work, provider: 'codex', isGod: false, scoped, env: { HOME: base, TMPDIR: tmp }, grants: [palace] },
    god: { cwd: harness, provider: 'claude', isGod: true, scoped, env: { HOME: base, TMPDIR: tmp }, grants: [palace] },
  };
  for (const [id, s] of Object.entries(spawned)) {
    await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: s.cwd, isGod: s.isGod }, { spawnId: `pty-${id}`, scopedRoots: scoped, extraWritableDirs: [palace] });
  }
  const server = new HookServer(hive, () => null, () => ({ notifications: false, scopedRoots: scoped }), undefined, undefined);
  server.setWriteGate((seat) => enforcedRoots(hive.root(), seat, spawned[seat]));
  const bare = new HookServer(hive, () => null, () => ({ notifications: false }), undefined, undefined);
  const call = (srv, seat, tool_name, tool_input) => srv.handle({ hive_seat_id: seat, agent_id: seat, cwd: spawned[seat]?.cwd, session_id: 's', hook_event_name: 'PreToolUse', tool_name, tool_input });
  const seatSettings = path.dirname(hive.seatSettingsPath('ag'));
  return { base, harness, work, palace, tmp, runtime, seatSettings, root: hive.root(), server, bare, call, fire: (...a) => call(server, ...a) };
}

const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const write = (file_path) => ({ file_path, content: 'x' });
const patch = (...files) => ({ input: `*** Begin Patch\n${files.map((p) => `*** Add File: ${p}\n+x\n`).join('')}*** End Patch\n` });

test('flag on: writes to the app\'s folders outside the hive, and anywhere in the home folder, are denied', async (t) => {
  const f = await floor(t, true);
  const outside = [
    ['seat settings folder', path.join(f.seatSettings, 'planted.json')],
    ['home folder', path.join(f.base, 'Documents', 'notes.md')],
    ['a dotfile in home', path.join(f.base, '.zshrc')],
    ['hook runtime', path.join(f.runtime, 'cth-hook.cjs')],
    ['Codex agents\' homes', path.join(f.base, '.mdc', 'x', 'config.toml')],
    ['the folder that holds the hive', path.join(f.harness, 'x.md')],
  ];
  for (const [what, p] of outside) {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      const r = await f.fire('ag', tool, write(p));
      assert.ok(denied(r), `${tool} into ${what}: ${JSON.stringify(r)}`);
      assert.equal(r.hookSpecificOutput.permissionDecisionReason.includes(f.base), false, 'no path in the reason');
    }
    assert.ok(denied(await f.fire('cx', 'apply_patch', patch(path.join(f.work, 'ok.ts'), p))), `apply_patch into ${what}`);
  }
  assert.ok(denied(await f.fire('ag', 'NotebookEdit', { notebook_path: path.join(f.base, 'n.ipynb') })), 'NotebookEdit into home');
  assert.ok(denied(await f.fire('god', 'Write', write(path.join(f.base, 'Documents', 'x.md')))), 'god is held to its roots too');
  assert.ok(denied(await f.fire('cx', 'apply_patch', { input: 'not a patch' })), 'a patch whose files cannot be read');
});

test('flag on: the seat\'s roots, its grants and its temp folder are allowed', async (t) => {
  const f = await floor(t, true);
  const ok = [
    ['ag', 'Write', write(path.join(f.tmp, 'scratch.txt'))],
    ['ag', 'Write', write(path.join(f.palace, 'drawer.json'))],
    ['ag', 'Write', write(path.join(f.work, 'src', 'a.ts'))],
    ['ag', 'Write', write(path.join(f.root, 'agents', 'ag', 'outbox', 'm.json'))],
    ['ag', 'Write', write(path.join(f.root, 'evidence', 'log.txt'))],
    ['cx', 'apply_patch', patch('src/rel.ts', path.join(f.tmp, 'p.txt'))],
    ['god', 'Write', write(path.join(f.harness, 'notes.md'))],
    ['god', 'Write', write(path.join(f.root, 'tasks.json'))],
  ];
  for (const [seat, tool, input] of ok) {
    const r = await f.fire(seat, tool, input);
    assert.equal(denied(r), false, `${seat} ${tool} ${JSON.stringify(input)}: ${JSON.stringify(r)}`);
  }
});

test('flag off: writes outside the hive are answered as before', async (t) => {
  const f = await floor(t, false);
  for (const p of [path.join(f.seatSettings, 'planted.json'), path.join(f.base, 'Documents', 'x.md'), path.join(f.tmp, 'a')]) {
    const r = await f.fire('ag', 'Write', write(p));
    assert.deepEqual(r, await f.call(f.bare, 'ag', 'Write', write(p)), p);
    assert.equal(denied(r), false, p);
  }
});
