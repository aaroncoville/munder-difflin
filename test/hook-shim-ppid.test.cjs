'use strict';

// The Claude hook shim the app writes (<hive>/bin/cth-hook.cjs) tells the app which process started a command call's
// hook (hook_ppid: its parent pid), so the app can tie a heavy-job slot to it. The shim starts no process to find that
// out (a hook runs outside the seat's sandbox): the app judges the pid from its own process listing. A value the
// payload carried is never passed on. The hook command the app writes begins with `exec`, so a shell the CLI runs it in
// is replaced rather than left as the shim's parent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
const { HiveManager } = loadTs('src/main/hive.ts');
const { hookCommandFor } = loadTs('src/core/hookRuntime.ts');

/** A hive's generated shim, and the frame it sends when started by `argv` with `payload` on stdin. */
async function shimRun(t, argv, payload, PATH = process.env.PATH) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shim-ppid-'));
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(short, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const shim = path.join(hive.root(), 'bin', 'cth-hook.cjs');
  const sock = path.join(short, 's');
  let got = '';
  const srv = net.createServer((c) => { c.on('data', (d) => { got += d; if (got.includes('\n')) c.end('{}'); }); });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  await new Promise((resolve) => {
    const [cmd, ...args] = argv(shim);
    const child = spawn(cmd, args, { env: { PATH, ELECTRON_RUN_AS_NODE: '1', HIVE_SOCK: sock, AGENT_ID: 'ag1' } });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify(payload));
  });
  return { shim, sent: JSON.parse(got.split('\n')[0]) };
}

const BASH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } };

test('a command call sends the pid of the process that started the hook, and nothing more about processes', async (t) => {
  const { sent } = await shimRun(t, (shim) => [process.execPath, shim], BASH);
  assert.equal(sent.hook_ppid, process.pid, 'this test process started it');
  assert.equal(Object.hasOwn(sent, 'hook_ppid_command'), false);
});

test('the shim starts no process: its source uses no child_process, and a ps first on the PATH is never run', async (t) => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ps-'));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  const marker = path.join(fake, 'ran');
  for (const name of ['ps', 'sh']) fs.writeFileSync(path.join(fake, name), `#!/bin/sh\necho ran >> "${marker}"\n`, { mode: 0o755 });
  const { shim, sent } = await shimRun(t, (s) => [process.execPath, s], BASH, `${fake}:${process.env.PATH}`);
  assert.doesNotMatch(fs.readFileSync(shim, 'utf8'), /child_process/);
  assert.equal(fs.existsSync(marker), false, 'nothing on the hostile PATH was run');
  assert.equal(sent.hook_ppid, process.pid);
});

test('a pid the payload carried is dropped, and a call with no command sends none', async (t) => {
  const { sent } = await shimRun(t, (shim) => [process.execPath, shim], { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, hook_ppid: 4242, hook_ppid_command: 'forged' });
  assert.equal(Object.hasOwn(sent, 'hook_ppid'), false);
  assert.equal(Object.hasOwn(sent, 'hook_ppid_command'), false);
});

test('the shell form of the hook command execs the hook, so the shell is not left as its parent', async (t) => {
  const rt = { dir: '/h', launcher: process.execPath, shim: '/h/cth-hook.cjs', digests: {} };
  assert.match(hookCommandFor(rt, true), /^exec "/);
  assert.doesNotMatch(hookCommandFor(rt, false), /^exec /, 'the bare (Windows) form is split into an argv, not run by a shell');
  // Run through a shell as a CLI would: the shim's parent is the process that started the shell.
  const { sent } = await shimRun(t, (shim) => ['/bin/sh', '-c', `${hookCommandFor({ ...rt, shim }, true)}; true`], BASH);
  assert.equal(sent.hook_ppid, process.pid);
});
