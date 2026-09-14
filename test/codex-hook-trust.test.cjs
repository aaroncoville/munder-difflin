'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { prepareCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

async function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/mdch-'));
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = oldHome; fs.rmSync(root, { recursive: true, force: true }); });
  const hive = new HiveManager(() => root);
  const injection = await hive.ensureAgent({ id: 'hook-trust', name: 'Hook trust', provider: 'codex', cwd: root });
  const home = fs.realpathSync(injection.env.CODEX_HOME);
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  const command = JSON.parse(config.match(/^command = (.+)$/m)[1]);
  const names = ['preToolUse', 'postToolUse', 'stop', 'subagentStop', 'sessionStart', 'userPromptSubmit', 'preCompact', 'postCompact'];
  const hooks = names.map((eventName, i) => ({
    eventName, key: `${home}/config.toml:event:${i}:0`, command,
    sourcePath: `${home}/config.toml`, source: 'user', handlerType: 'command',
    async: false, matcher: null, timeoutSec: 30, enabled: true,
    currentHash: `sha256:${String(i).repeat(64)}`, trustStatus: 'untrusted'
  }));
  const writes = [];
  const rpc = async (method, params) => {
    if (method === 'hooks/list') return { data: [{ cwd: root, hooks, errors: [], warnings: [] }] };
    assert.equal(method, 'config/batchWrite');
    writes.push(params);
    for (const hook of hooks) {
      if (params.edits.some(e => e.value === hook.currentHash)) hook.trustStatus = 'trusted';
    }
    return { status: 'ok' };
  };
  return { ctx: { home, cwd: root }, hooks, writes, rpc };
}

test('fresh writer hooks get exact persisted trust before remote startup; repeat is idempotent', async t => {
  const f = await fixture(t);
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc), true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].edits.length, 8);
  for (const h of f.hooks) assert.ok(f.writes[0].edits.some(e =>
    e.keyPath === `hooks.state.${JSON.stringify(h.key)}.trusted_hash` && e.value === h.currentHash));
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc), true);
  assert.equal(f.writes.length, 1);
});

test('untrusted user/project hooks force local fallback without broadening trust', async t => {
  const f = await fixture(t);
  f.hooks.push({ ...f.hooks[0], key: 'foreign', command: 'foreign-hook', source: 'project' });
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc), false);
  assert.deepEqual(f.writes, []);
});

test('changed generated commands and incomplete hook discovery fail closed', async t => {
  const f = await fixture(t);
  f.hooks[0].command = 'different';
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc), false);
  assert.deepEqual(f.writes, []);
});

test('persisted trust must be acknowledged by the resolver', async t => {
  const f = await fixture(t);
  assert.equal(await prepareCodexHookTrust(f.ctx, async (method, params) =>
    method === 'config/batchWrite' ? { status: 'ok' } : f.rpc(method, params)), false);
});

test('a missing CLI returns a local fallback instead of rejecting spawn', async t => {
  const f = await fixture(t);
  const { seedCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
  assert.equal(await seedCodexHookTrust({ ...f.ctx, executable: path.join(f.ctx.cwd, 'missing'), env: process.env }), false);
});

test('an unresponsive CLI is terminated within the preparation budget', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const { seedCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
  const executable = path.join(f.ctx.cwd, 'silent-cli');
  fs.writeFileSync(executable, `#!${process.execPath}\nprocess.stdin.resume();\n`, { mode: 0o700 });
  const start = Date.now();
  assert.equal(await seedCodexHookTrust({ ...f.ctx, executable, env: process.env }, 100), false);
  assert.ok(Date.now() - start < 2000);
});
