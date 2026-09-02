'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  shortCodexHomeEnv,
  ensureCodexShortHome,
  codexShortHomePath,
  codexRemoteSocketFits,
  CODEX_REMOTE_SOCKET_RELATIVE,
  CODEX_REMOTE_SOCKET_MAX
} = loadTs('src/shared/codexRemote.ts');

/** The real shape of an agent home, which is what overflows sun_path. */
const homeFor = (id) =>
  `/Users/aaroncoville/HarnessAgents/hive/agents/${id}/.codex`;

/** Rooted at /tmp, not os.tmpdir(): macOS spells the latter
 *  /var/folders/xx/<30-char-hash>/T/, which is itself too long to host an alias
 *  whose socket has to fit in sun_path — the trap this module was written for. */
const made = [];
function tempRoot() {
  const dir = fs.mkdtempSync('/tmp/cshort-');
  made.push(dir);
  return dir;
}
// These roots are deliberately outside os.tmpdir(), which nothing else sweeps,
// so the suite takes its own litter with it.
process.on('exit', () => {
  for (const dir of made) fs.rmSync(dir, { recursive: true, force: true });
});

/** A real home short enough for its own control socket. Rooted at /tmp for the
 *  same reason tempRoot is: os.tmpdir() resolves to /private/var/folders/…, and
 *  a home there is 112 bytes of socket path against a 104-byte limit — the very
 *  overflow these tests are about. */
function shortRealHome(prefix) {
  const dir = fs.mkdtempSync('/tmp/' + prefix);
  made.push(dir);
  return dir;
}

test('a spawn with no Codex home of its own is handed back untouched', () => {
  // Every non-Codex provider. Claude spawns carry no CODEX_HOME, so this is the
  // guarantee that they are unaffected by any of the above.
  const original = { PATH: '/usr/bin', CLAUDE_CODE_ENABLE_TELEMETRY: '1' };

  const { env, shortened } = shortCodexHomeEnv(original, 'agent-1');

  assert.equal(shortened, false);
  assert.deepEqual(env, original);
});

test('a home that cannot be shortened enough is left as it was', () => {
  const real = homeFor('agent-1');
  const tooLong = '/' + 'x'.repeat(CODEX_REMOTE_SOCKET_MAX);

  const { env, shortened } = shortCodexHomeEnv({ CODEX_HOME: real }, 'agent-1', tooLong);

  assert.equal(shortened, false);
  assert.equal(env.CODEX_HOME, real, 'the caller keeps a working home and reports the reason');
});

// ── What Codex actually measures ────────────────────────────────────────────

/** A real directory shaped like an agent home, deep enough that its OWN control
 *  socket overflows — i.e. the thing an alias is supposed to rescue. */
function longRealHome(root) {
  const dir = path.join(root, 'HarnessAgents', 'hive', 'agents', 'jannings-mtdml7xg-lookalike', '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const own = path.join(fs.realpathSync(dir), CODEX_REMOTE_SOCKET_RELATIVE);
  assert.ok(own.length >= CODEX_REMOTE_SOCKET_MAX,
    `fixture must reproduce the overflow, got ${own.length} bytes`);
  return dir;
}

test('a home is only offered when the path Codex RESOLVES it to is bindable', () => {
  // Codex canonicalizes $CODEX_HOME before deriving the control socket, so a
  // short symlink is measured at its TARGET's length. Verified against
  // codex-cli 0.149.1: handed a 63-byte symlink onto a 120-byte home, the
  // daemon reported `path must be shorter than SUN_LEN` for the long path.
  //
  // The property is therefore NOT "the string we hand over is short". It is
  // "the path the daemon binds is short", and the two differ by exactly the bug.
  const root = tempRoot();
  const home = ensureCodexShortHome(longRealHome(root), 'agent-1', root);

  if (home !== null) {
    const bound = path.join(fs.realpathSync(home), CODEX_REMOTE_SOCKET_RELATIVE);
    assert.ok(bound.length < CODEX_REMOTE_SOCKET_MAX,
      `offered a home whose socket the daemon cannot bind: ${bound.length} bytes at ${bound}`);
  }
});

test('the fit test follows the link, because the daemon does', () => {
  const root = tempRoot();
  const real = longRealHome(root);
  const alias = path.join(root, 'lnk');
  fs.symlinkSync(real, alias, 'dir');

  assert.equal(path.join(alias, CODEX_REMOTE_SOCKET_RELATIVE).length < CODEX_REMOTE_SOCKET_MAX, true,
    'the fixture must be a link that LOOKS short');
  assert.equal(codexRemoteSocketFits(alias), false,
    'a link that looks short but resolves long must not be reported as bindable');
});

// ── The home a new agent actually gets ──────────────────────────────────────
// Codex resolves $CODEX_HOME, so the SHORT path has to be the real directory and
// the agent's own path the link — the other way round shortens nothing.

/** The agent-dir path a fresh Codex agent would be given, not yet created. */
function freshAgentHome(root) {
  const dir = path.join(root, 'HarnessAgents', 'hive', 'agents', 'worker-de-design2', '.codex');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const own = path.join(fs.realpathSync(path.dirname(dir)), '.codex', CODEX_REMOTE_SOCKET_RELATIVE);
  assert.ok(own.length >= CODEX_REMOTE_SOCKET_MAX,
    `fixture must reproduce the overflow, got ${own.length} bytes`);
  return dir;
}

test('the homes measured overflowing on a live machine all fit once relocated', () => {
  // 109, 112 and 113 bytes of socket path against a 104-byte limit. Kept as pure
  // arithmetic on the default root: naming real agent ids is the point, and this
  // must never touch the hive a running app is using.
  for (const id of ['rose-mtcz0zuv', 'worker-de-design', 'jannings-mtdmhwz0']) {
    const inAgentDir = path.join(homeFor(id), CODEX_REMOTE_SOCKET_RELATIVE);
    assert.ok(inAgentDir.length >= CODEX_REMOTE_SOCKET_MAX,
      `fixture must reproduce the overflow, got ${inAgentDir.length} bytes for ${id}`);

    const relocated = path.join(codexShortHomePath(homeFor(id), id), CODEX_REMOTE_SOCKET_RELATIVE);
    assert.ok(relocated.length < CODEX_REMOTE_SOCKET_MAX,
      `${id} still overflows after relocation: ${relocated.length} bytes`);
  }
});

test('an agent whose home directory has been removed is still spawnable', () => {
  // Not hypothetical: on the machine this was written on, live links pointed at
  // homes that no longer existed — including two of the headless workers that
  // died. A reset removes the directory and leaves the link behind.
  //
  // existsSync FOLLOWS the link, so it reports that as absent and the symlink
  // call then throws EEXIST, which used to end in a Codex agent silently
  // launching with the long home it cannot bind. The link is asked about itself.
  const root = tempRoot();
  const agentHome = freshAgentHome(root);
  const short = path.join(root, 'short');

  const home = ensureCodexShortHome(agentHome, 'worker-de-design2', short);
  fs.rmSync(home, { recursive: true });
  assert.equal(fs.existsSync(agentHome), false, 'the fixture must leave the link dangling');

  assert.equal(ensureCodexShortHome(agentHome, 'worker-de-design2', short), home,
    'the link still names this agent’s home, so it is restored rather than thrown over');
  assert.ok(fs.existsSync(home), 'and the directory is there to be written into again');
});

test('a .codex pointing somewhere else is refused, not overwritten', () => {
  const root = tempRoot();
  const agentHome = freshAgentHome(root);
  const elsewhere = shortRealHome('cother-');
  fs.mkdirSync(path.dirname(agentHome), { recursive: true });
  fs.symlinkSync(elsewhere, agentHome, 'dir');

  assert.equal(ensureCodexShortHome(agentHome, 'worker-de-design2', path.join(root, 'short')), null,
    'someone else’s home must never be adopted or replaced');
  assert.equal(fs.realpathSync(agentHome), fs.realpathSync(elsewhere), 'and must be left alone');
});

test('a Codex home that does not exist yet is created somewhere its daemon can bind', () => {
  const root = tempRoot();
  const agentHome = freshAgentHome(root);

  const home = ensureCodexShortHome(agentHome, 'worker-de-design2', path.join(root, 'short'));

  assert.ok(home, 'a fresh agent must get a home, not a refusal');
  const bound = path.join(fs.realpathSync(home), CODEX_REMOTE_SOCKET_RELATIVE);
  assert.ok(bound.length < CODEX_REMOTE_SOCKET_MAX,
    `the daemon must be able to bind here: ${bound.length} bytes at ${bound}`);
});

test('the agent keeps a .codex of its own, pointing at that home', () => {
  // Everything that reads the agent directory — the hooks config, auth.json, the
  // person looking — still finds .codex where it has always been. It is the link
  // now, which is the only arrangement Codex cannot resolve away.
  const root = tempRoot();
  const agentHome = freshAgentHome(root);

  const home = ensureCodexShortHome(agentHome, 'worker-de-design2', path.join(root, 'short'));

  assert.ok(fs.lstatSync(agentHome).isSymbolicLink(), 'the agent path must be the link');
  assert.equal(fs.realpathSync(agentHome), fs.realpathSync(home));
  fs.writeFileSync(path.join(agentHome, 'config.toml'), 'x = 1');
  assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'x = 1');
});

test('an agent that already has a real .codex is left exactly as it was', () => {
  // The migration boundary. Seven live agents hold real .codex directories with
  // sessions, history and auth links; moving one out from under a running agent
  // is a deliberate maintenance action, never a spawn-time side effect.
  const root = tempRoot();
  const agentHome = freshAgentHome(root);
  fs.mkdirSync(agentHome, { recursive: true });
  fs.writeFileSync(path.join(agentHome, 'history.jsonl'), 'kept');

  assert.equal(ensureCodexShortHome(agentHome, 'worker-de-design2', path.join(root, 'short')), null,
    'an existing home cannot be bound, and must be reported so rather than moved');
  assert.equal(fs.lstatSync(agentHome).isDirectory(), true, 'still a real directory');
  assert.equal(fs.readFileSync(path.join(agentHome, 'history.jsonl'), 'utf8'), 'kept');
});

test('a second spawn reuses the home the first one made', () => {
  const root = tempRoot();
  const agentHome = freshAgentHome(root);
  const short = path.join(root, 'short');

  const first = ensureCodexShortHome(agentHome, 'worker-de-design2', short);
  fs.writeFileSync(path.join(first, 'auth.json'), '{}');
  const again = ensureCodexShortHome(agentHome, 'worker-de-design2', short);

  assert.equal(again, first, 'a respawn must not strand the session the last one wrote');
  assert.ok(fs.existsSync(path.join(agentHome, 'auth.json')));
});
