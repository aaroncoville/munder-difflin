'use strict';

/**
 * The hidden claude session (hiddenClaude.ts) and the ways its transcript
 * capture went wrong on a real floor.
 *
 * 1. The app is routinely launched from inside a Claude Code terminal, so the
 *    Electron process carries that session's identity markers
 *    (CLAUDE_CODE_CHILD_SESSION, CLAUDECODE, CLAUDE_CODE_SESSION_ID, ...). A
 *    hidden session that inherits CLAUDE_CODE_CHILD_SESSION runs with
 *    transcript saving OFF: it answers the prompt (a full model call) and
 *    writes nothing to disk, so every capture ends in 'no assistant response
 *    found in transcript'. Agent PTYs were given a strip (ptyEnv.ts) in
 *    2026-08; hidden sessions never were, which is the whole of god's
 *    six-in-a-row condense-abort run on 2026-10-20. The strip is a denylist,
 *    so operator configuration (a Foundry/Bedrock/Vertex selection, the
 *    config dir) still reaches the session.
 *
 * 2. The capture used to read the NEWEST .jsonl in the cwd's project dir. The
 *    god agent runs in the harness home, the very cwd the reflect loop uses,
 *    so a hidden session could be handed god's last reply as its own answer.
 *    The session id is now ours (`--session-id`), and the lookup is exact.
 *
 * 3. Where that file lives is Claude Code's choice, not ours: under
 *    $CLAUDE_CONFIG_DIR when the session runs with one (else ~/.claude), and
 *    under the CURRENT project key — a new session never writes to a legacy
 *    keyed directory, even when one exists. The expected paths below are
 *    computed from env + cwd here, independently of the code under test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// A fake home so nothing here ever reads a real transcript (os.homedir()
// honours $HOME).
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-home-'));
process.env.HOME = home;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-cwd-'));

/** Claude Code's effective transcript path for a NEW session: every
 *  non-alphanumeric character of the cwd dashed, under <config dir>/projects. */
function claudeTranscriptPath(configDir, sessionId) {
  return path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
}
/** The pre-2026 POSIX key (leading slash dropped, only slashes dashed). */
function legacyProjectDirOf(configDir) {
  return path.join(configDir, 'projects', cwd.replace(/^\//, '').replaceAll('/', '-'));
}

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

const { runHiddenClaude } = loadTs('src/main/hiddenClaude.ts');

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

const exitClean = (rec) => rec.exitCb({ exitCode: 0, signal: 0 });

const run = (env = { MEMPALACE_PATH: '/palace' }) => runHiddenClaude('summarize this', {
  model: 'claude-haiku-5-5', cwd, bootCapMs: 5, idleMs: 5, timeoutMs: 2000, env
});

const MARKERS = {
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDECODE: '1',
  CLAUDE_CODE_SESSION_ID: 'parent-session',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1'
};
const FOUNDRY = {
  CLAUDE_CODE_USE_FOUNDRY: '1',
  ANTHROPIC_FOUNDRY_RESOURCE: 'my-resource',
  CLAUDE_CODE_SKIP_FOUNDRY_AUTH: '1',
  CLAUDE_CODE_USE_ANTHROPIC_AWS: '0',
  CLAUDE_CODE_USE_MANTLE: '0',
  CLAUDE_CODE_ENABLE_TELEMETRY: '1'
};

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  const restore = () => {
    for (const k of Object.keys(vars)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  };
  return fn().finally(restore);
}

test('repro: the parent Claude session\'s identity markers never reach the hidden session; configuration does', async () => {
  await withEnv({ ...MARKERS, ...FOUNDRY, CLAUDE_CONFIG_DIR: '/operator/config' }, async () => {
    onSpawned = exitClean;
    const r = await run();
    assert.equal(r.ok, false);
    assert.match(r.error, /no assistant response found in transcript \(transcript file was never written\)/);

    const env = spawns[spawns.length - 1].opts.env;
    for (const k of Object.keys(MARKERS)) assert.equal(env[k], undefined, `${k} must be stripped`);
    for (const [k, v] of Object.entries(FOUNDRY)) assert.equal(env[k], v, `${k} must survive`);
    assert.equal(env.CLAUDE_CONFIG_DIR, '/operator/config');
    assert.equal(env.HOME, home);
    assert.equal(env.PATH, '/stub/bin');
    assert.equal(env.MEMPALACE_PATH, '/palace');
  });
});

test('the transcript is read from the session id we chose, never from a sibling session in the same cwd', async () => {
  onSpawned = (rec) => {
    const sid = sessionIdOf(rec);
    assert.match(sid, UUID);
    const own = claudeTranscriptPath(path.join(home, '.claude'), sid);
    writeTranscript(own, [{ type: 'user' }, assistant('<<<CONDENSED>>> the real answer')]);
    // A sibling session (god runs in this cwd) that is newer than ours.
    const sibling = path.join(path.dirname(own), 'another-session.jsonl');
    writeTranscript(sibling, [assistant('god\'s last reply, not ours')]);
    const later = new Date(Date.now() + 10_000);
    fs.utimesSync(sibling, later, later);
    exitClean(rec);
  };
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.text, '<<<CONDENSED>>> the real answer');
});

test('an exported CLAUDE_CONFIG_DIR is where the transcript is looked for', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-cfg-'));
  await withEnv({ CLAUDE_CONFIG_DIR: configDir }, async () => {
    onSpawned = (rec) => {
      const sid = sessionIdOf(rec);
      // The same session id under ~/.claude is NOT this session's file.
      writeTranscript(claudeTranscriptPath(path.join(home, '.claude'), sid), [assistant('wrong root')]);
      writeTranscript(claudeTranscriptPath(configDir, sid), [assistant('from the config dir')]);
      exitClean(rec);
    };
    const r = await run();
    assert.equal(r.ok, true);
    assert.equal(r.text, 'from the config dir');
  });
});

test('a CLAUDE_CONFIG_DIR given to the session itself wins over the process one', async () => {
  const processDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-cfg-proc-'));
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hidden-cfg-sess-'));
  await withEnv({ CLAUDE_CONFIG_DIR: processDir }, async () => {
    onSpawned = (rec) => {
      const sid = sessionIdOf(rec);
      assert.equal(rec.opts.env.CLAUDE_CONFIG_DIR, sessionDir);
      writeTranscript(claudeTranscriptPath(processDir, sid), [assistant('process dir')]);
      writeTranscript(claudeTranscriptPath(sessionDir, sid), [assistant('session dir')]);
      exitClean(rec);
    };
    const r = await run({ CLAUDE_CONFIG_DIR: sessionDir });
    assert.equal(r.ok, true);
    assert.equal(r.text, 'session dir');
  });
});

test('when both a legacy and a current project directory exist, a new session is read from the current one', async () => {
  const configDir = path.join(home, '.claude');
  onSpawned = (rec) => {
    const sid = sessionIdOf(rec);
    const legacy = legacyProjectDirOf(configDir);
    assert.notEqual(legacy, path.dirname(claudeTranscriptPath(configDir, sid)));
    writeTranscript(path.join(legacy, `${sid}.jsonl`), [assistant('stale legacy copy')]);
    writeTranscript(claudeTranscriptPath(configDir, sid), [assistant('current key')]);
    exitClean(rec);
  };
  const r = await run();
  assert.equal(r.ok, true);
  assert.equal(r.text, 'current key');
});

test('only a legacy directory existing does not move a new session\'s transcript there', async () => {
  const configDir = path.join(home, '.claude');
  onSpawned = (rec) => {
    const sid = sessionIdOf(rec);
    fs.rmSync(path.dirname(claudeTranscriptPath(configDir, sid)), { recursive: true, force: true });
    writeTranscript(path.join(legacyProjectDirOf(configDir), `${sid}.jsonl`), [assistant('stale legacy copy')]);
    exitClean(rec);
  };
  const r = await run();
  assert.equal(r.ok, false);
  assert.match(r.error, /transcript file was never written/);
});

test('without CLAUDE_CODE_SKIP_PROMPT_HISTORY the transcript is left where the CLI wrote it', async () => {
  let file;
  onSpawned = (rec) => {
    file = claudeTranscriptPath(path.join(home, '.claude'), sessionIdOf(rec));
    writeTranscript(file, [assistant('kept')]);
    exitClean(rec);
  };
  const r = await run();
  assert.equal(r.text, 'kept');
  assert.equal(fs.existsSync(file), true);
});

test('CLAUDE_CODE_SKIP_PROMPT_HISTORY in the inherited env: stripped for the session, honoured by deleting the transcript once read', async () => {
  await withEnv({ CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1' }, async () => {
    let file;
    onSpawned = (rec) => {
      // The session itself must not see the flag, or it would write nothing.
      assert.equal(rec.opts.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, undefined);
      file = claudeTranscriptPath(path.join(home, '.claude'), sessionIdOf(rec));
      writeTranscript(file, [assistant('read once, then gone')]);
      exitClean(rec);
    };
    const r = await run();
    assert.equal(r.ok, true);
    assert.equal(r.text, 'read once, then gone');
    assert.equal(fs.existsSync(file), false, 'no prompt history left on disk');

    // The same when the session produced no usable answer.
    onSpawned = (rec) => {
      file = claudeTranscriptPath(path.join(home, '.claude'), sessionIdOf(rec));
      writeTranscript(file, [{ type: 'user' }]);
      exitClean(rec);
    };
    const r2 = await run();
    assert.equal(r2.ok, false);
    assert.equal(fs.existsSync(file), false);
  });
});

test('a transcript with no assistant text is reported as such, distinct from one never written', async () => {
  onSpawned = (rec) => {
    writeTranscript(claudeTranscriptPath(path.join(home, '.claude'), sessionIdOf(rec)), [{ type: 'user' }]);
    rec.exitCb({ exitCode: 1, signal: 0 });
  };
  const r = await run();
  assert.equal(r.ok, false);
  assert.match(r.error, /no assistant response found in transcript \(transcript has no assistant text\)/);
});

test('each call gets its own session id', async () => {
  onSpawned = exitClean;
  await run();
  await run();
  const ids = spawns.slice(-2).map(sessionIdOf);
  assert.notEqual(ids[0], ids[1]);
});
