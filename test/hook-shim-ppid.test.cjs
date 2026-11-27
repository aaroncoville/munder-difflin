'use strict';

// The Claude hook shim the app writes (<hive>/bin/cth-hook.cjs) tells the app which CLI runs a command call
// (hook_ppid, with its command name), so a heavy-job slot can be tied to it: its parent, or, when its parent is the
// shell that ran this hook, that shell's parent. It reads that itself, so the app reads no process on its own thread.
// A value the payload carried is never passed on.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

const psWorks = spawnSync('ps', ['-o', 'ppid=', '-p', String(process.pid)]).status === 0;

/** The frame the real shim sends when started by `argv` with `payload` on stdin. */
async function frame(t, argv, payload, PATH = process.env.PATH) {
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
  return JSON.parse(got.split('\n')[0]);
}

const BASH = { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } };

test('a command call names its parent as the CLI when the parent is not the hook\'s shell', { skip: !psWorks && 'ps cannot run here' }, async (t) => {
  const sent = await frame(t, (shim) => [process.execPath, shim], BASH);
  assert.equal(sent.hook_ppid, process.pid, 'this test process started it');
  assert.equal(typeof sent.hook_ppid_command, 'string');
});

test('a hook run through a shell names that shell\'s parent as the CLI', { skip: !psWorks && 'ps cannot run here' }, async (t) => {
  // `; true` keeps the shell alive as the hook's parent (no exec of the last command).
  const sent = await frame(t, (shim) => ['/bin/sh', '-c', `"${process.execPath}" "${shim}"; true`], BASH);
  assert.equal(sent.hook_ppid, process.pid, 'past the shell, to this test process');
});

test('a pid the payload carried is dropped, and a call with no command sends none', async (t) => {
  const planted = await frame(t, (shim) => [process.execPath, shim], { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, hook_ppid: 4242, hook_ppid_command: 'forged' });
  assert.equal(Object.hasOwn(planted, 'hook_ppid'), false);
  assert.equal(Object.hasOwn(planted, 'hook_ppid_command'), false);
});

test('the shim runs /bin/ps, never a program named ps earlier on the CLI\'s PATH', { skip: !psWorks && 'ps cannot run here' }, async (t) => {
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ps-'));
  t.after(() => fs.rmSync(fake, { recursive: true, force: true }));
  const marker = path.join(fake, 'ran');
  fs.writeFileSync(path.join(fake, 'ps'), `#!/bin/sh\necho ran > "${marker}"\necho "1 claude"\n`, { mode: 0o755 });
  const sent = await frame(t, (shim) => [process.execPath, shim], BASH, `${fake}:${process.env.PATH}`);
  assert.equal(fs.existsSync(marker), false, 'the fake ps was not run');
  assert.equal(sent.hook_ppid, process.pid, 'the real ps answered');
});
