'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { withCodexWritableRoots } = loadTs('src/shared/codexWritableRoots.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

/** Codex rejects `--add-dir` (and `-c sandbox_workspace_write.writable_roots`)
 *  once the TUI is attached to an app server with `--remote`: extra workspace
 *  roots have to come from the server's own config. The server reads config.toml
 *  from the same CODEX_HOME, so that file is where the roots go. */

test('roots become a sandbox_workspace_write table when the config has none', () => {
  const out = withCodexWritableRoots('model = "gpt-5-codex"\n', ['/hive/agents/a', '/hive']);
  assert.ok(out.startsWith('model = "gpt-5-codex"\n'), out);
  assert.match(out, /\n\[sandbox_workspace_write\]\nwritable_roots = \["\/hive\/agents\/a", "\/hive"\]\n/);
});

test('an existing sandbox_workspace_write table gains the key instead of being redeclared', () => {
  // TOML forbids declaring the same table twice, and Codex refuses a config it
  // cannot parse — so appending a second header would break the agent outright.
  const user = '[sandbox_workspace_write]\nnetwork_access = true\n\n[features]\nx = true\n';
  const out = withCodexWritableRoots(user, ['/hive']);
  assert.equal(out.match(/^\[sandbox_workspace_write\]/gm).length, 1, out);
  assert.match(out, /\[sandbox_workspace_write\]\nwritable_roots = \["\/hive"\]\nnetwork_access = true\n/);
  assert.ok(out.includes('[features]\nx = true\n'), out);
});

test('the user\'s own writable roots are kept alongside ours', () => {
  const user = '[sandbox_workspace_write]\nwritable_roots = [\n  "/mine",\n]\n';
  const out = withCodexWritableRoots(user, ['/hive']);
  assert.equal(out.match(/writable_roots/g).length, 1, `key declared twice:\n${out}`);
  assert.match(out, /writable_roots = \["\/hive", \n  "\/mine",\n\]/);
});

test('a writable_roots key in another table is not mistaken for ours', () => {
  const user = '[sandbox_workspace_write]\nnetwork_access = true\n\n[other]\nwritable_roots = ["/x"]\n';
  const out = withCodexWritableRoots(user, ['/hive']);
  assert.ok(out.includes('[other]\nwritable_roots = ["/x"]\n'), out);
  assert.match(out, /\[sandbox_workspace_write\]\nwritable_roots = \["\/hive"\]\nnetwork_access = true\n/);
});

test('roots needing TOML escaping are escaped', () => {
  const out = withCodexWritableRoots('', ['/a "b"\\c']);
  assert.ok(out.includes('writable_roots = ["/a \\"b\\"\\\\c"]'), out);
});

test('no roots leaves the config untouched', () => {
  assert.equal(withCodexWritableRoots('model = "m"\n', []), 'model = "m"\n');
});

test('codex spawn prep writes the agent folder and hive root into its own config', async (t) => {
  // Short /tmp root for the same reason as the directory-trust tests: the
  // agent's Codex home lands under this fake $HOME and must fit a socket path.
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/mdcw-'));
  const fakeHome = path.join(home, 'h');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent({ id: 'codex-roots-1', name: 'codex-roots-1', provider: 'codex', cwd: repo });
  const config = fs.readFileSync(path.join(injection.env.CODEX_HOME, 'config.toml'), 'utf8');
  const hiveRoot = path.join(home, 'hive');
  const agentDir = path.join(hiveRoot, 'agents', 'codex-roots-1');
  const roots = config.match(/^writable_roots = (\[.*\])$/m);
  assert.ok(roots, `no writable_roots in:\n${config}`);
  const listed = JSON.parse(roots[1]);
  assert.ok(listed.includes(agentDir), `agent folder missing from ${roots[1]}`);
  assert.ok(listed.includes(hiveRoot), `hive root missing from ${roots[1]}`);

  // Without --remote the CLI still takes the same roots as --add-dir.
  const addDirs = injection.args.flatMap((a, i) => (a === '--add-dir' ? [injection.args[i + 1]] : []));
  assert.deepEqual(addDirs, listed);
});
