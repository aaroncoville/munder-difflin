'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  shortCodexHomeEnv,
  ensureCodexShortHome,
  codexRemoteAliasPath,
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

test('an agent home the daemon cannot bind is refused, not aliased around', () => {
  // Ids measured overflowing on a live machine: 109, 112 and 113 bytes of
  // socket path against a 104-byte limit.
  //
  // This test used to assert the OPPOSITE — that each of these was handed a
  // short home — and it passed, because it measured the length of the alias
  // STRING. Codex canonicalizes $CODEX_HOME before deriving the control socket,
  // so the alias is measured at its target and that guarantee never existed:
  // the daemon went on failing on the long path, ten seconds later and for a
  // reason nothing recorded. Verified against codex-cli 0.149.1.
  //
  // A symlink cannot shorten a home for a process that resolves it. Refusing
  // one is not a regression from aliasing it; aliasing it never worked.
  const root = tempRoot();
  for (const id of ['rose-mtcz0zuv', 'worker-de-design', 'jannings-mtdmhwz0']) {
    const real = homeFor(id);
    const long = path.join(real, CODEX_REMOTE_SOCKET_RELATIVE);
    assert.ok(
      long.length >= CODEX_REMOTE_SOCKET_MAX,
      `fixture must reproduce the overflow, got ${long.length} bytes for ${id}`
    );

    // The default root is a length question and needs no filesystem — and must
    // not write into the root a running app is using.
    const byDefault = path.join(codexRemoteAliasPath(real, id), CODEX_REMOTE_SOCKET_RELATIVE);
    assert.ok(byDefault.length < CODEX_REMOTE_SOCKET_MAX,
      `the alias LOOKS short — ${byDefault.length} bytes — which is why this was believed`);

    const { env, shortened } = shortCodexHomeEnv({ CODEX_HOME: real }, id, root);

    assert.equal(shortened, false, `${id}: an unbindable home must not be reported as shortened`);
    assert.equal(env.CODEX_HOME, real, 'the caller keeps a working home and can say why');
  }
});

test('the short home is a symlink onto the real one, so the agent stays browsable', () => {
  const root = tempRoot();
  const real = shortRealHome('creal-');

  const alias = ensureCodexShortHome(real, 'agent-1', root);

  assert.ok(alias, 'a short home should have been established');
  assert.ok(fs.lstatSync(alias).isSymbolicLink(), 'the short home must be a link, not a copy');
  assert.equal(fs.realpathSync(alias), fs.realpathSync(real));
  // Anything Codex writes through the alias lands in the agent's own directory,
  // which is the whole reason it is a link rather than a separate home.
  fs.writeFileSync(path.join(alias, 'sessions.json'), '{}');
  assert.ok(fs.existsSync(path.join(real, 'sessions.json')));
});

test('establishing the short home twice reuses it rather than failing', () => {
  const root = tempRoot();
  const real = shortRealHome('creal-');

  assert.equal(ensureCodexShortHome(real, 'agent-1', root), ensureCodexShortHome(real, 'agent-1', root));
});

test('an agent whose home has been removed is still spawnable', () => {
  // Not hypothetical: on the machine this was written on, three of six live
  // aliases pointed at agent homes that no longer existed — including two of the
  // headless workers that died. A reset removes the directory and leaves the
  // link behind.
  //
  // existsSync FOLLOWS the link, so it reports a dangling alias as absent; the
  // symlink call then threw EEXIST, and the Codex spawn fell back to the long
  // home it cannot bind. The link is asked about itself instead.
  const root = tempRoot();
  const real = shortRealHome('creal-');
  const alias = ensureCodexShortHome(real, 'agent-1', root);
  fs.rmSync(real, { recursive: true });
  assert.equal(fs.existsSync(alias), false, 'the fixture must leave the alias dangling');

  assert.equal(
    ensureCodexShortHome(real, 'agent-1', root), alias,
    'the alias still names this agent’s home, so it is reused rather than thrown over'
  );

  // And it is a working home again the moment the agent dir comes back.
  fs.mkdirSync(real);
  assert.equal(fs.realpathSync(alias), fs.realpathSync(real));
});

test('a home already taken by something else is refused, not overwritten', () => {
  const root = tempRoot();
  const real = shortRealHome('creal-');
  const squatter = shortRealHome('cother-');

  const alias = ensureCodexShortHome(real, 'agent-1', root);
  fs.unlinkSync(alias);
  fs.symlinkSync(squatter, alias, 'dir');

  assert.equal(
    ensureCodexShortHome(real, 'agent-1', root), null,
    'someone else’s home must never be adopted or replaced'
  );
  assert.equal(fs.realpathSync(alias), fs.realpathSync(squatter), 'and must be left alone');
});

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

test('a home that already binds is still offered', () => {
  // The other half: refusing everything would satisfy the test above and help
  // nobody.
  const root = tempRoot();
  const real = fs.mkdtempSync('/tmp/creal-');
  made.push(real);

  const home = ensureCodexShortHome(real, 'agent-1', root);

  assert.ok(home, 'a home that can host its own socket must still be usable');
  const bound = path.join(fs.realpathSync(home), CODEX_REMOTE_SOCKET_RELATIVE);
  assert.ok(bound.length < CODEX_REMOTE_SOCKET_MAX);
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
