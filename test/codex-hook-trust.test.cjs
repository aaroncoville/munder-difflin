'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase } = require('./codex-test-home.cjs');
const { prepareCodexHookTrust } = loadTs('src/main/codexHookTrust.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

async function fixture(t, ownerToml) {
  const root = codexTestBase(t, 'mdch-');
  const oldHome = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = oldHome; fs.rmSync(root, { recursive: true, force: true }); });
  if (ownerToml !== undefined) {
    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), ownerToml);
  }
  const hive = new HiveManager(() => root);
  const runtime = fs.realpathSync(fs.mkdtempSync('/tmp/mdcr-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  hive.setHookRuntime(runtime);
  // Not the home itself: a working folder that contains the Codex home is refused.
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  const injection = await hive.ensureAgent({ id: 'hook-trust', name: 'Hook trust', provider: 'codex', cwd });
  const home = fs.realpathSync(injection.env.CODEX_HOME);
  const config = fs.readFileSync(path.join(home, 'config.toml'), 'utf8');
  const command = JSON.parse(config.split('auto-generated; do not edit')[1].match(/^command = (.+)$/m)[1]);
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
  return { root, ctx: { home, cwd: root }, hooks, writes, rpc };
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

test('an untrusted user or project hook refuses the start, says which, and broadens no trust', async t => {
  const f = await fixture(t);
  f.hooks.push({ ...f.hooks[0], key: 'foreign', command: 'foreign-hook', source: 'project', sourcePath: '/w/.codex/hooks.json' });
  let why = '';
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc, (r) => { why = r; }), false);
  assert.match(why, /did not write.*: preToolUse from \/w\/\.codex\/hooks\.json/);
  assert.deepEqual(f.writes, []);
});

for (const [label, change] of [
  ['already trusted', { trustStatus: 'trusted' }],
  ['disabled', { enabled: false }],
  ['managed', { isManaged: true, trustStatus: 'managed' }]
]) {
  test(`a hook the app did not write refuses the start even when it is ${label}`, async t => {
    const f = await fixture(t);
    f.hooks.push({ ...f.hooks[2], key: `/w/.codex/hooks.json:stop:0:0`, command: 'planted', source: 'project', sourcePath: '/w/.codex/hooks.json', ...change });
    let why = '';
    assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc, (r) => { why = r; }), false);
    assert.match(why, /stop from \/w\/\.codex\/hooks\.json/);
    assert.deepEqual(f.writes, [], 'no trust is written');
  });
}

test('a hook planted in the home\'s own config refuses the start', async t => {
  const f = await fixture(t);
  f.hooks.push({ ...f.hooks[2], key: `${f.ctx.home}/config.toml:stop:1:0`, command: 'planted', trustStatus: 'trusted' });
  let why = '';
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc, (r) => { why = r; }), false);
  assert.match(why, /stop from .*config\.toml/);
});

const OWNER_HOOK = '[[hooks.Stop]]\nmatcher = "x"\n[[hooks.Stop.hooks]]\ntype = "command"\ncommand = "owner-hook"\n';
const ownerListed = (f, extra = {}) => ({ ...f.hooks[2], key: `${f.ctx.home}/config.toml:stop:0:0`, command: 'owner-hook', matcher: 'x', timeoutSec: 600, currentHash: `sha256:${'a'.repeat(64)}`, ...extra });

test('the owner\'s own hooks, trusted in their own config, are allowed and keep that trust', async t => {
  const hash = `sha256:${'a'.repeat(64)}`;
  const f = await fixture(t, OWNER_HOOK);
  // The trust the owner gave it in ~/.codex/config.toml, keyed by that file.
  const ownerKey = `${path.join(f.root, '.codex', 'config.toml')}:stop:0:0`;
  const cfg = path.join(f.ctx.home, 'config.toml');
  fs.writeFileSync(cfg, fs.readFileSync(cfg, 'utf8').replace('# --- munder-hive', `[hooks.state.${JSON.stringify(ownerKey)}]\ntrusted_hash = "${hash}"\n\n# --- munder-hive`));
  f.hooks.push(ownerListed(f));
  let why = '';
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc, (r) => { why = r; }), true, why);
  assert.ok(f.writes[0].edits.some((e) => e.value === hash && e.keyPath.includes(':stop:0:0')), 'the owner\'s trust is carried to the copy');
});

test('an owner hook the owner never trusted refuses the start, naming it', async t => {
  const f = await fixture(t, OWNER_HOOK);
  f.hooks.push(ownerListed(f));
  let why = '';
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc, (r) => { why = r; }), false);
  assert.match(why, /not trusted in .*\.codex\/config\.toml.*stop/);
  assert.deepEqual(f.writes, []);
});

test('an owner hook changed after it was copied is not the owner\'s', async t => {
  const f = await fixture(t, OWNER_HOOK);
  f.hooks.push(ownerListed(f, { command: 'owner-hook --and-more' }));
  let why = '';
  assert.equal(await prepareCodexHookTrust(f.ctx, f.rpc, (r) => { why = r; }), false);
  assert.match(why, /did not write/);
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

test('a missing CLI reports failure instead of throwing', async t => {
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
