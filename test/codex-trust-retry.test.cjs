'use strict';
/**
 * Codex hook trust is prepared through Codex's own app server before an agent starts. At app start many agents are
 * restored at once, and an app server that is slow to answer is not evidence of a bad hook: the step is retried, a
 * bounded number of times, one agent at a time, and refuses only once the attempts are spent. A definite answer that
 * refuses (a hook the app did not write) is final. Trust is never taken from a missing answer.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');
const { codexTestBase } = require('./codex-test-home.cjs');

const T = loadTs('src/main/codexHookTrust.ts');
const POSIX = process.platform !== 'win32';

/** A stand-in for `codex app-server`: each start is logged with its time; it then behaves as `mode` says. */
function fakeCli(t, mode) {
  const dir = codexTestBase(t, 'mdtr-');
  const log = path.join(dir, 'starts.log');
  const exe = path.join(dir, 'fake-codex');
  const body = {
    // Exits without answering.
    gone: `process.exit(0);`,
    // Says nothing for a while, then exits: a slow, silent server.
    slow: `setTimeout(() => process.exit(0), 200);`,
    // Answers, and lists a hook the app did not write.
    foreign: `const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (l) => { const m = JSON.parse(l);
        const result = m.method === 'hooks/list' ? { data: [{ hooks: [{ eventName: 'stop', source: 'project', sourcePath: '/w/.codex/hooks.json', command: 'planted', key: 'k', enabled: true, trustStatus: 'untrusted' }] }] } : {};
        process.stdout.write(JSON.stringify({ id: m.id, result }) + '\\n'); });`,
  }[mode];
  fs.writeFileSync(exe, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(log)}, Date.now() + ' start\\n');\nprocess.on('exit', () => require('fs').appendFileSync(${JSON.stringify(log)}, Date.now() + ' end\\n'));\n${body}\n`, { mode: 0o700 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'config.toml'), '');
  const ctx = { home, cwd: dir, executable: exe, env: process.env, written: { hooks: { events: ['Stop'], command: 'app-hook', timeout: 30 }, ownerToml: '' } };
  const starts = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' ')) : []);
  return { ctx, starts };
}

test('a server that never answers is tried a bounded number of times, then refused once', { skip: !POSIX }, async (t) => {
  const f = fakeCli(t, 'gone');
  const reasons = [];
  const ok = await T.seedCodexHookTrust(f.ctx, 1000, (r) => reasons.push(r), { attempts: 3, backoffMs: [10, 10] });
  assert.equal(ok, false, 'never trusted without an answer');
  assert.equal(f.starts().filter((s) => s[1] === 'start').length, 3, 'three attempts');
  assert.equal(reasons.length, 1, 'refused once');
  assert.match(reasons[0], /did not answer.*3 attempts/);
});

test('a definite refusal is not retried', { skip: !POSIX }, async (t) => {
  const f = fakeCli(t, 'foreign');
  const reasons = [];
  const ok = await T.seedCodexHookTrust(f.ctx, 5000, (r) => reasons.push(r), { attempts: 3, backoffMs: [10, 10] });
  assert.equal(ok, false);
  assert.equal(f.starts().filter((s) => s[1] === 'start').length, 1, 'one attempt');
  assert.doesNotMatch(reasons.join(), /did not answer/);
});

test('the server answering on the second try is trusted, and the agent goes on', async () => {
  const outcomes = [{ ok: false, noAnswer: true, why: 'the Codex app server did not answer' }, { ok: true }];
  let calls = 0;
  const reasons = [];
  const ok = await T.trustWithRetry(async () => outcomes[calls++], (r) => reasons.push(r), { attempts: 3, backoffMs: [1, 1] });
  assert.equal(ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(reasons, []);
});

test('preparations for agents started together run one after another', { skip: !POSIX }, async (t) => {
  const a = fakeCli(t, 'slow');
  const b = fakeCli(t, 'slow');
  await Promise.all([
    T.seedCodexHookTrust(a.ctx, 2000, () => {}, { attempts: 1 }),
    T.seedCodexHookTrust(b.ctx, 2000, () => {}, { attempts: 1 }),
  ]);
  const span = (f) => { const s = f.starts(); return [Number(s.find((x) => x[1] === 'start')[0]), Number(s.find((x) => x[1] === 'end')[0])]; };
  const [[a0, a1], [b0, b1]] = [span(a), span(b)];
  assert.ok(a1 <= b0 || b1 <= a0, `one ran inside the other: a ${a0}-${a1}, b ${b0}-${b1}`);
});
