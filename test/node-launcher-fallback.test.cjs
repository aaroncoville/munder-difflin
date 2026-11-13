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
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { nodeLauncherScript } = loadTs('src/main/nodeLauncher.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const POSIX = process.platform !== 'win32';

function setup(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-launcher-')));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(dir, { recursive: true, force: true }); });
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

// ---- Windows ----
// This walks the generated script's own lines, so a change to its flow changes the result. It knows cmd.exe's control
// flow, not its quoting, and throws on any line it does not recognise. The real cmd.exe test below covers the rest
// wherever these tests run on Windows.
function runBatch(script, { exists = [], where = [], env = {} }) {
  const vars = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', ...env };
  const lines = script.split('\r\n').filter(Boolean);
  const out = { ran: null, ranWith: null, exit: null, stderr: '' };
  const label = (name) => { const at = lines.indexOf(`:${name}`); assert.notEqual(at, -1, `no label ${name}`); return at; };
  const expand = (line) => line.replace(/%(LOCALAPPDATA|ProgramFiles|FOUND_NODE)%/g, (_, v) => vars[v] ?? '');
  for (let at = 0; at < lines.length; at++) {
    const line = expand(lines[at]);
    let m;
    if (line === '@echo off' || line.startsWith(':')) continue;
    if ((m = line.match(/^if not exist "([^"]+)" goto (\w+)$/))) { if (!exists.includes(m[1])) at = label(m[2]); continue; }
    if ((m = line.match(/^set (\w+)=(.*)$/))) { vars[m[1]] = m[2]; continue; }
    if ((m = line.match(/^for \/f "delims=" %%N in \('where node 2\^>nul'\) do if \/i not "%%~fN"=="([^"]+)" \(set "(\w+)=%%~fN" & goto (\w+)\)$/))) {
      const hit = where.find((candidate) => candidate.toLowerCase() !== m[1].toLowerCase());
      if (hit !== undefined) { vars[m[2]] = hit; at = label(m[3]); }
      continue;
    }
    if ((m = line.match(/^if exist "([^"]+)" \(set "(\w+)=([^"]+)" & goto (\w+)\)$/))) {
      if (exists.includes(m[1])) { vars[m[2]] = m[3]; at = label(m[4]); }
      continue;
    }
    if ((m = line.match(/^"([^"]+)" %\*$/))) { out.ran = m[1]; out.ranWith = vars.ELECTRON_RUN_AS_NODE; vars.errorlevel = '7'; continue; }
    if ((m = line.match(/^echo (.*) 1>&2$/))) { out.stderr = m[1]; continue; }
    if ((m = line.match(/^exit \/b (\S+)$/))) { out.exit = m[1] === '%errorlevel%' ? vars.errorlevel : m[1]; return out; }
    throw new Error(`a line this does not know: ${line}`);
  }
  throw new Error('the script ran off its end');
}

const WIN_EXE = 'C:\\Program Files (x86)\\App\\app.exe';
const WIN_SHIM = 'C:\\h\\bin\\runtime\\node.cmd';
const WIN_REAL = 'C:\\tools\\node\\node.exe';
const WIN_MISE = 'C:\\Users\\u\\AppData\\Local\\mise\\shims\\node.exe';
const WIN_PF = 'C:\\Program Files\\nodejs\\node.exe';
const winScript = () => nodeLauncherScript(WIN_EXE, 'win32', WIN_SHIM);

test('Windows: the app\'s binary runs as node whenever it exists', () => {
  const r = runBatch(winScript(), { exists: [WIN_EXE], where: [WIN_REAL] });
  assert.deepEqual([r.ran, r.ranWith, r.exit], [WIN_EXE, '1', '7']);
});

test('Windows: with the binary gone, a real node on PATH runs the script, not as Electron', () => {
  const r = runBatch(winScript(), { where: [WIN_REAL] });
  assert.deepEqual([r.ran, r.ranWith, r.exit], [WIN_REAL, undefined, '7']);
});

for (const [label, where] of [
  ['first on PATH', [WIN_SHIM, WIN_REAL]],
  ['in another case', [WIN_SHIM.toUpperCase(), WIN_REAL]]
]) {
  test(`Windows: the app's runtime shim is passed over when it is ${label}`, () => {
    assert.equal(runBatch(winScript(), { where }).ran, WIN_REAL);
  });
}

test('Windows: with only the runtime shim on PATH, the known locations are tried in order', () => {
  assert.equal(runBatch(winScript(), { where: [WIN_SHIM], exists: [WIN_MISE, WIN_PF] }).ran, WIN_MISE);
  assert.equal(runBatch(winScript(), { where: [WIN_SHIM], exists: [WIN_PF] }).ran, WIN_PF);
});

test('Windows: with only the runtime shim and nothing else, it says what is missing and exits 127', () => {
  const r = runBatch(winScript(), { where: [WIN_SHIM] });
  assert.equal(r.ran, null, 'the shim wraps the same missing binary');
  assert.equal(r.exit, '127');
  assert.match(r.stderr, /no node/i);
  assert.ok(r.stderr.includes(WIN_EXE));
});

test('Windows, under real cmd.exe: the shim is skipped and a real node runs', { skip: POSIX }, (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md launcher ('));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(dir, { recursive: true, force: true }); });
  const shimDir = path.join(dir, 'runtime');
  const realDir = path.join(dir, 'real');
  fs.mkdirSync(shimDir);
  fs.mkdirSync(realDir);
  fs.writeFileSync(path.join(shimDir, 'node.cmd'), '@echo shim\r\n@exit /b 1\r\n');
  fs.writeFileSync(path.join(realDir, 'node.cmd'), '@echo real %*\r\n@exit /b 7\r\n');
  const launcher = path.join(dir, 'hive-node.cmd');
  fs.writeFileSync(launcher, nodeLauncherScript(path.join(dir, 'gone.exe'), 'win32', path.join(shimDir, 'node.cmd')));
  const run = (PATH) => spawnSync('cmd.exe', ['/c', launcher, 'a'], { env: { ...process.env, PATH: `${PATH};${process.env.SystemRoot}\\System32`, LOCALAPPDATA: dir, ProgramFiles: dir }, encoding: 'utf8' });
  const found = run(`${shimDir};${realDir}`);
  assert.match(found.stdout, /real a/);
  assert.equal(found.status, 7);
  assert.equal(run(shimDir).status, 127);
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
