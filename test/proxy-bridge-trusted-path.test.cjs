'use strict';
// The proxy bridge is started by the main process, so the script it runs must
// come from the app's own resources. The hive folder is writable by every agent:
// a file there must never be what the bridge executes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

const { HiveManager } = loadTs('src/main/hive.ts');
const { bundledResourcePath } = loadTs('src/main/resourcePaths.ts');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

/** A helper that records its own argv and reports a fake bound port. */
function helper(file, record) {
  fs.writeFileSync(file, `require('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(1)));\n` +
    `process.stdout.write(JSON.stringify({ port: 4242 }) + '\\n');\nsetTimeout(() => {}, 60000);\n`);
}

const cfg = (home) => ({ sock: path.join(home, 'none.sock'), sessionId: 's', api: 'openai', upstream: 'http://127.0.0.1:9' });

function setup(t) {
  const home = tmp(t, 'md-proxy-home-');
  const trustedDir = tmp(t, 'md-proxy-res-');
  const hive = new HiveManager(() => home);
  t.after(() => { try { hive.stopAllProxyBridges(); } catch { /* gone */ } });
  hive.ensureHive();
  // An agent replaces the hive copy with its own code after bootstrap.
  const marker = path.join(home, 'HIVE-COPY-RAN');
  const hiveCopy = path.join(home, 'hive', 'bin', 'hive-proxy.cjs');
  fs.mkdirSync(path.dirname(hiveCopy), { recursive: true });
  helper(hiveCopy, marker);
  const trusted = path.join(trustedDir, 'hive-proxy.cjs');
  const record = path.join(trustedDir, 'argv.json');
  helper(trusted, record);
  return { home, hive, marker, hiveCopy, trusted, record };
}

test('the bridge runs the app resource helper, never the copy in the hive folder', async (t) => {
  const { home, hive, marker, trusted, record } = setup(t);
  hive.setProxyBridgeScript(trusted);
  const port = await hive.startProxyBridge('qwen-1', cfg(home));
  assert.equal(port, 4242);
  assert.deepEqual(JSON.parse(fs.readFileSync(record, 'utf8')), [trusted]);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(marker), false, 'the hive copy of hive-proxy.cjs was executed');
});

test('with no resource helper configured the bridge does not start, and nothing in the hive runs', async (t) => {
  const { home, hive, marker } = setup(t);
  const port = await hive.startProxyBridge('qwen-1', cfg(home));
  assert.equal(port, 0);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(fs.existsSync(marker), false, 'the hive copy of hive-proxy.cjs was executed');
});

test('bootstrap does not write the helper into the hive and leaves an old copy alone', (t) => {
  const home = tmp(t, 'md-proxy-boot-');
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const stale = path.join(home, 'hive', 'bin', 'hive-proxy.cjs');
  assert.equal(fs.existsSync(stale), false, 'bootstrap wrote the helper into the hive');
  fs.writeFileSync(stale, '// old copy\n');
  hive.ensureHive();
  assert.equal(fs.readFileSync(stale, 'utf8'), '// old copy\n');
});

test('a hive bin folder linked elsewhere: bootstrap leaves the outside hive-proxy.cjs untouched', (t) => {
  if (process.platform === 'win32') return;
  const home = tmp(t, 'md-proxy-link-');
  const outside = tmp(t, 'md-proxy-outside-');
  const victim = path.join(outside, 'hive-proxy.cjs');
  fs.writeFileSync(victim, 'not the hive\'s\n');
  fs.mkdirSync(path.join(home, 'hive'), { recursive: true });
  fs.symlinkSync(outside, path.join(home, 'hive', 'bin'));
  new HiveManager(() => home).ensureHive();
  assert.equal(fs.readFileSync(victim, 'utf8'), 'not the hive\'s\n');
});

test('a folder where the old helper used to be does not stop bootstrap', (t) => {
  const home = tmp(t, 'md-proxy-dir-');
  fs.mkdirSync(path.join(home, 'hive', 'bin', 'hive-proxy.cjs'), { recursive: true });
  const hive = new HiveManager(() => home);
  assert.doesNotThrow(() => hive.ensureHive());
  assert.ok(fs.existsSync(path.join(home, 'hive', 'registry.json')), 'bootstrap stopped before finishing');
});

test('setting a resource path that does not exist warns once, at set time', (t) => {
  const warned = [];
  const real = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  t.after(() => { console.warn = real; });
  const hive = new HiveManager(() => null);
  hive.setProxyBridgeScript(path.join(os.tmpdir(), 'no-such-dir-md', 'hive-proxy.cjs'));
  assert.equal(warned.filter((w) => w.includes('hive-proxy.cjs')).length, 1);
  warned.length = 0;
  hive.setProxyBridgeScript(__filename);
  assert.deepEqual(warned, []);
});

test('the resource path resolves under resourcesPath when packaged and under the app in development', () => {
  assert.equal(bundledResourcePath('hive-proxy.cjs', { isPackaged: true, resourcesPath: '/App/Resources', appPath: '/App/Resources/app.asar' }),
    path.join('/App/Resources', 'hive-proxy.cjs'));
  assert.equal(bundledResourcePath('hive-proxy.cjs', { isPackaged: false, resourcesPath: '/electron/Resources', appPath: '/src/md' }),
    path.join('/src/md', 'resources', 'hive-proxy.cjs'));
});

test('the shipped helper exists in resources and is listed for packaging', () => {
  const root = path.join(__dirname, '..');
  assert.ok(fs.statSync(path.join(root, 'resources', 'hive-proxy.cjs')).isFile());
  assert.match(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf8'), /from: resources\/hive-proxy\.cjs\s*\n\s*to: hive-proxy\.cjs/);
});
