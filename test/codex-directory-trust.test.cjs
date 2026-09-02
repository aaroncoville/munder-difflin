'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { HiveManager } = loadTs('src/main/hive.ts');
const { CODEX_REMOTE_SOCKET_RELATIVE, CODEX_REMOTE_SOCKET_MAX } = loadTs('src/shared/codexRemote.ts');

/** A per-agent CODEX_HOME starts life as a virgin config dir, so Codex asks
 *  "do you trust this directory?" on the first turn and a headless agent sits
 *  on the prompt forever. Pressing Yes persists exactly this table, and
 *  pre-seeding it suppresses the prompt (verified on Codex 0.149.1 — no flag or
 *  env does; `--dangerously-bypass-approvals-and-sandbox` does not). */
function trustTable(cwd) {
  return `[projects."${cwd}"]\ntrust_level = "trusted"`;
}

/** A hive home plus a `$HOME` whose `~/.codex/config.toml` is under our control:
 *  installCodexHooks seeds the generated config from the user's, so the test has
 *  to own that file to say anything about what survives. */
function sandbox(t, userConfig) {
  // Rooted at /tmp with short names, not os.tmpdir(): the agent's Codex home is
  // placed under this fake $HOME, and macOS resolves os.tmpdir() through
  // /private/var/folders/xx/<30-char-hash>/T/ — which leaves no room for a
  // control socket inside 104 bytes, so the whole point of the test would be
  // fixture length rather than behaviour.
  const home = fs.realpathSync(fs.mkdtempSync('/tmp/mdct-'));
  const fakeHome = path.join(home, 'h');
  fs.mkdirSync(path.join(fakeHome, '.codex'), { recursive: true });
  if (userConfig !== undefined) {
    fs.writeFileSync(path.join(fakeHome, '.codex', 'config.toml'), userConfig, 'utf8');
  }
  const realHome = process.env.HOME;
  process.env.HOME = fakeHome;
  t.after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

async function prepCodexAgent(home, id, cwd) {
  const hive = new HiveManager(() => home);
  const injection = await hive.ensureAgent({ id, name: id, provider: 'codex', cwd });
  const codexHome = injection.env.CODEX_HOME;
  assert.ok(codexHome, 'a codex spawn must get an isolated CODEX_HOME');
  return { codexHome, config: fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8') };
}

test('codex spawn prep trusts the agent\'s final working directory', async (t) => {
  const home = sandbox(t);
  // Codex canonicalizes the directory it prompts about, so the entry has to be
  // stored realpath-resolved or it simply does not match and the prompt returns.
  const repo = path.join(home, 'repo');
  const via = path.join(home, 'symlinked-repo');
  fs.mkdirSync(repo, { recursive: true });
  fs.symlinkSync(repo, via, 'dir');

  const { config } = await prepCodexAgent(home, 'codex-trust-1', via);
  assert.ok(config.includes(trustTable(repo)), `no trust entry for ${repo} in:\n${config}`);
});

test('a working directory needing TOML escaping is escaped, not interpolated', async (t) => {
  const home = sandbox(t);
  const repo = path.join(home, 'we"ird\\repo');
  fs.mkdirSync(repo, { recursive: true });

  const { config } = await prepCodexAgent(home, 'codex-trust-2', repo);
  const escaped = `${home}/we\\"ird\\\\repo`;
  assert.ok(config.includes(trustTable(escaped)), `path was not TOML-escaped in:\n${config}`);
});

test('the user\'s own codex settings survive the trust entry', async (t) => {
  const home = sandbox(t, 'model = "gpt-5-codex"\n');
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const { config } = await prepCodexAgent(home, 'codex-trust-3', repo);
  assert.ok(config.includes('model = "gpt-5-codex"'), `user setting was lost:\n${config}`);
  assert.ok(config.includes(trustTable(repo)), `no trust entry for ${repo} in:\n${config}`);
});

test('the home the daemon actually binds in carries the trust entry', async (t) => {
  const home = sandbox(t);
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo, { recursive: true });

  const { codexHome } = await prepCodexAgent(home, 'codex-trust-4', repo);
  // Codex canonicalizes $CODEX_HOME before doing anything with it, so the
  // directory that has to hold the trust entry is the one .codex RESOLVES to —
  // and it has to be short enough to host a control socket, or the daemon never
  // starts to read the entry at all. (The sandbox points $HOME at the test root,
  // so this lands under it and not in the real one.)
  const resolved = fs.realpathSync(codexHome);
  const socket = path.join(resolved, CODEX_REMOTE_SOCKET_RELATIVE);
  assert.ok(socket.length < CODEX_REMOTE_SOCKET_MAX,
    `the daemon could not bind here: ${socket.length} bytes at ${socket}`);

  const config = fs.readFileSync(path.join(resolved, 'config.toml'), 'utf8');
  assert.ok(config.includes(trustTable(repo)), `no trust entry for ${repo} in:\n${config}`);
});
