'use strict';

// The `hive` command ships as out/main/hiveCli.js: one CommonJS file built from
// src/core/hiveCliMain.ts, which the hive's bin/hive launcher runs with the
// bundled node. It must be self-contained (no chunk files beside it, no npm
// packages, no electron) so it runs under plain node as well as Electron's.
//
// These tests load the real electron-vite config, check its main build runs
// the bundling step, and run that step into a temporary folder.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { builtinModules } = require('node:module');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const configModule = loadTs('electron.vite.config.ts');

test('the main build of the electron-vite config includes the hive CLI bundling step', () => {
  const config = configModule.default;
  const names = (config.main.plugins || []).flat(Infinity).filter(Boolean).map((p) => p.name);
  assert.ok(names.includes('build-hive-cli'), `main plugins: ${names.join(', ')}`);
  const plugin = config.main.plugins.flat(Infinity).find((p) => p && p.name === 'build-hive-cli');
  assert.equal(typeof plugin.writeBundle, 'function', 'it runs once the main bundle is written');
});

test('the bundle is one self-contained CommonJS file that runs under plain node', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-cli-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const out = path.join(dir, 'out', 'hiveCli.js');
  await configModule.buildHiveCliBundle(out);

  assert.deepEqual(fs.readdirSync(path.dirname(out)), ['hiveCli.js'], 'no chunk files beside it');
  const code = fs.readFileSync(out, 'utf8');
  const required = [...code.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  const notBuiltin = required.filter((r) => !r.startsWith('node:') && !builtinModules.includes(r));
  assert.deepEqual(notBuiltin, [], 'it requires only Node builtins');
  assert.doesNotMatch(code, /\bimport\s*\(|^\s*import\s|^\s*export\s/m, 'CommonJS, not ESM');

  const help = spawnSync(process.execPath, [out, '--help'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage: hive /);

  const hive = path.join(dir, 'hive');
  fs.mkdirSync(hive);
  const add = spawnSync(process.execPath, [out, 'tasks', 'add', '--json', '{"id":"a"}'], { encoding: 'utf8', env: { PATH: process.env.PATH, HIVE_ROOT: hive } });
  assert.equal(add.status, 0, add.stderr);
  assert.equal(add.stdout, 'added a\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(hive, 'tasks.json'), 'utf8')).tasks.map((c) => c.id), ['a']);
});
