'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { pendingSteps, ensureNativeInstall } = require('../tools/ensure-native-install.cjs');

const DARWIN = { platform: 'darwin', arch: 'arm64' };
const WINDOWS = { platform: 'win32', arch: 'x64' };
const BINARY = 'Electron.app/Contents/MacOS/Electron';

function write(root, relative, content = '') {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function fakeTree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-native-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// The steps write these files, so a test sees what really ran and from where.
const RECORD_CWD = "require('node:fs').writeFileSync(process.argv[2], process.cwd())";

function electronPackage(root, installJs = `require('node:fs').writeFileSync('ran-electron', process.cwd())`) {
  write(root, 'node_modules/electron/install.js', installJs);
}

function installedElectron(root) {
  electronPackage(root);
  write(root, 'node_modules/electron/path.txt', BINARY);
  write(root, `node_modules/electron/dist/${BINARY}`);
}

function ptyPackage(root, install = `node record.js ran-pty`) {
  write(root, 'node_modules/node-pty/record.js', RECORD_CWD);
  write(root, 'node_modules/node-pty/package.json', JSON.stringify({ scripts: { install } }));
}

function names(steps) {
  return steps.map((step) => step.name);
}

test('nothing is pending when Electron and the node-pty binding are both present', (t) => {
  const root = fakeTree(t);
  installedElectron(root);
  ptyPackage(root);
  write(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node');
  assert.deepEqual(pendingSteps({ root, ...DARWIN }), []);
});

test('Electron is pending when its install script never ran', (t) => {
  const root = fakeTree(t);
  electronPackage(root);
  assert.deepEqual(names(pendingSteps({ root, ...DARWIN })), ['electron']);
});

test('Electron is pending when dist exists but path.txt does not, the state electron-vite rejects', (t) => {
  const root = fakeTree(t);
  electronPackage(root);
  write(root, `node_modules/electron/dist/${BINARY}`);
  assert.deepEqual(names(pendingSteps({ root, ...DARWIN })), ['electron']);
});

test('Electron is pending when path.txt is empty', (t) => {
  const root = fakeTree(t);
  electronPackage(root);
  write(root, 'node_modules/electron/path.txt', '');
  fs.mkdirSync(path.join(root, 'node_modules/electron/dist'));
  assert.deepEqual(names(pendingSteps({ root, ...DARWIN })), ['electron']);
});

test('Electron is pending when path.txt names a binary that is not on disk', (t) => {
  const root = fakeTree(t);
  electronPackage(root);
  write(root, 'node_modules/electron/path.txt', BINARY);
  fs.mkdirSync(path.join(root, 'node_modules/electron/dist'));
  assert.deepEqual(names(pendingSteps({ root, ...DARWIN })), ['electron']);
});

test('the node-pty binding counts from each directory its loader searches', async (t) => {
  for (const dir of ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64']) {
    await t.test(dir, (t) => {
      const root = fakeTree(t);
      installedElectron(root);
      ptyPackage(root);
      write(root, `node_modules/node-pty/${dir}/pty.node`);
      assert.deepEqual(pendingSteps({ root, ...DARWIN }), []);
    });
  }
});

test('a prebuild for another platform does not count as the node-pty binding', (t) => {
  const root = fakeTree(t);
  installedElectron(root);
  ptyPackage(root);
  write(root, 'node_modules/node-pty/prebuilds/darwin-x64/pty.node');
  assert.deepEqual(names(pendingSteps({ root, ...DARWIN })), ['node-pty']);
});

test('Windows looks for the conpty binding, not pty.node', (t) => {
  const root = fakeTree(t);
  installedElectron(root);
  ptyPackage(root);
  write(root, 'node_modules/node-pty/prebuilds/win32-x64/pty.node');
  assert.deepEqual(names(pendingSteps({ root, ...WINDOWS })), ['node-pty']);
  write(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node');
  assert.deepEqual(pendingSteps({ root, ...WINDOWS }), []);
});

test('a package that is not installed at all is not pending', (t) => {
  const root = fakeTree(t);
  assert.deepEqual(pendingSteps({ root, ...DARWIN }), []);
});

test("pending steps run each package's own script from its directory, Electron first", (t) => {
  const root = fakeTree(t);
  electronPackage(root);
  ptyPackage(root);
  const lines = [];
  assert.equal(ensureNativeInstall({ root, ...DARWIN, log: (line) => lines.push(line) }), 0);
  const electronDir = fs.realpathSync(path.join(root, 'node_modules/electron'));
  const ptyDir = fs.realpathSync(path.join(root, 'node_modules/node-pty'));
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(electronDir, 'ran-electron'), 'utf8')), electronDir);
  assert.equal(fs.realpathSync(fs.readFileSync(path.join(ptyDir, 'ran-pty'), 'utf8')), ptyDir);
  assert.match(lines[0], /electron/);
  assert.match(lines[1], /node-pty/);
});

test('nothing runs when everything is present', (t) => {
  const root = fakeTree(t);
  installedElectron(root);
  ptyPackage(root);
  write(root, 'node_modules/node-pty/build/Release/pty.node');
  const lines = [];
  assert.equal(ensureNativeInstall({ root, ...DARWIN, log: (line) => lines.push(line) }), 0);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/electron/ran-electron')), false);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/node-pty/ran-pty')), false);
  assert.deepEqual(lines, []);
});

test('a failed step stops the install with that exit code and names the package', (t) => {
  const root = fakeTree(t);
  electronPackage(root, 'process.exit(7)');
  ptyPackage(root);
  const lines = [];
  assert.equal(ensureNativeInstall({ root, ...DARWIN, log: (line) => lines.push(line) }), 7);
  assert.equal(fs.existsSync(path.join(root, 'node_modules/node-pty/ran-pty')), false, 'later steps must not run');
  assert.match(lines.at(-1), /electron.*failed/);
});

test('postinstall restores the native packages before electron-rebuild runs', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const commands = scripts.postinstall.split('&&').map((command) => command.trim());
  assert.equal(commands[0], 'node tools/ensure-native-install.cjs');
  assert.equal(commands[1], 'electron-rebuild -f');
});
