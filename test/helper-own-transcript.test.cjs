'use strict';
// A helper session's reply is read from its transcript. Every other Claude session started in the same folder writes
// there too, and the reader took whichever transcript was newest, so a helper could return another session's text as
// its own. A helper now starts the CLI with its own --session-id and reads only the file that CLI writes for it.
//
// The fake CLI below works out where to write the way the real one does, from its own environment and the physical
// directory it runs in. It never calls the production path code, so a wrong shared assumption fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const assistant = (text) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n';

/** Where the real CLI writes session `id`: CLAUDE_CONFIG_DIR (else $HOME/.claude), projects/, the physical cwd with
 *  every non-alphanumeric character dashed, then <id>.jsonl. */
function cliTranscript(env, cwd, id) {
  const root = env.CLAUDE_CONFIG_DIR || path.join(env.HOME, '.claude');
  return path.join(root, 'projects', fs.realpathSync(cwd).replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`);
}

/** A fake home, a working folder, and an app-private settings folder outside a fake hive. */
function sandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'helper-own-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const env = { HOME: process.env.HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  process.env.HOME = path.join(base, 'home');
  delete process.env.CLAUDE_CONFIG_DIR;
  t.after(() => {
    process.env.HOME = env.HOME;
    if (env.CLAUDE_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR;
  });
  const cwd = path.join(base, 'work');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(base, 'hive'));
  return { base, cwd };
}

/** Stub node-pty with a CLI that runs `act(file, spawn)` with the transcript path it would write, then exits. */
function fakeCli(t, act = (file) => fs.writeFileSync(file, assistant('the helper\'s own reply'))) {
  const spawns = [];
  loadTs.reset();
  const pty = require('node-pty');
  const real = pty.spawn;
  t.after(() => { pty.spawn = real; });
  pty.spawn = (file, args, opts) => {
    const i = args.indexOf('--session-id');
    const sessionId = i >= 0 ? args[i + 1] : 'no-session-id';
    const spawn = { args, sessionId, cwd: opts.cwd, transcript: cliTranscript(opts.env, opts.cwd, sessionId) };
    spawns.push(spawn);
    let onExit = () => {};
    setTimeout(() => {
      fs.mkdirSync(path.dirname(spawn.transcript), { recursive: true });
      // Another session in the same folder writes a newer transcript.
      const other = path.join(path.dirname(spawn.transcript), '11111111-2222-4333-8444-555555555555.jsonl');
      fs.writeFileSync(other, assistant('another session\'s reply'));
      const later = new Date(Date.now() + 2000);
      fs.utimesSync(other, later, later);
      act(spawn.transcript, spawn);
      onExit({ exitCode: 0 });
    }, 20);
    return { pid: undefined, onData: () => {}, onExit: (cb) => { onExit = cb; }, write: () => {}, kill: () => {} };
  };
  return spawns;
}

function helper(base) {
  const hc = loadTs('src/main/hiddenClaude.ts');
  hc.setHelperSettingsDir(path.join(base, 'userData', 'helper-sessions'), () => path.join(base, 'hive'));
  return hc;
}

test('a helper reads its own session\'s transcript, not the newest one in the folder', async (t) => {
  const { base, cwd } = sandbox(t);
  const spawns = fakeCli(t);
  const r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.equal(spawns.length, 1);
  assert.match(spawns[0].sessionId, UUID, 'the CLI is given a session id');
  assert.deepEqual(r, { ok: true, text: 'the helper\'s own reply' });
});

test('each helper gets a fresh session id', async (t) => {
  const { base, cwd } = sandbox(t);
  const spawns = fakeCli(t);
  const hc = helper(base);
  await hc.runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  await hc.runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.equal(spawns.length, 2);
  assert.notEqual(spawns[0].sessionId, spawns[1].sessionId);
});

test('a relocated CLAUDE_CONFIG_DIR is where the reply is read from', async (t) => {
  const { base, cwd } = sandbox(t);
  process.env.CLAUDE_CONFIG_DIR = path.join(base, 'relocated-config');
  const spawns = fakeCli(t);
  const r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.ok(spawns[0].transcript.startsWith(process.env.CLAUDE_CONFIG_DIR + path.sep));
  assert.deepEqual(r, { ok: true, text: 'the helper\'s own reply' });
});

test('a cwd reached through a link spawns in, and reads from, the physical folder', async (t) => {
  const { base, cwd } = sandbox(t);
  const link = path.join(base, 'link-to-work');
  fs.symlinkSync(cwd, link);
  const spawns = fakeCli(t);
  const r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd: link, timeoutMs: 5000 });
  assert.equal(spawns[0].cwd, cwd, 'the CLI runs in the physical folder');
  assert.deepEqual(r, { ok: true, text: 'the helper\'s own reply' });
});

test('an id whose transcript already exists is never used, and its old text is never returned', async (t) => {
  const { base, cwd } = sandbox(t);
  const taken = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const stale = cliTranscript({ HOME: process.env.HOME }, cwd, taken);
  fs.mkdirSync(path.dirname(stale), { recursive: true });
  fs.writeFileSync(stale, assistant('stale text from an earlier file'));
  const realUuid = crypto.randomUUID;
  t.after(() => { crypto.randomUUID = realUuid; });

  // The first id offered is taken; the helper must move on to a fresh one.
  let calls = 0;
  crypto.randomUUID = () => (calls++ === 0 ? taken : realUuid());
  let spawns = fakeCli(t);
  let r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.equal(spawns.length, 1);
  assert.notEqual(spawns[0].sessionId, taken);
  assert.deepEqual(r, { ok: true, text: 'the helper\'s own reply' });

  // Every id offered is taken: the helper refuses without starting the CLI.
  crypto.randomUUID = () => taken;
  spawns = fakeCli(t);
  r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.equal(spawns.length, 0, 'the CLI was never started');
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /stale text/);
});

test('a link at the transcript path is not read', async (t) => {
  const { base, cwd } = sandbox(t);
  const planted = path.join(base, 'planted.jsonl');
  fs.writeFileSync(planted, assistant('planted text'));
  fakeCli(t, (file) => fs.symlinkSync(planted, file));
  const r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.equal(r.ok, false);
  assert.doesNotMatch(JSON.stringify(r), /planted text/);
});

test('a transcript written after the CLI exits is the retryable no-response case, never other text', async (t) => {
  const { base, cwd } = sandbox(t);
  const spawns = fakeCli(t, (file) => setTimeout(() => fs.writeFileSync(file, assistant('late reply')), 40));
  const r = await helper(base).runHiddenClaude('hi', { model: 'm', cwd, timeoutMs: 5000 });
  assert.deepEqual(r, { ok: false, error: 'no assistant response found in transcript' });
  await new Promise((done) => setTimeout(done, 80));
  assert.ok(fs.existsSync(spawns[0].transcript), 'the reply did arrive, only late');
});
