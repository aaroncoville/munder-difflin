'use strict';

/**
 * Seats run the provider CLI found on PATH. A pin names the version (and, optionally, the model) a seat may start
 * with, so an upgrade of the shared install cannot move running work onto an untested CLI. These check the judgement
 * a spawn makes against a pin, and that no pin leaves a launch exactly as it was.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { parseCliVersion, launchModel, judgePin, pinnedSeatEnv, cliVersion, pinFor, seatPin, judgeFinalLaunch } = loadTs('src/main/cliPins.ts');

test('the version is read from each CLI\'s own --version line', () => {
  assert.equal(parseCliVersion('claude', '2.1.332 (Claude Code)\n'), '2.1.332');
  assert.equal(parseCliVersion('codex', 'codex-cli 0.172.0\n'), '0.172.0');
  // Codex prints a PATH-alias warning first when it cannot write its aliases.
  assert.equal(parseCliVersion('codex', 'WARNING: proceeding, even though we could not create PATH aliases\ncodex-cli 0.172.0\n'), '0.172.0');
  assert.equal(parseCliVersion('claude', 'command not found'), null);
  assert.equal(parseCliVersion('codex', ''), null);
});

test('the launch model is the last --model value; -m counts for Codex only', () => {
  assert.equal(launchModel('claude', ['claude', '--model', 'claude-opus-5-5', '--permission-mode', 'bypassPermissions']), 'claude-opus-5-5');
  assert.equal(launchModel('claude', ['claude', '--model=claude-opus-5-5']), 'claude-opus-5-5');
  assert.equal(launchModel('codex', ['codex', '--remote', 'unix:///x.sock', '-m', 'gpt-5.6-sol', '-a', 'never']), 'gpt-5.6-sol');
  assert.equal(launchModel('codex', ['codex', '--model', 'a', '--model', 'b']), 'b');
  assert.equal(launchModel('claude', ['claude', '-m', 'x']), null);
  assert.equal(launchModel('codex', ['codex', 'resume', 'abc']), null);
});

test('no pin: nothing is judged and the seat env gains nothing', () => {
  assert.deepEqual(judgePin('claude', undefined, null, ['claude']), { ok: true, pinned: false });
  assert.deepEqual(pinnedSeatEnv('claude', undefined), {});
  assert.deepEqual(pinnedSeatEnv('codex', undefined), {});
});

test('a pinned seat starts only on the pinned version', () => {
  const pin = { version: '2.1.332' };
  assert.deepEqual(judgePin('claude', pin, '2.1.332', ['claude', '--model', 'claude-opus-5-5']), { ok: true, pinned: true });
  const moved = judgePin('claude', pin, '2.1.333', ['claude']);
  assert.equal(moved.ok, false);
  assert.match(moved.reason, /claude 2\.1\.333.*pinned to 2\.1\.332/);
  const unread = judgePin('codex', { version: '0.172.0' }, null, ['codex']);
  assert.equal(unread.ok, false);
  assert.match(unread.reason, /could not be read/);
});

test('a pinned model must be the one the launch line names', () => {
  const pin = { version: '0.172.0', model: 'gpt-5.6-sol' };
  assert.deepEqual(judgePin('codex', pin, '0.172.0', ['codex', '--model', 'gpt-5.6-sol']), { ok: true, pinned: true });
  const other = judgePin('codex', pin, '0.172.0', ['codex', '--model', 'gpt-5.7']);
  assert.equal(other.ok, false);
  assert.match(other.reason, /model gpt-5\.7.*pinned to gpt-5\.6-sol/);
  // A launch with no model would take whatever the CLI's catalog defaults to.
  const none = judgePin('codex', pin, '0.172.0', ['codex']);
  assert.equal(none.ok, false);
  assert.match(none.reason, /names no model/);
});

test('a pinned Claude seat has its own auto-updater turned off', () => {
  assert.deepEqual(pinnedSeatEnv('claude', { version: '2.1.332' }), { DISABLE_AUTOUPDATER: '1' });
  assert.deepEqual(pinnedSeatEnv('codex', { version: '0.172.0' }), {});
});

test('cliVersion runs the executable once per path and mtime', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pins-'));
  const exe = path.join(dir, 'claude');
  fs.writeFileSync(exe, '#!/bin/sh\necho "2.1.332 (Claude Code)"\n', { mode: 0o755 });
  let runs = 0;
  const run = (file, args) => { runs++; return require('node:child_process').spawnSync(file, args, { encoding: 'utf8' }); };
  assert.equal(cliVersion('claude', exe, {}, run), '2.1.332');
  assert.equal(cliVersion('claude', exe, {}, run), '2.1.332');
  assert.equal(runs, 1);
  fs.writeFileSync(exe, '#!/bin/sh\necho "2.1.340 (Claude Code)"\n', { mode: 0o755 });
  fs.utimesSync(exe, new Date(), new Date(Date.now() + 5000));
  assert.equal(cliVersion('claude', exe, {}, run), '2.1.340');
  assert.equal(runs, 2);
  assert.equal(cliVersion('claude', path.join(dir, 'missing'), {}, run), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a Codex -c model= / --config model= override is the launch model too', () => {
  assert.equal(launchModel('codex', ['codex', '-m', 'a', '-c', 'model="b"']), 'b');
  assert.equal(launchModel('codex', ['codex', '--config', "model='c'"]), 'c');
  assert.equal(launchModel('codex', ['codex', '-c', 'model_reasoning_effort="low"']), null);
  assert.equal(launchModel('claude', ['claude', '-c', 'model=x']), null);
});

test('a malformed cliPins entry is named as malformed, not judged as a pin', () => {
  assert.deepEqual(pinFor(undefined, 'codex'), { pin: undefined });
  assert.deepEqual(pinFor({}, 'codex'), { pin: undefined });
  assert.deepEqual(pinFor({ codex: { version: '0.172.0', model: 'm' } }, 'codex'), { pin: { version: '0.172.0', model: 'm' } });
  for (const bad of [{ codex: '0.172.0' }, { codex: { version: 172 } }, { codex: { version: '' } }, { codex: { version: '0.172.0', model: 5 } }, 'x']) {
    const r = pinFor(bad, 'codex');
    assert.ok(r.malformed, JSON.stringify(bad));
    assert.match(r.malformed, /cliPins/);
  }
});

test('a failed version read is cached for a short while, so a hung CLI does not stall every spawn', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pins-'));
  const exe = path.join(dir, 'codex');
  fs.writeFileSync(exe, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  let runs = 0;
  const run = () => { runs++; return { status: 1, stdout: '', stderr: '' }; };
  let t = 1_000_000;
  const now = () => t;
  assert.equal(cliVersion('codex', exe, {}, run, now), null);
  assert.equal(cliVersion('codex', exe, {}, run, now), null);
  assert.equal(runs, 1);
  t += 61_000;
  assert.equal(cliVersion('codex', exe, {}, run, now), null);
  assert.equal(runs, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the seat pin reads the version of the binary the PTY will launch, with the seat env and cwd', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pins-'));
  const launched = path.join(dir, 'launched-codex');
  fs.writeFileSync(launched, '#!/bin/sh\n', { mode: 0o755 });
  const seen = [];
  const run = (file, args, opts) => { seen.push({ file, cwd: opts.cwd, marker: opts.env.SEAT_MARKER }); return { status: 0, stdout: 'codex-cli 0.172.0\n', stderr: '' }; };
  const deps = {
    commandPath: (cmd) => (cmd === 'codex' ? launched : null),
    launchEnv: (env) => ({ ...env, SEAT_MARKER: 'from-launchEnv' }),
    run
  };
  const r = seatPin('codex', { codex: { version: '0.172.0', model: 'm' } }, { command: 'codex', args: ['--model', 'm'], cwd: dir, env: { X: '1' } }, deps);
  assert.deepEqual(r, { ok: true, env: {}, pin: { version: '0.172.0', model: 'm' } });
  assert.deepEqual(seen, [{ file: launched, cwd: dir, marker: 'from-launchEnv' }]);
  // Not installed where the PTY looks: refused, never probed elsewhere.
  const missing = seatPin('claude', { claude: { version: '2.1.332' } }, { command: 'claude', args: [], cwd: dir, env: {} }, deps);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /could not be read/);
  // Malformed pins refuse with the config named.
  const bad = seatPin('codex', { codex: '0.172.0' }, { command: 'codex', args: [], cwd: dir, env: {} }, deps);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /cliPins/);
  // No pin: nothing probed, nothing added.
  seen.length = 0;
  assert.deepEqual(seatPin('codex', undefined, { command: 'codex', args: [], cwd: dir, env: {} }, deps), { ok: true, env: {} });
  assert.equal(seen.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a binary is read once across seat folders; only a version-manager shim is read per folder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-pins-'));
  const plain = path.join(dir, 'bin', 'codex');
  const shim = path.join(dir, 'shims', 'codex');
  for (const p of [plain, shim]) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 }); }
  let runs = 0;
  const run = () => { runs++; return { status: 0, stdout: 'codex-cli 0.172.0\n', stderr: '' }; };
  const env = { PATH: '/usr/bin' };
  cliVersion('codex', plain, { env, cwd: path.join(dir, 'a') }, run);
  cliVersion('codex', plain, { env, cwd: path.join(dir, 'b') }, run);
  assert.equal(runs, 1);
  // A different PATH can find a different interpreter for a script, so it is read again.
  cliVersion('codex', plain, { env: { PATH: '/opt/bin' }, cwd: path.join(dir, 'b') }, run);
  assert.equal(runs, 2);
  cliVersion('codex', shim, { env, cwd: path.join(dir, 'a') }, run);
  cliVersion('codex', shim, { env, cwd: path.join(dir, 'b') }, run);
  assert.equal(runs, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the model pin is judged again on the launch line as it will finally start', () => {
  const pin = { version: '0.172.0', model: 'gpt-5.6-sol' };
  assert.deepEqual(judgeFinalLaunch('codex', pin, ['codex', '--remote', 'unix:///s', '--model', 'gpt-5.6-sol']), { ok: true, pinned: true });
  const moved = judgeFinalLaunch('codex', pin, ['codex', '--model', 'gpt-5.6-sol', '-c', 'model="other"']);
  assert.equal(moved.ok, false);
  assert.match(moved.reason, /model other/);
  assert.deepEqual(judgeFinalLaunch('codex', undefined, ['codex']), { ok: true, pinned: false });
  assert.deepEqual(judgeFinalLaunch('claude', { version: '2.1.332' }, ['claude']), { ok: true, pinned: true });
});
