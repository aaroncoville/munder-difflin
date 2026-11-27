'use strict';

// The Claude hook shim the app writes (<hive>/bin/cth-hook.cjs) tells the app its parent process, as hook_ppid, so a
// heavy-job slot can be tied to the CLI that asked for it.

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

test('the hook shim sends its parent pid with each hook', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-shim-ppid-'));
  const short = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(short, { recursive: true, force: true }); });
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  const shim = path.join(hive.root(), 'bin', 'cth-hook.cjs');
  const sock = path.join(short, 's');
  let frame = '';
  const srv = net.createServer((c) => { c.on('data', (d) => { frame += d; if (frame.includes('\n')) c.end('{}'); }); });
  await new Promise((r) => srv.listen(sock, r));
  t.after(() => srv.close());
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [shim], { env: { PATH: process.env.PATH, ELECTRON_RUN_AS_NODE: '1', HIVE_SOCK: sock, AGENT_ID: 'ag1' } });
    child.on('close', resolve);
    child.stdin.end(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }));
  });
  const sent = JSON.parse(frame.split('\n')[0]);
  assert.equal(sent.hook_ppid, process.pid, 'its parent is this test process, which started it');
});
