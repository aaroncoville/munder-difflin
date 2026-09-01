'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const {
  shortCodexHomeEnv,
  ensureCodexShortHome,
  codexRemoteAliasPath,
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

test('every agent gets a bindable control socket, not only the ones that reach remote control', () => {
  // Ids measured overflowing on a live machine: 109, 112 and 113 bytes of
  // socket path against a 104-byte limit. The daemon refused to start for all
  // of them, which is why a headless worker had nothing to fall back to.
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
    assert.ok(byDefault.length < CODEX_REMOTE_SOCKET_MAX, `default root: ${byDefault.length} bytes`);

    const { env, shortened } = shortCodexHomeEnv({ CODEX_HOME: real }, id, root);

    assert.equal(shortened, true, `${id} should have been given a short home`);
    const socket = path.join(env.CODEX_HOME, CODEX_REMOTE_SOCKET_RELATIVE);
    assert.ok(
      socket.length < CODEX_REMOTE_SOCKET_MAX,
      `socket for ${id} is ${socket.length} bytes: ${socket}`
    );
  }
});

test('the short home is a symlink onto the real one, so the agent stays browsable', () => {
  const root = tempRoot();
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'creal-'));

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
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'creal-'));

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
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'creal-'));
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
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'creal-'));
  const squatter = fs.mkdtempSync(path.join(os.tmpdir(), 'cother-'));

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
