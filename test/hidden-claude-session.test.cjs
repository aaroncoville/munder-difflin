'use strict';

/**
 * The hidden claude session (hiddenClaude.ts) and the two ways its transcript
 * capture went wrong on a real floor.
 *
 * 1. The app is routinely launched from inside a Claude Code terminal, so the
 *    Electron process carries that session's identity markers
 *    (CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...). A
 *    hidden session that inherits CLAUDE_CODE_CHILD_SESSION runs with
 *    transcript saving OFF: it answers the prompt (a full model call) and
 *    writes nothing to disk, so every capture ends in 'no assistant response
 *    found in transcript'. Agent PTYs were given the strip (ptyEnv.ts) in
 *    2026-08; hidden sessions never were, which is the whole of god's
 *    six-in-a-row condense-abort run on 2026-10-20.
 *
 * 2. The capture used to read the NEWEST .jsonl in the cwd's project dir. The
 *    god agent runs in the harness home, the very cwd the reflect loop uses,
 *    so a hidden session could be handed god's last reply as its own answer.
 *    The session id is now ours (`--session-id`), and the lookup is exact.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// A fake home so projectDir() (transcript.ts) resolves under a temp dir —
// os.homedir() honours $HOME — and no test ever reads a real transcript.
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-home-'));
process.env.HOME = home;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-cwd-'));

/** Every spawn the stub saw: {file, args, opts, exitCb, writes}. */
const spawns = [];
/** What the fake process does once the session has wired its exit handler. */
let onSpawned = () => {};

// node-pty is a bare (node_modules) import, which the loader hands to Node's
// own `require`, so the stand-in goes into Node's module cache rather than
// the loader's: no real PTY is ever opened by this file.
const ptyModulePath = require.resolve('node-pty');
require.cache[ptyModulePath] = {
  id: ptyModulePath,
  filename: ptyModulePath,
  loaded: true,
  exports: {
    spawn: (file, args, opts) => {
      const rec = { file, args, opts, exitCb: null, writes: [] };
      spawns.push(rec);
      return {
        pid: 4242,
        onData: () => {},
        onExit: (cb) => { rec.exitCb = cb; setImmediate(() => onSpawned(rec)); },
        write: (d) => rec.writes.push(d),
        kill: () => {},
        resize: () => {}
      };
    }
  }
};
loadTs.stub('src/main/procKill.ts', { ensureKilled: () => {} });
loadTs.stub('src/main/shellEnv.ts', {
  resolveCommand: (c) => c,
  userShellPath: () => '/stub/bin'
});

const { runHiddenClaude, hiddenTranscriptPath } = loadTs('src/main/hiddenClaude.ts');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sessionIdOf(rec) {
  const i = rec.args.indexOf('--session-id');
  assert.notEqual(i, -1, 'the hidden session passes --session-id');
  return rec.args[i + 1];
}

function writeTranscript(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

const assistant = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

const run = () => runHiddenClaude('summarize this', {
  model: 'claude-haiku-5-5', cwd, bootCapMs: 5, idleMs: 5, timeoutMs: 2000,
  env: { MEMPALACE_PATH: '/palace' }
});

test('repro: the parent Claude session\'s identity markers never reach the hidden session', async () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  process.env.CLAUDECODE = '1';
  process.env.CLAUDE_CODE_SESSION_ID = 'parent-session';
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = 'secret';
  process.env.CLAUDE_CONFIG_DIR = '/operator/config';
  onSpawned = (rec) => rec.exitCb({ exitCode: 0, signal: 0 });

  const r = await run();
  assert.equal(r.ok, false);
  assert.match(r.error, /no assistant response found in transcript \(transcript file was never written\)/);

  const env = spawns[spawns.length - 1].opts.env;
  // The marker that silently disables transcript saving, and its siblings.
  assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
  assert.equal(env.CLAUDECODE, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  // Operator configuration is not identity and still flows through.
  assert.equal(env.CLAUDE_CONFIG_DIR, '/operator/config');
  // The user-shell PATH and the caller's own env land on top.
  assert.equal(env.PATH, '/stub/bin');
  assert.equal(env.MEMPALACE_PATH, '/palace');
});

test('the transcript is read from the session id we chose, never from a sibling session in the same cwd', async () => {
  onSpawned = (rec) => {
    const sid = sessionIdOf(rec);
    assert.match(sid, UUID);
    const own = hiddenTranscriptPath(cwd, sid);
    writeTranscript(own, [{ type: 'user' }, assistant('<<<CONDENSED>>> the real answer')]);
    // A sibling session (god runs in this cwd) that is newer than ours.
    const sibling = path.join(path.dirname(own), 'another-session.jsonl');
    writeTranscript(sibling, [assistant('god\'s last reply, not ours')]);
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(sibling, later, later);
    rec.exitCb({ exitCode: 0, signal: 0 });
  };

  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.text, '<<<CONDENSED>>> the real answer');
});

test('a transcript with no assistant text is reported as such, distinct from one never written', async () => {
  onSpawned = (rec) => {
    writeTranscript(hiddenTranscriptPath(cwd, sessionIdOf(rec)), [{ type: 'user' }]);
    rec.exitCb({ exitCode: 1, signal: 0 });
  };

  const r = await run();
  assert.equal(r.ok, false);
  assert.match(r.error, /no assistant response found in transcript \(transcript has no assistant text\)/);
});

test('each call gets its own session id', async () => {
  onSpawned = (rec) => rec.exitCb({ exitCode: 0, signal: 0 });
  await run();
  await run();
  const ids = spawns.slice(-2).map(sessionIdOf);
  assert.notEqual(ids[0], ids[1]);
});
