'use strict';

// Electron names the settings folder after the app, and Codex homes and session
// links carry the old name too. An existing install is keyed on all of them, so
// a change of displayed name must leave every one where it is, or the next
// launch starts on an empty profile and the agents lose their homes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
/** Source with comments removed, so a match can only come from live code. */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const builderValue = (key) => {
  const m = read('electron-builder.yml').match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
  assert.ok(m, `electron-builder.yml has no top-level ${key}`);
  return m[1].trim();
};

const { LEGACY_DATA_FOLDER, pinLegacyUserData } = loadTs('src/main/legacyUserData.ts');

test('userData is pinned to the folder every existing install already uses', () => {
  const calls = [];
  const fakeApp = {
    getPath: (name) => { assert.equal(name, 'appData'); return '/Users/someone/Library/Application Support'; },
    setPath: (name, value) => calls.push([name, value])
  };
  const dir = pinLegacyUserData(fakeApp);
  assert.deepEqual(calls, [['userData', '/Users/someone/Library/Application Support/munder-difflin']]);
  assert.equal(dir, calls[0][1]);
  // Electron derived the old folder from package.json (productName, else name).
  // The pin must land on exactly that folder, whatever the display name becomes.
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.productName, undefined, 'a package.json productName would rename the derived folder');
  assert.equal(pkg.name, LEGACY_DATA_FOLDER);
});

test('the pin runs before any other main-process module loads', () => {
  const firstStatement = code('src/main/index.ts').trimStart().split('\n')[0];
  assert.equal(firstStatement, "import './pinUserData';");
  assert.match(code('src/main/pinUserData.ts'), /^pinLegacyUserData\(app\);$/m);
});

test('nothing renames the app at run time (it would move userData and the keychain entry)', () => {
  const offenders = [];
  for (const dir of ['src/main', 'src/shared']) {
    for (const f of fs.readdirSync(path.join(root, dir))) {
      if (/\.ts$/.test(f) && /\bapp\.setName\s*\(|\bapp\.name\s*=/.test(code(`${dir}/${f}`))) offenders.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(offenders, []);
});

test('the bundle id is unchanged, so macOS keeps its privacy grants', () => {
  assert.equal(builderValue('appId'), 'in.munderdiffl.app');
});

test('Codex homes stay under ~/.mdc', () => {
  const { codexShortHomeRoot } = loadTs('src/shared/codexRemote.ts');
  assert.equal(codexShortHomeRoot(), path.join(os.homedir(), '.mdc'));
});

test('Codex sessions stay linked under the munder-difflin namespace', () => {
  const live = code('src/main/hive.ts');
  const hits = live.match(/join\(userHome, kind, 'munder-difflin'\)/g) ?? [];
  assert.equal(hits.length, 2, 'both the link writer and the link scanner use the namespace');
});
