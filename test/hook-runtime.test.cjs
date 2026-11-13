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
  assert.match(await refused(hive.ensureAgent({ id: 'x2', name: 'X', provider: 'codex', cwd: home })), /through \/ \(/, 'a dotted key is parsed as the grant it is, and / reaches the runtime folder');
  fs.writeFileSync(path.join(home, '.codex/config.toml'), 'writable_roots = $X\n');
  assert.match(await refused(hive.ensureAgent({ id: 'x3', name: 'X', provider: 'codex', cwd: home })), /could not be read/);
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
  for (const bad of ['C:\\Users\\a&b\\x', 'C:\\Users\\a%PATH%\\x', 'C:\\Users\\a(1)\\x']) {
    assert.ok(R.unsafePathReason(bad, 'win32'), bad);
  }
  for (const spaced of ['C:\\Users\\A B\\AppData\\Local\\x', 'C:\\Program Files\\Munder Difflin\\x']) {
    assert.ok(R.unsafePathReason(spaced, 'win32', true), `${spaced}: the bare Codex command cannot carry it`);
    assert.equal(R.unsafePathReason(spaced, 'win32', false), null, `${spaced}: the quoted Claude command can`);
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

test('round 2: refusals name what to change, ~ and $HOME roots are understood, other forms are not', async (t) => {
  const { base, home, rt, hive, root } = floor(t);
  hive.setHookRuntime(rt);
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
  const rel = path.relative(home, path.dirname(rt));
  const settings = path.join(work, '.claude', 'settings.json');
  for (const entry of [`~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`]) {
    fs.writeFileSync(settings, JSON.stringify({ permissions: { additionalDirectories: [entry] } }));
    const msg = await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: work }));
    assert.ok(msg.includes(path.dirname(rt)) && msg.includes(settings), `${entry}: ${msg}`);
  }
  for (const entry of ['$OTHER/x', '~someone/x', '%APPDATA%\\x']) {
    fs.writeFileSync(settings, JSON.stringify({ sandbox: { filesystem: { allowWrite: [entry] } } }));
    const msg = await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: work }));
    assert.ok(/could not be read or understood/.test(msg) && msg.includes(settings), `${entry}: ${msg}`);
  }
  fs.writeFileSync(settings, JSON.stringify({ permissions: { additionalDirectories: ['sub'] } }));
  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: work });
  const managed = path.join(base, 'managed-settings.json');
  fs.writeFileSync(managed, JSON.stringify({ sandbox: { filesystem: { allowWrite: [path.dirname(rt)] } } }));
  hive.managedClaudeSettings = managed;
  const mMsg = await refused(hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: work }));
  assert.ok(mMsg.includes(managed), mMsg);
  fs.rmSync(managed);
  const cwdMsg = await refused(hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: path.dirname(rt) }));
  assert.ok(cwdMsg.includes(path.dirname(rt)) && /working directory/.test(cwdMsg), cwdMsg);
  assert.equal(root, path.join(home, 'hive'));
});

test('round 2: a refused new agent leaves nothing behind; the floor state stays ok and the refusal is per agent', async (t) => {
  const { home, rt, hive, root } = floor(t);
  hive.setHookRuntime(rt);
  await refused(hive.ensureAgent({ id: 'nope', name: 'N', provider: 'claude', cwd: path.dirname(rt) }));
  assert.equal(fs.existsSync(path.join(root, 'agents', 'nope')), false, 'no folder');
  assert.equal(Object.hasOwn(hive.registry().agents, 'nope'), false, 'no registry entry');
  const st = hive.hookRuntimeStatus();
  assert.equal(st.ok, true, 'one agent\'s reach does not mark the floor down');
  assert.match(st.refused.nope, /working directory/);
  await hive.ensureAgent({ id: 'nope', name: 'N', provider: 'claude', cwd: home });
  assert.equal(hive.hookRuntimeStatus().refused, undefined, 'cleared once it starts');
});

test('round 2: a file changed while an agent was being refused is reported, not silently restaged', async (t) => {
  const { home, rt, hive, log } = floor(t);
  hive.setHookRuntime(rt);
  await refused(hive.ensureAgent({ id: 'n1', name: 'N', provider: 'claude', cwd: path.dirname(rt) }));
  fs.appendFileSync(path.join(rt, 'cth-hook.cjs'), '\n// x');
  await refused(hive.ensureAgent({ id: 'ok', name: 'OK', provider: 'claude', cwd: home }));
  assert.ok(log().some((r) => r.kind === 'hook-runtime' && r.ok === false && /changed since the app wrote it/.test(r.reason)));
  await hive.ensureAgent({ id: 'ok', name: 'OK', provider: 'claude', cwd: home });
});

test('round 2: a manager with no runtime folder says so once in the log', async (t) => {
  const { home, hive, log } = floor(t);
  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  await hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: home });
  const rows = log().filter((r) => r.kind === 'hook-runtime');
  assert.equal(rows.length, 1);
  assert.match(rows[0].reason, /no hook runtime folder/);
});

test('round 2: every Codex config that can add a write root is read: user, project in the cwd or above, any table form', async (t) => {
  const { base, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const app = path.dirname(rt);
  const work = path.join(base, 'repo', 'pkg');
  fs.mkdirSync(work, { recursive: true });
  const above = path.join(base, 'repo', '.codex', 'config.toml');
  const here = path.join(work, '.codex', 'config.toml');
  // Exact forms are read and the root is named; any other form is not understood and refuses, naming the file.
  const forms = [
    [above, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(app)}]\n`, 'a project config above the cwd', 'root'],
    [here, `[sandbox_workspace_write]\nwritable_roots = [\n  "/elsewhere",\n  ${JSON.stringify(app)}, # mine\n]\n`, 'a multi-line array', 'root'],
    [here, `sandbox_workspace_write.writable_roots = [${JSON.stringify(app)}]\n`, 'a dotted key in the cwd', 'root'],
    [here, `sandbox_workspace_write = { writable_roots = [${JSON.stringify(app)}] }\n`, 'an inline table', 'root'],
    [here, `"sandbox_workspace_write"."writable\\u005froots" = [${JSON.stringify(app)}]\n`, 'an escaped key', 'root'],
    [here, `[profiles.fast.sandbox_workspace_write]\nwritable_roots = ['${app}']\n`, 'a profile, literal string', 'form'],
  ];
  let i = 0;
  for (const [file, text, why, kind] of forms) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const msg = await refused(hive.ensureAgent({ id: `x${i++}`, name: 'X', provider: 'codex', cwd: work }));
    assert.ok(msg.includes(file) && (kind === 'root' ? msg.includes(app) : /could not be read or understood/.test(msg)), `${why}: ${msg}`);
    fs.rmSync(file);
  }
  // A relative root in a project config is read against the spawn's cwd, not the config's folder.
  fs.mkdirSync(path.dirname(above), { recursive: true });
  fs.writeFileSync(above, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(path.relative(work, app))}]\n`);
  assert.ok((await refused(hive.ensureAgent({ id: 'xrel', name: 'X', provider: 'codex', cwd: work }))).includes(app), 'relative to the cwd');
  fs.rmSync(above);
  for (const [text, why] of [['[sandbox_workspace_write]\nwritable_roots = some_var\n', 'not TOML'], ['[sandbox_workspace_write]\nwritable_roots = ["/a"\n', 'broken'], ['[sandbox_workspace_write]\nwritable_roots = [1]\n', 'not text']]) {
    fs.writeFileSync(here, text);
    assert.match(await refused(hive.ensureAgent({ id: `x${i++}`, name: 'X', provider: 'codex', cwd: work })), /could not be read or understood/, why);
  }
  fs.rmSync(here);
  const benign = path.join(base, 'benign.toml');
  fs.writeFileSync(benign, '[sandbox_workspace_write]\nwritable_roots = ["/elsewhere"]\n');
  fs.symlinkSync(benign, here);
  assert.match(await refused(hive.ensureAgent({ id: `x${i++}`, name: 'X', provider: 'codex', cwd: work })), /could not be read or understood/, 'a link');
  fs.rmSync(here);
  fs.writeFileSync(here, '[sandbox_workspace_write]\nwritable_roots = ["/elsewhere"]\n');
  await hive.ensureAgent({ id: 'xok', name: 'X', provider: 'codex', cwd: work });
  const userCfg = path.join(os.homedir(), '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(userCfg), { recursive: true });
  fs.writeFileSync(userCfg, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(app)}]\n`);
  assert.ok(!work.startsWith(os.homedir()), 'the cwd is outside home, so only the user config can name it');
  assert.ok((await refused(hive.ensureAgent({ id: 'xu', name: 'X', provider: 'codex', cwd: work }))).includes(userCfg));
  fs.rmSync(userCfg);
  fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(work, '.claude', 'settings.json'), JSON.stringify({ sandbox: { filesystem: { allowWrite: app } } }));
  assert.match(await refused(hive.ensureAgent({ id: 'c9', name: 'C', provider: 'claude', cwd: work })), /could not be read or understood/, 'a Claude root list that is not a list');
});

test('round 3: comments and names with ~ are read as such; Claude settings get the link, size and pipe checks; CLAUDE_CONFIG_DIR and the managed drop-ins are read', async (t) => {
  const { base, home, rt, hive, log } = floor(t);
  hive.setHookRuntime(rt);
  const app = path.dirname(rt);
  const work = path.join(base, 'work');
  fs.mkdirSync(path.join(work, '.codex'), { recursive: true });
  fs.mkdirSync(path.join(work, '.claude'), { recursive: true });
  // L1: a comment is not a root.
  fs.writeFileSync(path.join(work, '.codex/config.toml'), '# writable_roots = ["/"] was here\nmodel = "x" # no writable_roots\n');
  await hive.ensureAgent({ id: 'x1', name: 'X', provider: 'codex', cwd: work });
  fs.writeFileSync(path.join(work, '.codex/config.toml'), `[sandbox_workspace_write]\nwritable_roots = ["/a#b", ${JSON.stringify(app)}] # trailing\n`);
  assert.ok((await refused(hive.ensureAgent({ id: 'x2', name: 'X', provider: 'codex', cwd: work }))).includes(app), 'a # inside a string is not a comment');
  fs.rmSync(path.join(work, '.codex/config.toml'));
  // L2: ~ inside a name is a name; a leading ~user is not understood.
  const settings = path.join(work, '.claude/settings.json');
  fs.writeFileSync(settings, JSON.stringify({ permissions: { additionalDirectories: [path.join(base, 'Library/Mobile Documents/com~apple~CloudDocs')] } }));
  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: work });
  fs.writeFileSync(settings, JSON.stringify({ permissions: { additionalDirectories: ['~someone/x'] } }));
  assert.match(await refused(hive.ensureAgent({ id: 'c2', name: 'C', provider: 'claude', cwd: work })), /could not be read or understood/);
  // L4: the log row's agent id is plain.
  assert.ok(log().some((r) => r.kind === 'hook-runtime' && r.agentId === 'c2'), JSON.stringify(log().filter((r) => r.kind === 'hook-runtime')));
  // L5: a link, an oversized file and a named pipe are not followed or read.
  fs.rmSync(settings);
  const benign = path.join(base, 'benign.json');
  fs.writeFileSync(benign, '{}');
  fs.symlinkSync(benign, settings);
  assert.match(await refused(hive.ensureAgent({ id: 'c3', name: 'C', provider: 'claude', cwd: work })), /could not be read/, 'a link');
  fs.rmSync(settings);
  fs.writeFileSync(settings, '{}' + ' '.repeat(1024 * 1024 + 1));
  assert.match(await refused(hive.ensureAgent({ id: 'c4', name: 'C', provider: 'claude', cwd: work })), /could not be read/, 'oversized');
  fs.rmSync(settings);
  if (POSIX) {
    require('node:child_process').execFileSync('mkfifo', [settings]);
    assert.match(await refused(hive.ensureAgent({ id: 'c5', name: 'C', provider: 'claude', cwd: work })), /could not be read/, 'a named pipe, without hanging');
    fs.rmSync(settings);
  }
  // CLAUDE_CONFIG_DIR moves the user file.
  const cfgDir = path.join(base, 'claude-cfg');
  fs.mkdirSync(cfgDir);
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [app] } }));
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = cfgDir;
  try { assert.ok((await refused(hive.ensureAgent({ id: 'c6', name: 'C', provider: 'claude', cwd: work }))).includes(cfgDir)); }
  finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
  // The managed drop-in folder beside the managed file.
  const managed = path.join(base, 'managed', 'managed-settings.json');
  fs.mkdirSync(path.join(base, 'managed', 'managed-settings.d'), { recursive: true });
  fs.writeFileSync(path.join(base, 'managed', 'managed-settings.d', '10-x.json'), JSON.stringify({ sandbox: { filesystem: { allowWrite: [app] } } }));
  hive.managedClaudeSettings = managed;
  assert.ok((await refused(hive.ensureAgent({ id: 'c7', name: 'C', provider: 'claude', cwd: work }))).includes('10-x.json'));
  assert.equal(home.length > 0, true);
});

test('round 3: an agent refused over an hour ago and never spawned since leaves the refused list', async (t) => {
  const { rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  await refused(hive.ensureAgent({ id: 'gone', name: 'G', provider: 'claude', cwd: path.dirname(rt) }));
  assert.ok(hive.hookRuntimeStatus().refused.gone);
  const realNow = Date.now;
  Date.now = () => realNow() + 61 * 60_000;
  try { assert.equal(hive.hookRuntimeStatus().refused, undefined); } finally { Date.now = realNow; }
});

// --- round 4: one decision from the launch itself, made before anything is created ---

const claudeLaunch = (dir, extra = [], env = {}) => ({ argv: ['claude --permission-mode bypassPermissions', '--append-system-prompt', 'hi', '--settings', path.join(dir, 'settings.json'), ...extra], env });
const codexLaunch = (extra = [], env = {}) => ({ argv: ['codex -a never -s workspace-write', '--dangerously-bypass-hook-trust', ...extra], env });

test('round 4: the launch line and its environment decide; anything not modelled refuses, naming the cause', async (t) => {
  const { base, home, rt, hive, root } = floor(t);
  hive.setHookRuntime(rt);
  const app = path.dirname(rt);
  const dir = (id) => path.join(root, 'agents', id);
  const spawn = (id, provider, launch) => hive.ensureAgent({ id, name: id, provider, cwd: home }, { launch });
  await spawn('ok1', 'claude', claudeLaunch(dir('ok1')));
  await spawn('ok2', 'codex', codexLaunch());
  // The exact forms the live floor runs today (argv elements whole, as the app hands them to the PTY).
  await spawn('live1', 'claude', { argv: ['claude --model claude-opus-5-5 --permission-mode bypassPermissions', '--append-system-prompt', 'You are "X" -- a multi word prompt --text', '--settings', path.join(dir('live1'), 'settings.json'), '--remote-control-session-name-prefix', 'X', '--resume', '4df241fc-56f4-48dc-b830-602be03f8b81'], env: { HOME: home } });
  await spawn('live2', 'codex', { argv: ['codex --model gpt-5.6-sol -a never -s workspace-write', '--dangerously-bypass-hook-trust', '--add-dir', dir('live2'), '--add-dir', root, 'You are "Y" --channel x'], env: { HOME: home, CODEX_HOME: path.join(dir('live2'), '.codex') } });
  await spawn('live3', 'codex', { argv: ['codex', 'resume', '01a1d072-5747-7e83-a08f-03389a2cac3f', '-a', 'never', '-s', 'workspace-write', '--dangerously-bypass-hook-trust', 'prompt'], env: { HOME: home } });
  const cases = [
    ['w1', 'claude', { argv: ['env X=1 claude'], env: {} }, /does not run claude itself/],
    ['w2', 'claude', { argv: ['sh -c claude'], env: {} }, /does not run claude itself/],
    ['w3', 'codex', { argv: ['npx codex -s workspace-write'], env: {} }, /does not run codex itself/],
    ['f1', 'claude', claudeLaunch(dir('f1'), ['--weird']), /option the app does not model: option --weird/],
    ['f2', 'claude', claudeLaunch(dir('f2'), ['--settings', '/tmp/other.json']), /option the app does not model/],
    ['f3', 'codex', codexLaunch(['-p', 'fast']), /option the app does not model: option -p/],
    ['f4', 'codex', { argv: ['codex -a never'], env: {} }, /chooses no Codex sandbox and no config does: add -s workspace-write to its command, or set sandbox_mode in /],
    ['f5', 'codex', { argv: ['codex --yolo'], env: {} }, /turns the Codex sandbox off/],
    ['e1', 'claude', claudeLaunch(dir('e1'), [], { XDG_CONFIG_HOME: base }), /XDG_CONFIG_HOME/],
    ['e2', 'claude', claudeLaunch(dir('e2'), [], { CLAUDE_CODE_MCP_SERVE_SETTINGS: '' }), /CLAUDE_CODE_MCP_SERVE_SETTINGS/],
    ['e3', 'claude', claudeLaunch(dir('e3'), [], { CLAUDE_CONFIG_DIR: 'rel' }), /CLAUDE_CONFIG_DIR/],
    ['a1', 'claude', claudeLaunch(dir('a1'), ['--add-dir', app]), /launch line \(--add-dir\)/],
    ['a2', 'codex', codexLaunch(['--add-dir', app]), /launch line \(--add-dir\)/],
  ];
  for (const [id, provider, launch, why] of cases) {
    assert.match(await refused(spawn(id, provider, launch)), why, id);
    assert.equal(fs.existsSync(dir(id)), false, `${id}: nothing created`);
    assert.equal(Object.hasOwn(hive.registry().agents, id), false, `${id}: no row`);
  }
  // Carried from the shared launch reader: a temp folder is a root; options after the prompt and plugins refuse.
  assert.ok((await refused(spawn('t1', 'claude', claudeLaunch(dir('t1'), [], { TMPDIR: app })))).includes('TMPDIR'));
  assert.match(await refused(spawn('t2', 'codex', codexLaunch(['prompt', '--yolo']))), /option the app does not model/);
  assert.match(await refused(spawn('t3', 'claude', claudeLaunch(dir('t3'), ['--plugin-dir', '/p']))), /option the app does not model/);
  // Jannings' probe: an alternate Claude config folder granting the runtime folder is honoured, so it refuses.
  const alt = path.join(base, 'alt-claude');
  fs.mkdirSync(alt);
  fs.writeFileSync(path.join(alt, 'settings.json'), JSON.stringify({ permissions: { additionalDirectories: [app] } }));
  assert.ok((await refused(spawn('cfg', 'claude', claudeLaunch(dir('cfg'), [], { CLAUDE_CONFIG_DIR: alt })))).includes(alt));
  // HOME in the spawn environment is where the user settings are read.
  const otherHome = path.join(base, 'other-home');
  fs.mkdirSync(path.join(otherHome, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(otherHome, '.claude/settings.json'), JSON.stringify({ sandbox: { filesystem: { allowWrite: ['~/x', app] } } }));
  assert.ok((await refused(spawn('hm', 'claude', claudeLaunch(dir('hm'), [], { HOME: otherHome })))).includes(app));
});

test('round 4: decided once — a policy change after the decision starts under the snapshot; the late check refuses a launch that changed, and rolls back', async (t) => {
  const { base, home, rt, hive, root, log } = floor(t);
  hive.setHookRuntime(rt);
  const app = path.dirname(rt);
  const dir = (id) => path.join(root, 'agents', id);
  // Policy changes between the decision and the terminal: the snapshot stands, no disk re-read.
  await hive.ensureAgent({ id: 'n1', name: 'n1', provider: 'claude', cwd: home }, { launch: claudeLaunch(dir('n1')) });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/settings.json'), JSON.stringify({ permissions: { additionalDirectories: [app] } }));
  assert.doesNotThrow(() => hive.confirmHookLaunch(hive.takeHookVerdict('n1'), claudeLaunch(dir('n1')).argv, {}));
  fs.rmSync(path.join(home, '.claude'), { recursive: true });
  // A final launch that adds an unchecked root refuses and rolls a NEW agent back: folder, row, and a log row saying so.
  await hive.ensureAgent({ id: 'n2', name: 'n2', provider: 'claude', cwd: home }, { launch: claudeLaunch(dir('n2')), spawnId: 's-n2' });
  assert.ok(fs.existsSync(dir('n2')) && Object.hasOwn(hive.registry().agents, 'n2'));
  assert.throws(() => hive.confirmHookLaunch(hive.takeHookVerdict('s-n2'), claudeLaunch(dir('n2'), ['--add-dir', app]).argv, {}), /write root that was not checked/);
  assert.equal(fs.existsSync(dir('n2')), true, 'no folder is ever deleted: the one this call created is left in place');
  assert.equal(Object.hasOwn(hive.registry().agents, 'n2'), false, 'only the row this call added is rolled back');
  assert.ok(log().some((r) => r.kind === 'spawn-rolled-back' && r.agentId === 'n2' && r.rowRemoved === true && r.folderLeft === dir('n2')));
  // A final environment that moves Claude's settings refuses too; an EXISTING agent keeps its row and folder.
  await hive.ensureAgent({ id: 'n1', name: 'n1', provider: 'claude', cwd: home }, { launch: claudeLaunch(dir('n1')) });
  assert.throws(() => hive.confirmHookLaunch(hive.takeHookVerdict('n1'), claudeLaunch(dir('n1')).argv, { CLAUDE_CONFIG_DIR: base }), /moved Claude's settings/);
  assert.ok(fs.existsSync(dir('n1')) && Object.hasOwn(hive.registry().agents, 'n1'), 'an existing agent is not removed');
  // A final launch line that is a wrapper, or drops the Codex sandbox, refuses.
  await hive.ensureAgent({ id: 'x1', name: 'x1', provider: 'codex', cwd: home }, { launch: codexLaunch() });
  const v = hive.takeHookVerdict('x1');
  assert.throws(() => hive.confirmHookLaunch({ ...v, isNew: false }, ['codex -a never'], {}), /does not keep the Codex sandbox/);
  assert.throws(() => hive.confirmHookLaunch({ ...v, isNew: false }, ['sh -c codex'], {}), /does not run codex itself/);
  // A relative --add-dir checked at the decision passes the late check: both read it against the spawn's cwd.
  await hive.ensureAgent({ id: 'x2', name: 'x2', provider: 'codex', cwd: home }, { launch: codexLaunch(['--add-dir', 'sub']) });
  assert.doesNotThrow(() => hive.confirmHookLaunch({ ...hive.takeHookVerdict('x2'), isNew: false }, codexLaunch(['--add-dir', 'sub']).argv, {}));
  // The app's own remote rewrite is not a change.
  assert.doesNotThrow(() => hive.confirmHookLaunch({ ...v, isNew: false }, ['codex -a never -s workspace-write', '--dangerously-bypass-hook-trust', '--remote', 'unix:///x.sock'], {}));
  // A runtime file changed after the decision fails the late check.
  fs.appendFileSync(path.join(rt, 'cth-hook.cjs'), '\n// x');
  assert.throws(() => hive.confirmHookLaunch({ ...v, isNew: false }, codexLaunch().argv, {}), /changed since the app wrote it/);
  assert.equal(root.endsWith('hive'), true);
});

test('round 4: the app passes the launch to ensureAgent and runs the late check before the terminal starts', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /launch: \{ argv: \[opts\.command, \.\.\.\(opts\.args \?\? \[\]\)\], env: relocationEnv\(buildPtyEnv\(process\.env, '', opts\.env\)\) \}/);
  const late = main.indexOf('hive.confirmSpawn(opts.id, { id: opts.hive.id, provider }');
  assert.match(main, /spawnId: opts\.id,/, 'the decision is keyed by this spawn');
  const spawnAt = main.indexOf('const res = ptyManager.spawn(opts, owner);');
  assert.ok(late > 0 && late < spawnAt, 'the late check runs before the PTY spawns');
  assert.match(main.slice(late, spawnAt), /instanceof HookRuntimeUnavailable\) return refuseSpawn\(/);
});

test('round 5: a hand-written line with no -s takes the sandbox from Codex config; none, unknown or full access refuses saying what to change', async (t) => {
  const { base, home, rt, hive, root } = floor(t);
  hive.setHookRuntime(rt);
  const userCfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(userCfg), { recursive: true });
  const work = path.join(base, 'w');
  fs.mkdirSync(path.join(work, '.codex'), { recursive: true });
  // Hand-written lines with no -s (the app's builders always emit one): bare 'codex', and 'codex --model x'.
  const forms = [{ argv: ['codex'], env: {} }, { argv: ['codex --model gpt-x'], env: {} }];
  let n = 0;
  const spawn = (launch, cwd = home) => hive.ensureAgent({ id: `ao${n++}`, name: 'a', provider: 'codex', cwd }, { launch });
  for (const f of forms) {
    fs.rmSync(userCfg, { force: true });
    assert.match(await refused(spawn(f)), /add -s workspace-write to its command, or set sandbox_mode in .*config\.toml/, 'no mode anywhere');
    fs.writeFileSync(userCfg, 'sandbox_mode = "workspace-write"\n');
    await spawn(f);
    fs.writeFileSync(userCfg, 'sandbox_mode = "read-only"\n');
    await spawn(f);
    fs.writeFileSync(userCfg, 'sandbox_mode = "danger-full-access"\n');
    assert.match(await refused(spawn(f)), /sets sandbox_mode = "danger-full-access"/);
    fs.writeFileSync(userCfg, 'sandbox_mode = 1\n');
    assert.match(await refused(spawn(f)), /could not be understood \(sandbox_mode is not text\)/);
    fs.writeFileSync(userCfg, "sandbox_mode = 'workspace-write'\n");
    await spawn(f); // a literal string is valid TOML
  }
  // The nearest project config wins over the user's.
  fs.writeFileSync(userCfg, 'sandbox_mode = "workspace-write"\n');
  fs.writeFileSync(path.join(work, '.codex', 'config.toml'), 'sandbox_mode = "danger-full-access"\n');
  assert.match(await refused(spawn({ argv: ['codex'], env: {} }, work)), /danger-full-access/);
  fs.rmSync(path.join(work, '.codex', 'config.toml'));
  // The late check accepts a final line with no -s only when the decision took the sandbox from config.
  await hive.ensureAgent({ id: 'ok', name: 'ok', provider: 'codex', cwd: home }, { launch: { argv: ['codex'], env: {} } });
  const v = hive.takeHookVerdict('ok');
  assert.equal(v.codexFromConfig, true);
  assert.doesNotThrow(() => hive.confirmHookLaunch({ ...v, isNew: false }, ['codex', '--dangerously-bypass-hook-trust'], {}));
  await hive.ensureAgent({ id: 'ok2', name: 'ok2', provider: 'codex', cwd: home }, { launch: { argv: ['codex -s workspace-write'], env: {} } });
  assert.throws(() => hive.confirmHookLaunch({ ...hive.takeHookVerdict('ok2'), isNew: false }, ['codex'], {}), /does not keep the Codex sandbox/);
  assert.equal(root.endsWith('hive'), true);
});

test('round 5/6: Codex config is parsed as TOML; names in strings never count; refusals name the key', async (t) => {
  const { base, home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const L = loadTs('src/main/launchLine.ts');
  const q3 = '"'.repeat(3);
  const fine = [
    '[projects."/Users/me/profile"]\ntrust_level = "trusted"\n',
    'model = "set sandbox_mode = danger later"\n',
    'model = "writable_roots"\n',
    `model = ${q3}\nsandbox_mode = "danger-full-access"\n${q3}\n`,
    '[tui]\nm = { name = "sandbox_mode" }\n',
  ];
  for (const t2 of fine) assert.equal(L.codexRoots(t2).state, 'ok', JSON.stringify(t2));
  // Hooks in the owner's own config are allowed and not read; in a project config they are not understood.
  const hooks = '[[hooks.Stop]]\ncommand = "a"\n[[hooks.Stop.hooks]]\ntype = "command"\n';
  assert.equal(L.codexRoots(hooks, 'user').state, 'ok');
  assert.equal(L.codexRoots(hooks, 'project').state, 'unknown');
  // Keys off the versioned allowlist are not understood, by name.
  for (const [t2, key] of [['[profiles.x]\nmodel = "y"\n', 'profiles'], ['notes = "x"\n', 'notes'], ['x = "writable_roots"\n', 'x']]) assert.equal(L.codexRoots(t2).why, `${key} is not on the list this app version understands (Codex 0.162-0.167)`);
  const bad = [
    ['[profiles.x]\nsandbox_mode = "danger-full-access"\n', 'profiles'],
    ['[[sandbox_workspace_write]]\nx = 1\n', 'sandbox_workspace_write'],
    ['sandbox_mode = "nope"\n', 'sandbox_mode'],
    ['[sandbox_workspace_write]\nwritable_roots = "/"\n', 'writable_roots'],
    ['profile = "fast"\n', 'profile'],
    ['[tui]\n[profiles.x.sandbox_workspace_write]\nwritable_roots = ["/"]\n', 'profiles'],
  ];
  for (const [t2, word] of bad) { const r = L.codexRoots(t2); assert.equal(r.state, 'unknown', JSON.stringify(t2)); assert.ok(r.why.includes(word.split(' ')[0]), `${JSON.stringify(t2)}: ${r.why}`); }
  // The refusal carries it.
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'profile = "x"\n[a]\nb = 1\n');
  assert.match(await refused(hive.ensureAgent({ id: 'p1', name: 'p', provider: 'codex', cwd: home }, { launch: { argv: ['codex -s workspace-write'], env: {} } })), /profile is not on the list this app version understands/);
});

test('round 5: the refused list keeps at most the 32 most recent agents', async (t) => {
  const { rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  for (let i = 0; i < 40; i++) await refused(hive.ensureAgent({ id: `r${i}`, name: 'r', provider: 'claude', cwd: path.dirname(rt) }));
  const ids = Object.keys(hive.hookRuntimeStatus().refused);
  assert.equal(ids.length, 32);
  assert.ok(ids.includes('r39') && !ids.includes('r0'));
});

test('round 6: no folder is ever deleted — a pre-existing orphan folder survives a late refusal byte for byte', async (t) => {
  const { home, rt, hive, root, log } = floor(t);
  hive.setHookRuntime(rt);
  hive.ensureHive();
  const orphan = path.join(root, 'agents', 'orph');
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'notes.md'), 'keep me\n');
  const before = fs.readFileSync(path.join(orphan, 'notes.md'));
  await hive.ensureAgent({ id: 'orph', name: 'o', provider: 'claude', cwd: home }, { launch: { argv: ['claude', '--settings', path.join(orphan, 'settings.json')], env: {} }, spawnId: 'pty-1' });
  hive.markHookProvisioned('pty-1');
  assert.throws(() => hive.confirmSpawn('pty-1', { id: 'orph', provider: 'claude' }, ['claude', '--settings', path.join(orphan, 'settings.json'), '--add-dir', path.dirname(rt)], {}), /write root that was not checked/);
  assert.deepEqual(fs.readFileSync(path.join(orphan, 'notes.md')), before, 'the file is untouched');
  assert.equal(Object.hasOwn(hive.registry().agents, 'orph'), false, 'the row this call added is gone');
  const row = log().filter((r) => r.kind === 'spawn-rolled-back').at(-1);
  assert.equal(row.rowRemoved, true);
  assert.equal(row.folderLeft, undefined, 'the folder was there before; it is not this call\'s to name');
});

test('round 6: the decision is keyed per spawn; a missing or mismatched one refuses', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const L = (id) => ({ argv: ['claude', '--settings', path.join(home, 'hive', 'agents', id, 'settings.json')], env: {} });
  // Two overlapping spawns of one agent each keep their own decision.
  await hive.ensureAgent({ id: 'a1', name: 'a', provider: 'claude', cwd: home }, { launch: L('a1'), spawnId: 'pty-A' }); hive.markHookProvisioned('pty-A');
  await hive.ensureAgent({ id: 'a1', name: 'a', provider: 'claude', cwd: home }, { launch: L('a1'), spawnId: 'pty-B' }); hive.markHookProvisioned('pty-B');
  assert.doesNotThrow(() => hive.confirmSpawn('pty-A', { id: 'a1', provider: 'claude' }, L('a1').argv, {}));
  assert.doesNotThrow(() => hive.confirmSpawn('pty-B', { id: 'a1', provider: 'claude' }, L('a1').argv, {}));
  // Taken once: a second late check for the same spawn has no decision and refuses (no fail-open).
  assert.throws(() => hive.confirmSpawn('pty-A', { id: 'a1', provider: 'claude' }, L('a1').argv, {}), /no hook runtime decision was made for this spawn/);
  assert.throws(() => hive.confirmSpawn('pty-never', { id: 'a1', provider: 'claude' }, L('a1').argv, {}), /no hook runtime decision/);
  // A decision for another agent is not this one's.
  await hive.ensureAgent({ id: 'a2', name: 'b', provider: 'claude', cwd: home }, { launch: L('a2'), spawnId: 'pty-C' }); hive.markHookProvisioned('pty-C');
  assert.throws(() => hive.confirmSpawn('pty-C', { id: 'a1', provider: 'claude' }, L('a1').argv, {}), /for another agent/);
  // A provider that gets no app hook command needs no decision.
  assert.doesNotThrow(() => hive.confirmSpawn('pty-none', { id: 'g1', provider: 'gemini' }, ['gemini'], {}));
});

test('round 7 (H1): a decision is confirmable only once provisioning finished; every swallow site is covered', async (t) => {
  const { home, rt, hive, root } = floor(t);
  hive.setHookRuntime(rt);
  hive.ensureHive();
  const L = (id) => ({ argv: ['claude', '--settings', path.join(root, 'agents', id, 'settings.json')], env: {} });
  // Site index.ts ensureAgent catch: an ordinary provisioning error (a file where the inbox folder goes) is recorded and refuses, named.
  fs.mkdirSync(path.join(root, 'agents', 'blocked'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agents', 'blocked', 'inbox'), 'x');
  let err;
  try { await hive.ensureAgent({ id: 'blocked', name: 'b', provider: 'claude', cwd: home }, { launch: L('blocked'), spawnId: 'pty-gap' }); } catch (e) { err = e; }
  assert.ok(err && err.code === 'ENOTDIR', String(err));
  hive.hookProvisioningFailed('pty-gap', err);
  hive.markHookProvisioned('pty-gap'); // a mark after a recorded failure does not clear it
  assert.throws(() => hive.confirmSpawn('pty-gap', { id: 'blocked', provider: 'claude' }, L('blocked').argv, {}), /hook provisioning did not complete \(.*ENOTDIR/);
  // The injection was never applied (no mark): the decision stays unconfirmable.
  await hive.ensureAgent({ id: 'nomark', name: 'n', provider: 'claude', cwd: home }, { launch: L('nomark'), spawnId: 'pty-nomark' });
  assert.throws(() => hive.confirmSpawn('pty-nomark', { id: 'nomark', provider: 'claude' }, L('nomark').argv, {}), /hook provisioning did not complete/);
  // Site installCodexHooks / bridge catch: with a runtime set, a Codex hook config that cannot be written refuses instead of starting unhooked.
  const keep = hive.exposeCodexDataDirs;
  hive.exposeCodexDataDirs = () => { throw new Error('injected: cannot write the Codex home'); };
  t.after(() => { hive.exposeCodexDataDirs = keep; });
  assert.match(await refused(hive.ensureAgent({ id: 'cx', name: 'c', provider: 'codex', cwd: home }, { launch: { argv: ['codex -s workspace-write'], env: {} }, spawnId: 'pty-cx' })), /Codex hook config could not be written \(injected/);
  hive.exposeCodexDataDirs = keep;
  // Site copyBundledSkills catch: skills are not hooks; a failure there leaves the hook settings in place.
  await hive.ensureAgent({ id: 'sk', name: 's', provider: 'claude', cwd: home }, { launch: L('sk'), spawnId: 'pty-sk', skillsDir: path.join(home, 'no-such-skills') });
  hive.markHookProvisioned('pty-sk');
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, 'agents', 'sk', 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command.includes(rt));
  assert.doesNotThrow(() => hive.confirmSpawn('pty-sk', { id: 'sk', provider: 'claude' }, L('sk').argv, {}));
  // Site index.ts ensureClaudePermissionsAccepted swallow: it runs after the mark and only accepts a folder trust prompt.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const mark = main.indexOf('hive.markHookProvisioned(opts.id);');
  const perm = main.indexOf('try { ensureClaudePermissionsAccepted(opts.cwd); } catch');
  const late = main.indexOf('hive.confirmSpawn(opts.id');
  assert.ok(mark > 0 && perm > mark && late > perm, 'mark, then the permissions swallow, then the late check');
  assert.match(main.slice(main.indexOf('} catch (e) {', mark), late), /hive\.hookProvisioningFailed\(opts\.id, e\);/);
});

test('round 7 (H2): a late refusal removes only a row this spawn still owns — both interleavings', async (t) => {
  const { home, rt, hive, root, log } = floor(t);
  hive.setHookRuntime(rt);
  const L = { argv: ['claude', '--settings', path.join(root, 'agents', 'same', 'settings.json')], env: {} };
  const bad = [...L.argv, '--add-dir', path.dirname(rt)];
  const both = async () => {
    await hive.ensureAgent({ id: 'same', name: 's', provider: 'claude', cwd: home }, { launch: L, spawnId: 'A' }); hive.markHookProvisioned('A');
    await hive.ensureAgent({ id: 'same', name: 's', provider: 'claude', cwd: home }, { launch: L, spawnId: 'B' }); hive.markHookProvisioned('B');
  };
  // Order 1: B starts, then A's late check refuses.
  await both();
  hive.confirmSpawn('B', { id: 'same', provider: 'claude' }, L.argv, {});
  assert.throws(() => hive.confirmSpawn('A', { id: 'same', provider: 'claude' }, bad, {}), /not checked/);
  assert.equal(Object.hasOwn(hive.registry().agents, 'same'), true, 'B keeps its row');
  assert.ok(log().filter((r) => r.kind === 'spawn-rolled-back').at(-1).rowKept);
  // Order 2 (a fresh floor): A refuses before B's late check; B's row still stands and B then starts.
  const f2 = floor(t);
  f2.hive.setHookRuntime(f2.rt);
  const L2 = { argv: ['claude', '--settings', path.join(f2.root, 'agents', 'same', 'settings.json')], env: {} };
  await f2.hive.ensureAgent({ id: 'same', name: 's', provider: 'claude', cwd: f2.home }, { launch: L2, spawnId: 'A' }); f2.hive.markHookProvisioned('A');
  await f2.hive.ensureAgent({ id: 'same', name: 's', provider: 'claude', cwd: f2.home }, { launch: L2, spawnId: 'B' }); f2.hive.markHookProvisioned('B');
  assert.throws(() => f2.hive.confirmSpawn('A', { id: 'same', provider: 'claude' }, [...L2.argv, '--add-dir', path.dirname(f2.rt)], {}), /not checked/);
  assert.equal(Object.hasOwn(f2.hive.registry().agents, 'same'), true, 'the row now belongs to B');
  assert.doesNotThrow(() => f2.hive.confirmSpawn('B', { id: 'same', provider: 'claude' }, L2.argv, {}));
  // Order 3 (a fresh floor): B is decided first and starts; A wrote the row last but refuses afterwards: B has started, so the row stays.
  const f3 = floor(t);
  f3.hive.setHookRuntime(f3.rt);
  const L3 = { argv: ['claude', '--settings', path.join(f3.root, 'agents', 'same', 'settings.json')], env: {} };
  await f3.hive.ensureAgent({ id: 'same', name: 's', provider: 'claude', cwd: f3.home }, { launch: L3, spawnId: 'B' }); f3.hive.markHookProvisioned('B');
  await f3.hive.ensureAgent({ id: 'same', name: 's', provider: 'claude', cwd: f3.home }, { launch: L3, spawnId: 'A' }); f3.hive.markHookProvisioned('A');
  f3.hive.confirmSpawn('B', { id: 'same', provider: 'claude' }, L3.argv, {});
  assert.throws(() => f3.hive.confirmSpawn('A', { id: 'same', provider: 'claude' }, [...L3.argv, '--add-dir', path.dirname(f3.rt)], {}), /not checked/);
  assert.equal(Object.hasOwn(f3.hive.registry().agents, 'same'), true, 'a later spawn has started: the row stays');
  // Alone: the row A added, and still owns, is removed.
  await hive.ensureAgent({ id: 'solo', name: 's', provider: 'claude', cwd: home }, { launch: { argv: ['claude', '--settings', path.join(root, 'agents', 'solo', 'settings.json')], env: {} }, spawnId: 'S' }); hive.markHookProvisioned('S');
  assert.throws(() => hive.confirmSpawn('S', { id: 'solo', provider: 'claude' }, ['claude', '--settings', path.join(root, 'agents', 'solo', 'settings.json'), '--add-dir', path.dirname(rt)], {}), /not checked/);
  assert.equal(Object.hasOwn(hive.registry().agents, 'solo'), false);
});

test('round 7 (M): any date, time or non-finite value anywhere is not understood — expected verdicts hard-coded, not from the parser', async (t) => {
  const L = loadTs('src/main/launchLine.ts');
  const cases = [
    ['sandbox_mode = "workspace-write"\nhistory_date = 2020-02-30\n', 'unknown', 'history_date'],
    ['x = 1979-05-27T07:32:00Z\n', 'unknown', 'x'],
    ['x = 1979-05-27T07:32:00\n', 'unknown', 'x'],
    ['x = 1979-05-27\n', 'unknown', 'x'],
    ['x = 07:32:00\n', 'unknown', 'x'],
    ['f = inf\n', 'unknown', 'f'],
    ['f = -inf\n', 'unknown', 'f'],
    ['f = nan\n', 'unknown', 'f'],
    ['[a.b]\nd = [1, 1979-05-27]\n', 'unknown', 'a.b.d[1]'],
    ['m = { when = 1979-05-27 }\n', 'unknown', 'm.when'],
    ['[tui]\nn = 1.5\nm = -0.0\ni = 42\nb = true\ns = "1979-05-27"\n', 'ok', null],
  ];
  for (const [text, state, key] of cases) {
    const r = L.codexRoots(text);
    assert.equal(r.state, state, JSON.stringify(text));
    if (key) assert.ok(r.why.startsWith(`${key} is a value the app does not read`), r.why);
  }
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\nhistory_date = 2020-02-30\n');
  assert.match(await refused(hive.ensureAgent({ id: 'd1', name: 'd', provider: 'codex', cwd: home }, { launch: { argv: ['codex'], env: {} } })), /history_date is a value the app does not read/);
});

test('round 8 (N1): any sandbox/permission/profile/writable_roots key the decoder does not read refuses — Codex permission profiles included', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  let n = 0;
  const spawn = (argv) => hive.ensureAgent({ id: `p${n++}`, name: 'p', provider: 'codex', cwd: home }, { launch: { argv, env: {} } });
  // Her probes: the config selects a permission profile that outranks sandbox_mode.
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\ndefault_permissions = ":danger-full-access"\n');
  assert.match(await refused(spawn(['codex'])), /default_permissions is not on the list this app version understands \(Codex 0\.162-0\.167\)/);
  assert.match(await refused(spawn(['codex -s workspace-write'])), /default_permissions/, 'with or without -s');
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n[permissions.wide.filesystem]\nwrite = ["/"]\n');
  assert.match(await refused(spawn(['codex'])), /permissions is not on the list/);
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n');
  assert.match(await refused(spawn(['codex', '-c', 'default_permissions=":danger-full-access"'])), /option -c is not on the list/);
  // A made-up future key in the family is refused too.
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\npermissions_v2 = { mode = "open" }\n');
  assert.match(await refused(spawn(['codex'])), /permissions_v2/);
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n[profiles.x]\ndefault_permissions = ":read-only"\n');
  assert.match(await refused(spawn(['codex'])), /profiles is not on the list/);
  // Names that are identifiers (a project path, a server) are not keys; profiles and unread sandbox_workspace_write keys are off the list.
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n[projects."/Users/me/profile"]\ntrust_level = "trusted"\n[mcp_servers.profiler]\ncommand = "p"\n');
  await spawn(['codex']);
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n[profiles.sandboxed]\nmodel = "m"\n');
  assert.match(await refused(spawn(['codex'])), /profiles is not on the list/);
  // network_access is about the network, not the writable set: read as allowed.
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = true\n');
  await spawn(['codex']);
});

test('prep r7: the key-family test applies only where Codex reads policy; her false refusals start, every policy form still refuses', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  let n = 0;
  const spawn = (argv) => hive.ensureAgent({ id: `q${n++}`, name: 'q', provider: 'codex', cwd: home }, { launch: { argv, env: {} } });
  const base = 'sandbox_mode = "workspace-write"\n';
  const fine = [
    'include_permissions_instructions = true\n', '[mcp_servers.x.env]\nAWS_PROFILE = "a"\n', '[shell_environment_policy.set]\nAWS_PROFILE = "a"\n',
    '[mcp_servers.x.tools.get_user_profile]\nenabled = true\n', '[mcp_servers.x.http_headers]\n"X-Profile" = "v"\n',
    // The owner's own config may carry hooks: allowed, not read.
    '[[hooks.Stop]]\npermission_mode = "x"\n',
  ];
  for (const f of fine) { fs.writeFileSync(cfg, base + f); await spawn(['codex']); }
  // agents.*, plugins.* and apps.* are off the versioned allowlist (agents can load a whole config; plugins carry hooks).
  for (const [f, key] of [['[agents.profile-reviewer]\ndescription = "d"\n', 'agents'], ['[agents.sandbox_auditor]\ndescription = "d"\n', 'agents'], ['[plugins."permission-helper@m"]\nenabled = true\n', 'plugins'], ['[plugins.profiler]\nenabled = true\n', 'plugins'], ['[apps.sandbox_app]\nenabled = true\n', 'apps']]) {
    fs.writeFileSync(cfg, base + f); assert.match(await refused(spawn(['codex'])), new RegExp(`${key} is not on the list`), f);
  }
  const bad = [
    ['default_permissions = ":danger-full-access"\n', /default_permissions/], ['permissions_v2 = 1\n', /permissions_v2/], ['[permissions.wide.filesystem]\nwrite = ["/"]\n', /permissions/],
    ['[profiles.x]\ndefault_permissions = "r"\n', /profiles is not on the list/], ['[projects."/x"]\nsandbox_mode = "danger-full-access"\n', /projects\.\/x\.sandbox_mode is not on the list/],
    ['[windows]\nsandbox = "elevated"\n', /windows is not on the list/], ['[agents.a]\nconfig_file = "other.toml"\n', /agents is not on the list/],
  ];
  for (const [f, why] of bad) { fs.writeFileSync(cfg, base + f); assert.match(await refused(spawn(['codex'])), why, f); }
  // Any -c refuses: the app builds none.
  fs.writeFileSync(cfg, base);
  for (const k of ['default_permissions=":danger-full-access"', 'projects."/x".sandbox_mode="danger-full-access"', 'agents.a.config_file="x"', 'windows.sandbox="x"', 'mcp_servers.x.env.AWS_PROFILE="a"', 'include_permissions_instructions=true']) assert.match(await refused(spawn(['codex', '-c', k])), /option -c is not on the list this app version understands \(Codex 0\.162-0\.167\)/, k);
  // Memory and knowledge settings are read outside the hook provisioning try.
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const tryAt = main.indexOf('const inj = await hive.ensureAgent(');
  const block = main.slice(tryAt, main.indexOf('hive.markHookProvisioned(opts.id);', tryAt));
  assert.doesNotMatch(block, /memory\.env\(\)|knowledge\.env\(\)/, 'no env() call inside the provisioning try');
  assert.match(main.slice(main.lastIndexOf('if (opts.hive && hive.enabled()) {', tryAt), tryAt), /try \{ memEnv = memory\.env\(\); \} catch[\s\S]*try \{ kgEnv = knowledge\.env\(\); \} catch/);
});

test('fix r7: allow_symlinked_codex_home refuses unless false, in config or on -c', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  let n = 0;
  const spawn = (argv) => hive.ensureAgent({ id: `s${n++}`, name: 's', provider: 'codex', cwd: home }, { launch: { argv, env: {} } });
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\nallow_symlinked_codex_home = true\n');
  assert.match(await refused(spawn(['codex -s workspace-write'])), /allow_symlinked_codex_home/);
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\nallow_symlinked_codex_home = false\n');
  await spawn(['codex -s workspace-write']);
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\n');
  // Any -c refuses now, false included.
  for (const v of ['true', 'false']) assert.match(await refused(spawn(['codex -s workspace-write', '-c', `allow_symlinked_codex_home=${v}`])), /option -c is not on the list/);
  fs.writeFileSync(cfg, 'sandbox_mode = "workspace-write"\nfollow_symlinks = true\n');
  assert.match(await refused(spawn(['codex -s workspace-write'])), /follow_symlinks/);
});

test('versioned allowlist: owner config with hooks starts, project hooks refuse, only app-emitted flags start', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const user = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(user), { recursive: true });
  const proj = path.join(home, 'work');
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });
  let n = 0;
  const spawn = (argv, cwd = home) => hive.ensureAgent({ id: `v${n++}`, name: 'v', provider: 'codex', cwd }, { launch: { argv, env: {} } });
  // The owner's real config shape, with its own hooks: allowed, hooks not read.
  fs.writeFileSync(user, 'model = "gpt"\nmodel_reasoning_effort = "high"\nsandbox_mode = "workspace-write"\n[projects."/x"]\ntrust_level = "trusted"\n[features]\nmulti_agent = true\n[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "owner"\n');
  await spawn(['codex']);
  // The same hooks in a project config where the seat works: refused, named.
  fs.writeFileSync(path.join(proj, '.codex', 'config.toml'), '[[hooks.Stop]]\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "x"\n');
  assert.match(await refused(spawn(['codex'], proj)), /hooks in a project config is not on the list this app version understands \(Codex 0\.162-0\.167\)/);
  // Each reader takes the file's kind on its own: the roots reader (a launch line with -s does not consult the mode) ...
  assert.match(await refused(spawn(['codex -s workspace-write'], proj)), /hooks in a project config is not on the list/);
  // ... and the mode reader, asked directly.
  assert.match(hive.codexConfigMode(proj).refuse, /hooks in a project config is not on the list/);
  assert.equal(hive.codexConfigMode(home).mode, 'workspace-write', 'the owner config\'s hooks do not stop its mode being read');
  // Flags: what the app emits starts; anything else refuses.
  for (const a of [['--dangerously-bypass-hook-trust'], ['--model', 'gpt'], ['--enable', 'multi_agent']]) await spawn(['codex -a never -s workspace-write', ...a]);
  for (const a of [['--approve-for-me'], ['--enable', 'hooks'], ['--disable', 'plugins'], ['-m', 'gpt'], ['--strict-config']]) assert.match(await refused(spawn(['codex -a never -s workspace-write', ...a])), /not on the list this app version understands/, a.join(' '));
});

test('auto mode off: every production builder\'s line gets the config\'s own sandbox mode, workspace-write only when none is set', async (t) => {
  const { buildSpawnCommand } = loadTs('src/renderer/src/store/config.ts');
  const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');
  const { tokenizeCommand } = loadTs('src/shared/commandLine.ts');
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const cfg = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(cfg), { recursive: true });
  const owner = 'model = "gpt"\nmodel_reasoning_effort = "high"\n[projects."/x"]\ntrust_level = "trusted"\n[features]\nmulti_agent = true\n';
  const lines = (autoMode) => [
    ...[undefined, 'gpt-x'].map((model) => ['gui', buildSpawnCommand({ defaultCommand: 'claude', autoMode }, model, 'codex')]),
    ...[{}, { requestModel: 'gpt-x' }, { requestCommand: 'codex -a untrusted' }].map((over) => { const w = buildWorkerLaunch({ autoMode, requestProvider: 'codex', ...over }); return ['worker', [w.command, ...w.args].join(' ')]; })
  ];
  let n = 0;
  // The spawn core's one function, on each builder's line exactly as built.
  const run = async (line) => {
    const words = tokenizeCommand(line);
    const args = hive.withCodexSandboxStance(words.slice(1), home);
    const launch = { argv: [words[0], ...args], env: {} };
    return { args, start: () => hive.ensureAgent({ id: `b${n++}`, name: 'b', provider: 'codex', cwd: home }, { launch }) };
  };
  const cases = [
    ['no mode (the owner\'s real config)', owner, 'workspace-write'],
    ['read-only', 'sandbox_mode = "read-only"\n' + owner, 'read-only'],
    ['workspace-write', 'sandbox_mode = "workspace-write"\n' + owner, 'workspace-write'],
  ];
  for (const [name, text, mode] of cases) {
    fs.writeFileSync(cfg, text);
    for (const [who, line] of lines(false)) {
      assert.doesNotMatch(line, /(^| )-(s|a never)( |$)/, `${who}: the builder itself states no sandbox and no -a`);
      const r = await run(line);
      assert.equal(r.args[r.args.indexOf('-s') + 1], mode, `${name}, ${who}: ${r.args.join(' ')}`);
      await r.start();
    }
  }
  // Full access or a config not understood: the line is left as it is, and the check refuses it, saying why.
  for (const [text, why] of [['sandbox_mode = "danger-full-access"\n' + owner, /sets sandbox_mode = "danger-full-access"/], ['profile = "x"\n' + owner, /could not be understood \(profile is not on the list/]]) {
    fs.writeFileSync(cfg, text);
    for (const [who, line] of lines(false)) {
      const r = await run(line);
      assert.ok(!r.args.includes('-s'), `${who}: no flag added`);
      assert.match(await refused(r.start()), why);
    }
  }
  // Auto mode on: the line already states its sandbox and is unchanged.
  fs.writeFileSync(cfg, 'sandbox_mode = "read-only"\n' + owner);
  for (const [who, line] of lines(true)) {
    const words = tokenizeCommand(line);
    const out = hive.withCodexSandboxStance(words.slice(1), home);
    if (words.includes('-s')) assert.deepEqual(out, words.slice(1), `${who}: a stated sandbox is unchanged: ${line}`);
    else assert.equal(out[out.indexOf('-s') + 1], 'read-only', `${who}: a request that chose approvals only still gets the config's mode: ${line}`);
  }
  // Placement: before any prompt, after resume <session>; a stated sandbox is kept.
  fs.writeFileSync(cfg, owner);
  assert.deepEqual(hive.withCodexSandboxStance(['resume', 'sid', 'go'], home), ['resume', 'sid', '-s', 'workspace-write', 'go']);
  assert.deepEqual(hive.withCodexSandboxStance(['--sandbox=read-only'], home), ['--sandbox=read-only']);
  // Settings says what auto mode off now means for a Codex seat, in every shipped language.
  for (const l of ['en', 'ar', 'zh-CN']) {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'i18n', 'locales', `${l}.json`), 'utf8'));
    const off = Object.values(t).map((x) => x && x.autoOff).find((v) => typeof v === 'string' && v.includes('workspace-write'))
      ?? JSON.stringify(t).match(/"autoOff":"([^"]*workspace-write[^"]*)"/)?.[1];
    assert.ok(off && /Codex/.test(off), `${l}: the auto-off text names Codex's sandbox (workspace-write when no config sets one)`);
  }
  // A stance carried in the executable string itself is kept, never doubled.
  for (const cmd of ['codex -s read-only', 'codex --sandbox=read-only', 'codex --full-auto']) assert.deepEqual(hive.withCodexSandboxStance(['--model', 'x'], home, cmd), ['--model', 'x'], cmd);
  assert.deepEqual(hive.withCodexSandboxStance(['--model', 'x'], home, 'codex -a untrusted'), ['-s', 'workspace-write', '--model', 'x'], 'approvals only in the string: the sandbox is still named');
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  const at = main.search(/^  if \(opts\.hive && provider === 'codex' && hive\.enabled\(\)\) opts\.args = hive\.withCodexSandboxStance\(opts\.args \?\? \[\], opts\.cwd, opts\.command\);$/m);
  assert.ok(at > 0 && at < main.indexOf('const inj = await hive.ensureAgent('), 'the spawn core applies it, live, before the check');
});

test('tables that name a program Codex runs outside its sandbox: allowed in the owner config, refused in a project config', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  const user = path.join(home, '.codex', 'config.toml');
  fs.mkdirSync(path.dirname(user), { recursive: true });
  const proj = path.join(home, 'work');
  fs.mkdirSync(path.join(proj, '.codex'), { recursive: true });
  let n = 0;
  const spawn = (cwd) => hive.ensureAgent({ id: `m${n++}`, name: 'm', provider: 'codex', cwd }, { launch: { argv: ['codex -s workspace-write'], env: {} } });
  const tables = ['[mcp_servers.x]\ncommand = "/bin/p"\nargs = ["a"]\n', 'notify = ["/bin/n"]\n', '[model_providers.p.auth]\ncommand = "/bin/tok"\n', '[model_providers.p.aws.credential_export]\ncommand = "/bin/c"\n'];
  for (const tb of tables) {
    fs.writeFileSync(user, tb);
    fs.rmSync(path.join(proj, '.codex', 'config.toml'), { force: true });
    await spawn(proj); // the owner's own: allowed, not read
    fs.writeFileSync(user, '');
    fs.writeFileSync(path.join(proj, '.codex', 'config.toml'), tb);
    assert.match(await refused(spawn(proj)), /in a project config \(Codex runs the program it names outside its sandbox\) is not on the list this app version understands/, tb);
  }
});

test('a Claude seat whose generated settings carry enabledPlugins passes the spawn check and the late check', async (t) => {
  const { home, rt, hive } = floor(t);
  hive.setHookRuntime(rt);
  // The owner's own settings enable plugins, as on the floor; the generated settings name every one of them.
  const userDir = path.join(home, '.claude');
  fs.mkdirSync(userDir, { recursive: true });
  fs.writeFileSync(path.join(userDir, 'settings.json'), JSON.stringify({ enabledPlugins: { 'superpowers@claude-plugins-official': true, 'terraform@claude-plugins-official': true } }));
  const id = 'pl1';
  const dir = path.join(home, 'hive', 'agents', id);
  const argv = ['claude', '--settings', path.join(dir, 'settings.json')];
  const inj = await hive.ensureAgent({ id, name: 'p', provider: 'claude', cwd: home }, { launch: { argv, env: {} }, spawnId: 's-pl1' });
  const settings = JSON.parse(fs.readFileSync(inj.args[inj.args.indexOf('--settings') + 1], 'utf8'));
  assert.deepEqual(settings.enabledPlugins, { 'superpowers@claude-plugins-official': true, 'terraform@claude-plugins-official': false });
  hive.markHookProvisioned('s-pl1');
  assert.doesNotThrow(() => hive.confirmSpawn('s-pl1', { id, provider: 'claude' }, [...argv, ...inj.args.filter((a, i, all) => a !== '--settings' && all[i - 1] !== '--settings')], {}));
});
