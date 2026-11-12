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

const { HiveManager } = loadTs('src/main/hive.ts');
const { bundledResourcePath } = loadTs('src/main/resourcePaths.ts');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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

test('bootstrap no longer writes the helper into the hive, and removes a stale copy', (t) => {
  const home = tmp(t, 'md-proxy-boot-');
  const hive = new HiveManager(() => home);
  const stale = path.join(home, 'hive', 'bin', 'hive-proxy.cjs');
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, '// old copy\n');
  hive.ensureHive();
  assert.equal(fs.existsSync(stale), false);
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
