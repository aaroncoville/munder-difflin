'use strict';
// The done message a headless seat writes into its own outbox is mail the app's router accepts as written: it is
// delivered to god's inbox with its id, act, subject and body unchanged, and filed under the sender's outbox/.sent.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { withSeatSettings } = require('./seat-settings-dir.cjs');
const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
// No Codex agents' homes in HOME: agents the app does not sandbox cannot start beside one.
require('./codex-test-home.cjs').isolateHomeForFile('md-nohomes-');

const { HiveManager } = loadTs('src/main/hive.ts');
const S = loadTs('src/core/headlessStream.ts');

test('Given a done message written into a seat\'s outbox, when the app routes mail, then god receives it as written', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-headless-route-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const hive = withSeatSettings(new HiveManager(() => home));
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'worker-1', name: 'Helper', provider: 'claude', cwd: home });
  const run = {
    ok: true, outcome: 'success', exitCode: 0, signal: null, result: 'ok', sessionId: 's-1', totalCostUsd: 0.01, subtype: 'success', error: null,
    stdout: '', stderr: '', argv: ['claude'], cwd: home, settingsFile: '/s', outputFile: '/w/report.md', timedOut: false, killSignal: null,
  };
  const msg = S.headlessDoneMessage('worker-1', run, '/w/report.md', { costRecorded: true, costReason: null });
  const id = S.writeOutboxMessage(path.join(home, 'hive'), 'worker-1', msg);

  assert.equal(hive.routeOnce(), 1);
  const inbox = hive.inbox('god-1');
  assert.equal(inbox.length, 1);
  const got = inbox[0];
  assert.equal(got.id, id, 'the id the seat wrote is kept');
  assert.equal(got.from, 'worker-1');
  assert.equal(got.to, 'god');
  assert.equal(got.act, 'done');
  assert.equal(got.requires_reply, false, 'done is terminal');
  assert.equal(got.subject, msg.subject);
  assert.equal(got.body, msg.body);
  assert.ok(fs.existsSync(path.join(home, 'hive', 'agents', 'worker-1', 'outbox', '.sent', `${id}.json`)), 'filed as sent');
});
