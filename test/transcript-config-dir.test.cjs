'use strict';

/**
 * Where Claude Code keeps its transcripts, as transcript.ts resolves it for
 * every reader and writer: $CLAUDE_CONFIG_DIR when the CLI in question runs
 * with one, else <home>/.claude where home is that CLI's HOME before this
 * process's. One root for projectDir, the resume seeding, the session-cwd
 * lookup and the usage reconciler, so none of them can read a directory the
 * CLI never writes to.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { claudeConfigDir, newSessionProjectDir, seedSessionTranscript, resolveSessionCwd } =
  loadTs('src/main/transcript.ts');

const key = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, '-');
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `md-cfg-${label}-`));
const SID = '11111111-2222-4333-8444-555555555555';

function writeTranscript(file, cwd) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ type: 'user', cwd }) + '\n', 'utf8');
}

test('claudeConfigDir: CLAUDE_CONFIG_DIR wins, then the env\'s HOME, then this process\'s home', () => {
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '/operator/cfg', HOME: '/h' }), '/operator/cfg');
  assert.equal(claudeConfigDir({ HOME: '/session/home' }), path.join('/session/home', '.claude'));
  assert.equal(claudeConfigDir({}), path.join(os.homedir(), '.claude'));
  // A tilde in CLAUDE_CONFIG_DIR expands against the same HOME.
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/cfg', HOME: '/session/home' }), path.join('/session/home', 'cfg'));
  // Blank values are as good as unset.
  assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '  ', HOME: '' }), path.join(os.homedir(), '.claude'));
});

test('a session-level HOME override moves every transcript path with it', () => {
  const home = tmp('home');
  const cwd = '/Users/me/app';
  assert.equal(newSessionProjectDir(cwd, { HOME: home }), path.join(home, '.claude', 'projects', key(cwd)));
});

test('seedSessionTranscript copies within the CLAUDE_CONFIG_DIR root, never from ~/.claude', () => {
  const cfg = tmp('cfg');
  const home = tmp('home');
  const env = { CLAUDE_CONFIG_DIR: cfg, HOME: home };
  const from = '/Users/me/elsewhere';
  const to = '/Users/me/app';
  // The session ran in another cwd, under the configured root.
  writeTranscript(path.join(cfg, 'projects', key(from), `${SID}.jsonl`), from);
  // A same-id transcript under ~/.claude is a different CLI's and must not be used.
  writeTranscript(path.join(home, '.claude', 'projects', key(from), `${SID}.jsonl`), '/wrong');

  assert.equal(seedSessionTranscript(to, SID, env), true);
  const target = path.join(cfg, 'projects', key(to), `${SID}.jsonl`);
  assert.equal(fs.existsSync(target), true, 'seeded under the configured root');
  assert.match(fs.readFileSync(target, 'utf8'), /elsewhere/);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'projects', key(to))), false, 'nothing written under ~/.claude');

  // Only present under ~/.claude: not found for a CLI configured elsewhere.
  const other = '22222222-2222-4333-8444-555555555555';
  writeTranscript(path.join(home, '.claude', 'projects', key(from), `${other}.jsonl`), from);
  assert.equal(seedSessionTranscript(to, other, env), false);
});

test('resolveSessionCwd reads the record from the CLAUDE_CONFIG_DIR root', () => {
  const cfg = tmp('cfg');
  const home = tmp('home');
  const env = { CLAUDE_CONFIG_DIR: cfg, HOME: home };
  writeTranscript(path.join(cfg, 'projects', key('/Users/me/real'), `${SID}.jsonl`), '/Users/me/real');
  writeTranscript(path.join(home, '.claude', 'projects', key('/Users/me/wrong'), `${SID}.jsonl`), '/Users/me/wrong');
  assert.equal(resolveSessionCwd(SID, env), '/Users/me/real');
  assert.equal(resolveSessionCwd(SID, { HOME: home }), '/Users/me/wrong');
  assert.equal(resolveSessionCwd(SID, { CLAUDE_CONFIG_DIR: tmp('empty') }), null);
});
