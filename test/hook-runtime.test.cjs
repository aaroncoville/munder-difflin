'use strict';
// Claude and Codex hooks run outside the agent's sandbox. Their command must load the
// shim from the app's resources and the node launcher from the app's own data folder,
// never from the hive folder, which every agent can write: a rewritten hive/bin shim
// would otherwise run unsandboxed in every new session.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const SHIM = path.join(__dirname, '..', 'resources', 'cth-hook.cjs');
const POSIX = process.platform !== 'win32';

/** A short base under /tmp (socket paths are length-limited), with HOME jailed into it. */
function floor(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(POSIX ? '/tmp' : os.tmpdir(), 'mdhr-')));
  const home = path.join(base, 'h');
  const appData = path.join(base, 'app');
  fs.mkdirSync(home);
  const realHome = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.equal(os.homedir(), home);
  const hive = new HiveManager(() => home);
  return { base, home, appData, hive, root: path.join(home, 'hive') };
}

function run(cmd, env, payload) {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.on('error', () => { /* the shim may exit first */ });
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
    conn.write(JSON.stringify({}) + '\n', () => conn.end());
  });
  server.on('error', () => {});
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  return received;
}

const tomlCommands = (config) => [...config.matchAll(/^command\s*=\s*(.+)$/gm)].map((m) => JSON.parse(m[1].trim()));
const claudeCommands = (settings) => [
  ...Object.values(settings.hooks).flatMap((ms) => ms.flatMap((m) => m.hooks.map((h) => h.command))),
  settings.statusLine.command,
];

test('the shipped shim is the same program the hive/bin copy has always been', (t) => {
  const { hive, root } = floor(t);
  hive.ensureHive();
  assert.equal(fs.readFileSync(SHIM, 'utf8'), fs.readFileSync(path.join(root, 'bin', 'cth-hook.cjs'), 'utf8'));
  // Packaged builds resolve it under process.resourcesPath, so the build must ship it there.
  const builder = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  assert.match(builder, /^\s*- from: resources\/cth-hook\.cjs\n\s*to: cth-hook\.cjs$/m);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8');
  assert.match(main, /hive\.setHookRuntime\(\s*bundledResourcePath\('cth-hook\.cjs'/);
});

test('a new Claude session and a new Codex session fire hooks through the app paths, never hive/bin', { skip: !POSIX, timeout: 20_000 }, async (t) => {
  const { home, appData, hive, root } = floor(t);
  hive.ensureHive();
  hive.setHookRuntime(SHIM, path.join(appData, 'hook-runtime'));
  const launcher = path.join(appData, 'hook-runtime', 'hive-node');
  assert.ok(fs.statSync(launcher).mode & 0o111, 'the launcher is executable');

  await hive.ensureAgent({ id: 'c1', name: 'C', provider: 'claude', cwd: home });
  const claude = claudeCommands(JSON.parse(fs.readFileSync(path.join(root, 'agents/c1/settings.json'), 'utf8')));
  const codexHome = hive.installCodexHooks(path.join(root, 'agents/x1'), home, 'x1');
  const codex = tomlCommands(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8'));
  assert.equal(codex.length, 8);
  const expected = `"${launcher}" "${SHIM}"`;
  for (const c of claude) assert.ok(c === expected || c === `${expected} --status`, c);
  for (const c of codex) assert.equal(c, expected);
  for (const c of [...claude, ...codex]) assert.ok(!c.includes(root), `a hook command names the hive folder: ${c}`);

  // A tampered hive/bin shim must not be what runs.
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

test('without app paths, or with unusable ones, hooks keep loading from hive/bin', async (t) => {
  const { home, appData, hive, root } = floor(t);
  hive.ensureHive();
  const legacy = path.join(root, 'bin', 'cth-hook.cjs');
  const commandOf = async (id) => {
    await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
    return JSON.parse(fs.readFileSync(path.join(root, 'agents', id, 'settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command;
  };
  assert.ok((await commandOf('n0')).includes(legacy), 'no runtime set');
  const cases = [
    ['relative shim', 'resources/cth-hook.cjs', path.join(appData, 'rt')],
    ['relative launcher dir', SHIM, 'rt'],
    ['missing shim', path.join(appData, 'nope.cjs'), path.join(appData, 'rt')],
    ['launcher dir inside the hive', SHIM, path.join(root, 'bin', 'rt')],
    ['launcher dir is the hive', SHIM, root],
  ];
  let i = 1;
  for (const [why, shim, dir] of cases) {
    hive.setHookRuntime(SHIM, path.join(appData, 'ok'));
    hive.setHookRuntime(shim, dir);
    assert.ok((await commandOf(`n${i++}`)).includes(legacy), why);
  }
  const inside = path.join(root, 'agents', 'evil.cjs');
  fs.copyFileSync(SHIM, inside);
  hive.setHookRuntime(inside, path.join(appData, 'rt'));
  assert.ok((await commandOf('n9')).includes(legacy), 'a shim inside the hive is refused');
  assert.equal(fs.existsSync(path.join(root, 'bin', 'rt')), false, 'nothing is written into the hive for a refused runtime');
});
