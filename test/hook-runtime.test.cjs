'use strict';
// Claude and Codex hooks run outside the agent's sandbox. Their command runs a shim and a
// node launcher the app stages into a private folder of its own, written from its own text,
// verified by digest at staging and before every spawn. Nothing under the hive folder or a
// source checkout is on the command line, and when the folder cannot be staged, verified or
// kept out of the agent's reach, the spawn fails visibly instead of running hive code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const R = loadTs('src/main/hookRuntime.ts');
const POSIX = process.platform !== 'win32';

/** A short base under /tmp (socket paths are length-limited), HOME jailed into it, and an app-data folder beside the hive. */
function floor(t, opts = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(POSIX ? '/tmp' : os.tmpdir(), 'mdhr-')));
  const home = path.join(base, 'h');
  const rt = path.join(base, 'app', 'hook-runtime');
  fs.mkdirSync(home);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home);
  let homeNow = opts.unknownRoot ? null : home;
  const moveHome = (h) => { homeNow = h; };
  const hive = new HiveManager(() => homeNow);
  const root = path.join(home, 'hive');
  const log = () => (fs.existsSync(path.join(root, 'log.jsonl')) ? fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { base, home, rt, hive, root, log, setHome: () => { homeNow = home; }, moveHome };
}

function run(cmd, env, payload) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

async function listen(t, sock) {
  try { fs.unlinkSync(sock); } catch { /* not there */ }
  const received = [];
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('error', () => {});
    conn.on('data', (d) => { buf += d; });
    conn.on('close', () => { if (buf) received.push(JSON.parse(buf)); });
    conn.write('{}\n', () => conn.end());
  });
  server.on('error', () => {});
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  return received;
}

const tomlCommands = (config) => [...config.matchAll(/^command\s*=\s*(.+)$/gm)].map((m) => JSON.parse(m[1].trim()));
const claudeCommands = (settings) => [
  ...Object.values(settings.hooks ?? {}).flatMap((ms) => ms.flatMap((m) => m.hooks.map((h) => h.command))),
  ...(settings.statusLine ? [settings.statusLine.command] : []),
];
const claudeSettings = (root, id) => JSON.parse(fs.readFileSync(path.join(root, 'agents', id, 'settings.json'), 'utf8'));
const refused = async (p) => {
  try { await p; } catch (e) { assert.equal(e.code, 'hook-runtime-unavailable', String(e)); return e.message; }
  assert.fail('the spawn was not refused');
};

test('the runtime is staged private, from the app\'s own text, and new Claude and Codex sessions fire hooks through it, never through hive/bin', { skip: !POSIX, timeout: 20_000 }, async (t) => {
  const { home, rt, hive, root, log } = floor(t);
  hive.ensureHive();
  hive.setHookRuntime(rt);
  assert.deepEqual(hive.hookRuntimeStatus(), { configured: true, ok: true });
  assert.deepEqual(log().filter((r) => r.kind === 'hook-runtime').map((r) => r.ok), [true]);
  assert.equal(fs.statSync(rt).mode & 0o777, 0o700);
  const launcher = path.join(rt, 'hive-node');
  const shim = path.join(rt, 'cth-hook.cjs');
  assert.equal(fs.readFileSync(shim, 'utf8'), fs.readFileSync(path.join(root, 'bin', 'cth-hook.cjs'), 'utf8'), 'the same shim text the app has always written');

  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  const claude = claudeCommands(claudeSettings(root, 'c1'));
  const codex = tomlCommands(fs.readFileSync(path.join(hive.installCodexHooks(path.join(root, 'agents/x1'), home, 'x1'), 'config.toml'), 'utf8'));
  assert.equal(claude.length, 11);
  assert.equal(codex.length, 8);
  const expected = `"${launcher}" "${shim}"`;
  for (const c of claude) assert.ok(c === expected || c === `${expected} --status`, c);
  for (const c of codex) assert.equal(c, expected);

  const marker = path.join(home, 'tampered');
  fs.writeFileSync(path.join(root, 'bin', 'cth-hook.cjs'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`);
  fs.writeFileSync(path.join(root, 'bin', 'hive-node'), `#!/bin/sh\necho ran > "${marker}"\n`);
  const sock = path.join(root, 'hooks.sock');
  const received = await listen(t, sock);
  const env = { PATH: '/usr/bin:/bin', HIVE_SOCK: sock, HOME: home };
  const a = await run(claude[0], { ...env, AGENT_ID: 'c1' }, { hook_event_name: 'Stop', session_id: 's1' });
  const b = await run(codex[0], { ...env, AGENT_ID: 'x1' }, { hook_event_name: 'PreToolUse', session_id: 's2' });
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(received.map((p) => [p.agent_id, p.hook_event_name]).sort(), [['c1', 'Stop'], ['x1', 'PreToolUse']]);
  assert.equal(fs.existsSync(marker), false, 'the hive/bin copy ran');
});

test('with no runtime folder configured, no hook command is written at all', async (t) => {
  const { home, hive, root } = floor(t);
  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  assert.deepEqual(claudeCommands(claudeSettings(root, 'c1')), []);
  assert.deepEqual(hive.hookRuntimeStatus(), { configured: false, ok: false });
  assert.equal(tomlCommands(fs.readFileSync(path.join(hive.installCodexHooks(path.join(root, 'agents/x1'), home, 'x1'), 'config.toml'), 'utf8')).length, 0);
});

test('a spawn fails visibly when the runtime folder is in the hive, reached through a link, or the hive is not known yet', async (t) => {
  {
    const { home, hive, root, log } = floor(t);
    hive.setHookRuntime(path.join(root, 'bin', 'rt'));
    assert.match(await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home })), /hive folder/);
    assert.equal(fs.existsSync(path.join(root, 'bin', 'rt')), false, 'nothing is written into the hive');
    const rows = log().filter((r) => r.kind === 'hook-runtime');
    assert.ok(rows.length >= 1 && rows.every((r) => r.ok === false && /hive folder/.test(r.reason)), JSON.stringify(rows));
    assert.equal(hive.hookRuntimeStatus().ok, false);
    assert.equal(fs.existsSync(path.join(root, 'agents/c1/settings.json')) && claudeCommands(claudeSettings(root, 'c1')).length > 0, false, 'no hook command written');
  }
  {
    const { base, home, hive, root } = floor(t);
    hive.ensureHive();
    fs.symlinkSync(path.join(root, 'bin'), path.join(base, 'link'));
    hive.setHookRuntime(path.join(base, 'link', 'rt'));
    assert.match(await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home })), /hive folder/);
    assert.equal(fs.existsSync(path.join(root, 'bin', 'rt')), false);
  }
  {
    const { home, rt, hive, setHome } = floor(t, { unknownRoot: true });
    hive.setHookRuntime(rt);
    assert.match(hive.hookRuntimeStatus().reason, /not known/, 'unknown is a refusal, recorded');
    setHome();
    await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
    assert.equal(hive.hookRuntimeStatus().ok, true, 'staged once the hive is known');
  }
});

test('a hive that moves over the staged runtime fails the next spawn', async (t) => {
  const { base, hive, moveHome } = floor(t);
  const rt = path.join(base, 'later', 'hive', 'rt');
  hive.setHookRuntime(rt);
  assert.equal(hive.hookRuntimeStatus().ok, true);
  moveHome(path.join(base, 'later'));
  assert.match(await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: base })), /hive folder/);
});

test('a spawn fails when the agent could write the runtime: cwd, an extra root, Claude user settings, Codex user config; unreadable reads as overlap', async (t) => {
  const { base, home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const appDir = path.dirname(rt);
  assert.match(await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: appDir })), /may write the hook runtime/);
  assert.match(await refused(hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: home }, { extraWritableDirs: [base] })), /may write the hook runtime/);
  const work = path.join(base, 'work');
  fs.mkdirSync(work);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ permissions: { additionalDirectories: [appDir] } }));
  assert.match(await refused(hive.ensureAgent({ id: 'c3', name: 'C', provider: 'claude', cwd: work })), /may write the hook runtime/, 'user settings');
  fs.rmSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(work, '.claude'));
  fs.writeFileSync(path.join(work, '.claude/settings.local.json'), JSON.stringify({ sandbox: { filesystem: { allowWrite: [appDir] } } }));
  assert.match(await refused(hive.ensureAgent({ id: 'c5', name: 'C', provider: 'claude', cwd: work })), /may write the hook runtime/, 'project local settings');
  fs.writeFileSync(path.join(work, '.claude/settings.local.json'), '{ not json');
  assert.match(await refused(hive.ensureAgent({ id: 'c4', name: 'C', provider: 'claude', cwd: work })), /could not be read/);
  fs.rmSync(path.join(work, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  fs.rmSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/config.toml'), `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(base)}]\n`);
  assert.match(await refused(hive.ensureAgent({ id: 'x1', name: 'X', provider: 'codex', cwd: home })), /may write the hook runtime/);
  fs.writeFileSync(path.join(home, '.codex/config.toml'), 'sandbox_workspace_write.writable_roots = ["/"]\n');
  assert.match(await refused(hive.ensureAgent({ id: 'x2', name: 'X', provider: 'codex', cwd: home })), /could not be read/);
  fs.rmSync(path.join(home, '.codex'), { recursive: true });
  await hive.ensureAgent({ id: 'ok', name: 'OK', provider: 'claude', cwd: home });
});

test('a changed, replaced or loosened runtime fails the next spawn, and the one after stages it afresh', async (t) => {
  const { home, rt, hive, log } = floor(t);
  hive.setHookRuntime(rt);
  const shim = path.join(rt, 'cth-hook.cjs');
  for (const [why, spoil] of [
    ['changed', () => fs.appendFileSync(shim, '\n// x')],
    ['replaced by a link', () => { fs.rmSync(shim); fs.symlinkSync('/etc/hosts', shim); }],
    ['launcher changed', () => fs.appendFileSync(path.join(rt, POSIX ? 'hive-node' : 'hive-node.cmd'), '\n# x')],
    ...(POSIX ? [['folder loosened', () => fs.chmodSync(rt, 0o777)]] : []),
    ['folder gone', () => fs.rmSync(rt, { recursive: true })],
  ]) {
    await hive.ensureAgent({ id: 'ok', name: 'OK', provider: 'claude', cwd: home });
    spoil();
    await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home }));
    assert.equal(hive.hookRuntimeStatus().ok, false, why);
    await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
    assert.equal(hive.hookRuntimeStatus().ok, true, `${why}: restaged`);
  }
  assert.equal(fs.readFileSync(shim, 'utf8').includes('// x'), false);
  assert.ok(log().filter((r) => r.kind === 'hook-runtime' && r.ok === false).length >= 4);
});

test('staging replaces a planted link instead of writing through it, and refuses paths the command cannot carry', (t) => {
  const { base, rt, root } = floor(t);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(rt, { recursive: true, mode: 0o700 });
  const victim = path.join(base, 'victim');
  fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(rt, 'cth-hook.cjs'));
  const files = { launcher: { name: 'hive-node', content: '#!/bin/sh\n', mode: 0o700 }, shim: { name: 'cth-hook.cjs', content: 'x', mode: 0o600 } };
  R.stageHookRuntime({ dir: rt, hiveRoot: root, platform: process.platform, ...files });
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.equal(fs.lstatSync(path.join(rt, 'cth-hook.cjs')).isSymbolicLink(), false);
  for (const bad of ['a$b', 'a`id`b', 'a"b', 'a\\b']) {
    assert.throws(() => R.stageHookRuntime({ dir: path.join(base, bad), hiveRoot: root, platform: 'darwin', ...files }), /quote|\$|backtick/, bad);
  }
  assert.throws(() => R.stageHookRuntime({ dir: 'relative', hiveRoot: root, platform: 'darwin', ...files }), /absolute/);
  assert.throws(() => R.stageHookRuntime({ dir: rt, hiveRoot: null, platform: 'darwin', ...files }), /not known/);
});

/** CommandLineToArgvW's splitting rules (what a Windows program sees as argv). */
function windowsArgv(cmd) {
  const out = [];
  let cur = ''; let inQ = false; let any = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === '\\') {
      let n = 0; while (cmd[i] === '\\') { n++; i++; }
      if (cmd[i] === '"') { cur += '\\'.repeat(Math.floor(n / 2)); if (n % 2) cur += '"'; else { inQ = !inQ; } any = true; }
      else { cur += '\\'.repeat(n); i--; any = true; }
      continue;
    }
    if (c === '"') { inQ = !inQ; any = true; continue; }
    if (!inQ && (c === ' ' || c === '\t')) { if (any) { out.push(cur); cur = ''; any = false; } continue; }
    cur += c; any = true;
  }
  if (any) out.push(cur);
  return out;
}

test('Windows: the bare Codex command splits into exactly the launcher and the shim, and a path it could not carry is refused (needs one run on Windows)', () => {
  const dir = 'C:\\Users\\aaron\\AppData\\Local\\munder-difflin-hooks';
  const rt = { dir, launcher: `${dir}\\hive-node.cmd`, shim: `${dir}\\cth-hook.cjs`, digests: {} };
  const cmd = R.hookCommandFor(rt, false);
  assert.deepEqual(windowsArgv(cmd), [rt.launcher, rt.shim]);
  const toml = `command = ${JSON.stringify(cmd)}`;
  assert.deepEqual(windowsArgv(JSON.parse(toml.slice('command = '.length))), [rt.launcher, rt.shim], 'the TOML string round-trips');
  for (const bad of ['C:\\Users\\A B\\AppData\\Local\\x', 'C:\\Users\\a&b\\x', 'C:\\Users\\a%PATH%\\x', 'C:\\Program Files\\Munder Difflin\\x', 'C:\\Users\\a(1)\\x']) {
    assert.ok(R.unsafePathReason(bad, 'win32'), bad);
  }
  assert.equal(R.unsafePathReason(dir, 'win32'), null);
});

test('the app sets the runtime from its own data folder, refuses a spawn it cannot back, and reports the runtime in fleet health', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /hive\.setHookRuntime\(process\.platform === 'win32'\s*\?\s*join\(process\.env\.LOCALAPPDATA \|\| app\.getPath\('userData'\), 'munder-difflin-hooks'\)\s*:\s*join\(app\.getPath\('userData'\), 'hook-runtime'\)\)/);
  assert.match(main, /e instanceof HookRuntimeUnavailable\) return refuseSpawn\(/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'hooks.ts'), 'utf8'), /\{ runtime: this\.hive\.hookRuntimeStatus\(\) \}/);
  assert.doesNotMatch(main, /cth-hook\.cjs/, 'no shim path from resources or the hive');
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8'), /cth-hook/);
});
