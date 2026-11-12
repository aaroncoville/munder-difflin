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
  assert.match(await refused(hive.ensureAgent({ id: 'x2', name: 'X', provider: 'codex', cwd: home })), /through \/ \(/, 'a dotted key is read, and / reaches everything');
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
  const forms = [
    [above, `[sandbox_workspace_write]\nwritable_roots = [${JSON.stringify(app)}]\n`, 'a project config above the cwd'],
    [here, `sandbox_workspace_write.writable_roots = [${JSON.stringify(app)}]\n`, 'a dotted key in the cwd'],
    [here, `sandbox_workspace_write = { writable_roots = [${JSON.stringify(app)}] }\n`, 'an inline table'],
    [here, `[profiles.fast.sandbox_workspace_write]\nwritable_roots = ['${app}']\n`, 'a profile, literal string'],
    [here, `[sandbox_workspace_write]\nwritable_roots = [\n  "/elsewhere",\n  ${JSON.stringify(app)}, # mine\n]\n`, 'a multi-line array'],
  ];
  let i = 0;
  for (const [file, text, why] of forms) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const msg = await refused(hive.ensureAgent({ id: `x${i++}`, name: 'X', provider: 'codex', cwd: work }));
    assert.ok(msg.includes(file) && msg.includes(app), `${why}: ${msg}`);
    fs.rmSync(file);
  }
  for (const [text, why] of [['writable_roots = some_var\n', 'not an array'], ['writable_roots = ["/a"\n', 'broken'], ['writable_roots = [1]\n', 'not text']]) {
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
    ['f1', 'claude', claudeLaunch(dir('f1'), ['--weird']), /option the app does not model/],
    ['f2', 'claude', claudeLaunch(dir('f2'), ['--settings', '/tmp/other.json']), /option the app does not model/],
    ['f3', 'codex', codexLaunch(['-p', 'fast']), /option the app does not model/],
    ['f4', 'codex', { argv: ['codex -a never'], env: {} }, /does not choose a Codex sandbox/],
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
  await hive.ensureAgent({ id: 'n2', name: 'n2', provider: 'claude', cwd: home }, { launch: claudeLaunch(dir('n2')) });
  assert.ok(fs.existsSync(dir('n2')) && Object.hasOwn(hive.registry().agents, 'n2'));
  assert.throws(() => hive.confirmHookLaunch(hive.takeHookVerdict('n2'), claudeLaunch(dir('n2'), ['--add-dir', app]).argv, {}), /write root that was not checked/);
  assert.equal(fs.existsSync(dir('n2')), false, 'folder rolled back');
  assert.equal(Object.hasOwn(hive.registry().agents, 'n2'), false, 'row rolled back');
  assert.ok(log().some((r) => r.kind === 'spawn-rolled-back' && r.agentId === 'n2' && r.removed === true));
  // A final environment that moves Claude's settings refuses too; an EXISTING agent keeps its row and folder.
  await hive.ensureAgent({ id: 'n1', name: 'n1', provider: 'claude', cwd: home }, { launch: claudeLaunch(dir('n1')) });
  assert.throws(() => hive.confirmHookLaunch(hive.takeHookVerdict('n1'), claudeLaunch(dir('n1')).argv, { CLAUDE_CONFIG_DIR: base }), /moved Claude's settings/);
  assert.ok(fs.existsSync(dir('n1')) && Object.hasOwn(hive.registry().agents, 'n1'), 'an existing agent is not removed');
  // A final launch line that is a wrapper, or drops the Codex sandbox, refuses.
  await hive.ensureAgent({ id: 'x1', name: 'x1', provider: 'codex', cwd: home }, { launch: codexLaunch() });
  const v = hive.takeHookVerdict('x1');
  assert.throws(() => hive.confirmHookLaunch({ ...v, isNew: false }, ['codex -a never'], {}), /does not keep the Codex sandbox/);
  assert.throws(() => hive.confirmHookLaunch({ ...v, isNew: false }, ['sh -c codex'], {}), /does not run codex itself/);
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
  const late = main.indexOf('hive.confirmHookLaunch(hive.takeHookVerdict(opts.hive.id)');
  const spawnAt = main.indexOf('const res = ptyManager.spawn(opts, owner);');
  assert.ok(late > 0 && late < spawnAt, 'the late check runs before the PTY spawns');
  assert.match(main.slice(late, spawnAt), /instanceof HookRuntimeUnavailable\) return refuseSpawn\(/);
});
