'use strict';
/**
 * Scoped-roots policy belongs to one spawn, not to an agent id.
 *
 * Two spawns of one agent can overlap (a restart while the old terminal is still starting), each with its own setting
 * and grants. The policy was kept per agent id, so the later spawn's answer replaced the earlier one's, and a process
 * started scoped could be judged as unscoped and have its writes allowed. Each scoped spawn now gets a token of its
 * own in its environment, which the hook shim sends as hive_spawn; the write check judges a call by the policy of the
 * spawn that token names. A token the app did not issue, or issued for another agent, is refused, and so is a call
 * with no token from a seat whose recorded spawn is scoped.
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
const { seatGate } = loadTs('src/main/writeRoots.ts');

function floor(t) {
  const base = codexTestBase(t, 'mdtk-');
  jailHome(t, base);
  const harness = path.join(base, 'h');
  const work = path.join(base, 'work');
  const grantA = path.join(base, 'grant-a');
  const grantB = path.join(base, 'grant-b');
  for (const d of [harness, work, grantA, grantB]) fs.mkdirSync(d, { recursive: true });
  const hive = withSeatSettings(new HiveManager(() => harness));
  const runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mdtk-rt-')));
  t.after(async () => removeDir(runtime));
  hive.setHookRuntime(runtime);
  hive.ensureHive();
  const root = hive.root();
  // The record main keeps for the spawn whose terminal started last (index.ts spawnRoots), per agent id.
  const records = {};
  const started = (id, spawnId, provider = 'claude') => { records[id] = { cwd: work, provider, isGod: false, ...hive.spawnScope(spawnId) }; };
  const server = new HookServer(hive, () => null, () => ({ notifications: false, scopedRoots: true }), undefined, undefined);
  server.setWriteGate((seat, token) => seatGate(hive.root(), seat, token, (tk) => hive.spawnPolicy(tk), (id) => records[id]));
  const write = (seat, token, file_path) => server.handle({ hive_seat_id: seat, agent_id: seat, cwd: work, ...(token ? { hive_spawn: token } : {}), session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path, content: 'x' } });
  const prov = (id, spawnId, scopedRoots, grant, provider = 'claude') => hive.ensureAgent({ id, name: id, provider, cwd: work }, { spawnId, scopedRoots, extraWritableDirs: [grant] });
  return { base, root, work, grantA, grantB, hive, runtime, started, write, prov };
}

const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';

for (const order of ['scoped first', 'unscoped first']) {
  test(`two overlapping spawns of one agent keep their own policy (${order})`, async (t) => {
    const f = floor(t);
    await f.prov('other', 'pty-other', true, f.grantA);
    const provA = () => f.prov('dup', 'pty-a', true, f.grantA);
    const provB = () => f.prov('dup', 'pty-b', false, f.grantB);
    const [a, b] = order === 'scoped first' ? [await provA(), await provB()] : [null, await provB()].map((x) => x);
    const injA = a ?? await provA();
    const injB = b;
    const token = injA.env.HIVE_SPAWN_TOKEN;
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(Object.hasOwn(injB.env, 'HIVE_SPAWN_TOKEN'), false, 'an unscoped spawn gets no token');
    assert.deepEqual(f.hive.spawnScope('pty-a'), { scoped: true, isGod: false, grants: [f.grantA] });
    assert.deepEqual(f.hive.spawnScope('pty-b'), { scoped: false, isGod: false, grants: [f.grantB] });
    for (const winner of ['pty-a', 'pty-b']) {
      // Whichever terminal started last, the scoped process is judged by its own spawn.
      f.started('dup', winner);
      assert.ok(denied(await f.write('dup', token, path.join(f.root, 'agents', 'other', 'outbox', 'x.json'))), `${winner}: another seat's outbox`);
      assert.ok(denied(await f.write('dup', token, path.join(f.grantB, 'x'))), `${winner}: the other spawn's grant`);
      assert.equal(denied(await f.write('dup', token, path.join(f.grantA, 'x'))), false, `${winner}: its own grant`);
    }
    // The unscoped process sends no token: judged by the recorded spawn.
    f.started('dup', 'pty-b');
    assert.equal(denied(await f.write('dup', undefined, path.join(f.root, 'agents', 'other', 'outbox', 'x.json'))), false, 'unscoped spawn on record: unchecked');
    f.started('dup', 'pty-a');
    assert.ok(denied(await f.write('dup', undefined, path.join(f.grantA, 'x'))), 'a scoped spawn on record and no token: refused');
  });
}

test('a token the app did not issue, or issued for another agent, is refused', async (t) => {
  const f = floor(t);
  const own = await f.prov('ag', 'pty-ag', true, f.grantA);
  const theirs = await f.prov('other', 'pty-other', true, f.grantA);
  f.started('ag', 'pty-ag');
  const mine = path.join(f.root, 'agents', 'ag', 'x.md');
  assert.equal(denied(await f.write('ag', own.env.HIVE_SPAWN_TOKEN, mine)), false, 'its own token');
  assert.ok(denied(await f.write('ag', 'f'.repeat(32), mine)), 'a made-up token');
  assert.ok(denied(await f.write('ag', theirs.env.HIVE_SPAWN_TOKEN, mine)), 'another agent\'s token');
});

test('a resumed Codex home follows the policy of the spawn that resumes it', async (t) => {
  const f = floor(t);
  const a = await f.prov('cdup', 'pty-ca', true, f.grantA, 'codex');
  await f.prov('cdup', 'pty-cb', false, f.grantB, 'codex');
  const home = a.env.CODEX_HOME;
  f.hive.prepareResumedCodexHome('cdup', f.work, home, [f.grantA], 'pty-ca');
  const toml = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  assert.ok(toml.includes(JSON.stringify(path.join(f.root, 'evidence'))), 'scoped roots, as spawn A decided');
  assert.equal(toml.includes(JSON.stringify(f.root) + ','), false, 'not the whole hive');
});

test('the shim sends its spawn token only when the app set one', async (t) => {
  const f = floor(t);
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
  t.after(async () => removeDir(short));
  const sock = path.join(short, 's');
  const frames = [];
  const srv = net.createServer((c) => { let d = ''; c.on('data', (x) => { d += x; if (d.includes('\n')) { frames.push(JSON.parse(d)); c.end('{}'); } }); });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  const run = (env, payload) => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(f.runtime, 'cth-hook.cjs')], { env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', HIVE_SOCK: sock, AGENT_ID: 'ag', ...env } });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
  await run({ HIVE_SPAWN_TOKEN: 'abc' }, { hook_event_name: 'PreToolUse', hive_spawn: 'planted' });
  await run({}, { hook_event_name: 'PreToolUse' });
  await run({}, { hook_event_name: 'PreToolUse', hive_spawn: 'planted' });
  assert.equal(frames[0].hive_spawn, 'abc', 'the app\'s token, whatever the payload said');
  assert.deepEqual(Object.keys(frames[1]), ['hive_seat_id', 'agent_id', 'hook_event_name'], 'no token: the frame is as before');
  assert.equal(Object.hasOwn(frames[2], 'hive_spawn'), false, 'a planted token is dropped');
});
