'use strict';

/**
 * The launcher runs every hook and helper through the app's own binary. A dev build's binary lives in node_modules, so
 * losing that install would stop every agent's hooks at once, including the ones needed to recover. With the binary
 * gone the launcher now looks for a real node. These run the generated script under a real /bin/sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { nodeLauncherScript } = loadTs('src/main/nodeLauncher.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const POSIX = process.platform !== 'win32';

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-launcher-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fake = (rel, label) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `#!/bin/sh\necho "${label}:ERAN=$ELECTRON_RUN_AS_NODE:$*"\nexit 7\n`, { mode: 0o755 });
    return file;
  };
  const run = (exe, env, ...args) => {
    const launcher = path.join(dir, 'bin', 'hive-node');
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, nodeLauncherScript(exe, 'darwin', path.join(dir, 'bin', 'runtime', 'node')), { mode: 0o755 });
    return spawnSync('/bin/sh', [launcher, ...args], { env: { PATH: '/usr/bin:/bin', HOME: path.join(dir, 'home'), ...env }, encoding: 'utf8' });
  };
  return { dir, fake, run, missing: path.join(dir, 'gone', 'Electron') };
}

test('the app\'s binary is used, as node, whenever it exists', { skip: !POSIX }, (t) => {
  const { fake, run } = setup(t);
  const exe = fake('app/My App/Electron', 'bundled');
  const onPath = fake('path/node', 'path');
  const r = run(exe, { PATH: `${path.dirname(onPath)}:/usr/bin:/bin` }, 'script.cjs', 'an arg');
  assert.equal(r.stdout.trim(), 'bundled:ERAN=1:script.cjs an arg');
  assert.equal(r.status, 7, 'its exit code is the launcher\'s');
});

test('with the binary gone, a node on PATH runs the script, not as Electron', { skip: !POSIX }, (t) => {
  const { fake, run, missing } = setup(t);
  const onPath = fake('path/node', 'path');
  const r = run(missing, { PATH: `${path.dirname(onPath)}:/usr/bin:/bin` }, 'script.cjs', 'an arg');
  assert.equal(r.stdout.trim(), 'path:ERAN=:script.cjs an arg');
  assert.equal(r.status, 7);
});

// Hooks run with a bare PATH, which is what the launcher exists for.
test('with the binary gone and a bare PATH, the mise node is found through HOME', { skip: !POSIX }, (t) => {
  const { fake, run, missing } = setup(t);
  fake('home/.local/share/mise/shims/node', 'mise');
  const r = run(missing, {}, 'script.cjs');
  assert.equal(r.stdout.trim(), 'mise:ERAN=:script.cjs');
});

// The runtime shim is on an agent's PATH and wraps the same missing binary.
test('the app\'s own runtime shim on PATH is passed over, or the fallback would die on it', { skip: !POSIX }, (t) => {
  const { dir, fake, run, missing } = setup(t);
  fake('bin/runtime/node', 'runtime-shim');
  fake('home/.local/share/mise/shims/node', 'mise');
  const r = run(missing, { PATH: `/usr/bin:/bin:${path.join(dir, 'bin', 'runtime')}` }, 'script.cjs');
  assert.equal(r.stdout.trim(), 'mise:ERAN=:script.cjs');
});

test('with no node anywhere it says what is missing and exits 127', { skip: !POSIX }, (t) => {
  const { run, missing } = setup(t);
  const r = run(missing, {}, 'script.cjs');
  assert.equal(r.status, 127);
  assert.match(r.stderr, /no node/i);
  assert.ok(r.stderr.includes(missing), 'and names the binary it expected');
});

test('the Windows launcher checks the binary and falls back to node on PATH', () => {
  const body = nodeLauncherScript('C:\\App\\app.exe', 'win32', 'C:\\h\\bin\\runtime\\node.cmd');
  assert.match(body, /^@echo off\r\n/);
  assert.match(body, /if not exist "C:\\App\\app\.exe" goto /);
  assert.match(body, /set ELECTRON_RUN_AS_NODE=1\r\n"C:\\App\\app\.exe" %\*\r\nexit \/b %errorlevel%/);
  assert.match(body, /\r\nnode %\*\r\n/);
});

test('the hive writes this launcher, and the app\'s binary survives in it', { skip: !POSIX }, async (t) => {
  const { dir } = setup(t);
  const hive = new HiveManager(() => dir);
  await hive.ensureAgent({ id: 'a1', name: 'A', provider: 'claude', cwd: dir });
  const launcher = path.join(dir, 'hive', 'bin', 'hive-node');
  const r = spawnSync(launcher, ['-e', 'process.stdout.write(String(1 + 1))'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(r.stdout, '2');
  assert.equal(fs.readFileSync(launcher, 'utf8'), nodeLauncherScript(process.execPath, process.platform, path.join(dir, 'hive', 'bin', 'runtime', 'node')));
});
