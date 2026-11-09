'use strict';
// At most a set number of test suites hold the heavy-job lock at once, and the classifier reads the
// forms a suite takes in practice. Every clock, timer and process listing is injected.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { classifyCommand, HeavyJobLock, HEAVY_SCAN_MISSES, HEAVY_RESERVE_MS } = loadTs('src/main/heavyJob.ts');
const { suiteJobLimit, SUITE_DEFAULT_LIMIT } = loadTs('src/main/heavyJobRules.ts');

function lock(limit, suites, extra = {}) {
  let now = 1_000_000; const logs = []; const told = [];
  const l = new HeavyJobLock({
    limit: () => limit, suiteLimit: () => suites, now: () => now,
    setTimer: () => ({}), clearTimer: () => {},
    log: (r) => logs.push(r), notify: (agentId, kind, until) => told.push({ agentId, kind, until }),
    ...extra
  });
  return { l, logs, told, tick: (ms) => { now += ms; } };
}
const SUITE = { heavy: true, kind: 'suite', why: 'gradle test' };
const E2E = { heavy: true, kind: 'suite', why: 'e2e.sh' };
const INSTALL = { heavy: true, kind: 'install', why: 'npm ci' };
const BUILD = { heavy: true, kind: 'build', why: 'npm run build' };

// ── the suite limit ──────────────────────────────────────────────────────────

test('two suites asked for together: the second is queued, and runs when the first releases', () => {
  const x = lock(2, 1);
  assert.deepEqual(x.l.acquire('a', SUITE, './gradlew test', 'a1', false), { allow: true, acquired: true });
  const d = x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false);
  assert.equal(d.allow, false);
  assert.match(d.reason, /allows 1 test suite at a time and it is held by a \(suite: gradle test/);
  assert.match(d.reason, /queued \(position 1\)/);
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.told.map((t) => [t.agentId, t.kind]), [['b', 'suite']]);
  assert.deepEqual(x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false), { allow: true, acquired: true });
});

test('a suite and a heavy job that is not a suite run together under the overall limit', () => {
  const x = lock(2, 1);
  assert.equal(x.l.acquire('a', SUITE, './gradlew test', 'a1', false).allow, true);
  assert.equal(x.l.acquire('b', INSTALL, 'npm ci', 'b1', false).allow, true);
  assert.equal(x.l.snapshot().length, 2);
});

test('a waiting suite does not hold up a later job that is not a suite', () => {
  const x = lock(2, 1);
  x.l.acquire('a', SUITE, './gradlew test', 'a1', false);
  x.l.acquire('x', BUILD, 'npm run build', 'x1', false);
  assert.equal(x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false).allow, false, 'suites full');
  assert.equal(x.l.acquire('c', INSTALL, 'npm ci', 'c1', false).allow, false, 'overall limit full');
  x.l.callDone('x', 'x1');
  assert.deepEqual(x.told.map((t) => t.agentId), ['c'], 'the free slot goes to the install; the suite still waits');
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.told.map((t) => t.agentId), ['c', 'b'], 'and the suite runs once the other suite ends');
});

test('a suite holder that needs a heavy job that is not a suite gets it, or queues for it without blocking itself', () => {
  const x = lock(2, 1);
  x.l.acquire('a', SUITE, './gradlew test', 'a1', true); // a background suite
  assert.equal(x.l.acquire('a', INSTALL, 'npm ci', 'a2', false).allow, true, 'a free overall slot');
  x.l.callDone('a', 'a2');
  x.l.acquire('b', BUILD, 'npm run build', 'b1', false);
  assert.equal(x.l.acquire('a', INSTALL, 'npm ci', 'a3', false).allow, false, 'queued while the overall limit is full');
  x.l.callDone('b', 'b1');
  assert.deepEqual(x.told.map((t) => [t.agentId, t.kind]), [['a', 'install']], 'served when the build ends, while its suite still runs');
  assert.equal(x.l.acquire('a', INSTALL, 'npm ci', 'a3', false).allow, true);
});

test('a suite holder asking for a second suite queues behind its own, and gets it when the first ends', async () => {
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'claude' }, { pid: 11, parentPid: 10, commandLine: './gradlew test' }];
  const x = lock(2, 1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', SUITE, './gradlew test', 'a1', true); // a background suite
  x.l.callDone('a', 'a1');
  assert.equal(x.l.acquire('a', E2E, 'bash scripts/e2e.sh', 'a2', false).allow, false, 'its own suite fills the suite slot');
  await x.l.scan();
  assert.equal(x.told.length, 0, 'not while the first suite runs');
  procs = procs.filter((p) => p.pid !== 11);
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.deepEqual(x.told.map((t) => [t.agentId, t.kind]), [['a', 'suite']]);
  assert.equal(x.l.acquire('a', E2E, 'bash scripts/e2e.sh', 'a2', false).allow, true);
});

test('a crashed or interrupted suite holder releases its suite slot to the next suite', () => {
  const x = lock(2, 1);
  x.l.acquire('a', SUITE, './gradlew test', 'a1', false);
  x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false);
  x.l.turnOver('a'); // interrupted: no PostToolUse
  assert.deepEqual(x.told.map((t) => t.agentId), ['b']);
  const y = lock(2, 1);
  y.l.acquire('a', SUITE, './gradlew test', 'a1', false);
  y.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false);
  y.l.agentGone('a'); // its PTY exited
  assert.deepEqual(y.told.map((t) => t.agentId), ['b']);
});

test('a reserved suite slot lasts 5 minutes, then passes to the next suite', () => {
  const x = lock(2, 1);
  x.l.acquire('a', SUITE, './gradlew test', 'a1', false);
  x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false);
  x.l.acquire('c', SUITE, 'mvn verify', 'c1', false);
  x.l.callDone('a', 'a1');
  assert.deepEqual(x.told.map((t) => t.agentId), ['b']);
  assert.equal(x.l.acquire('d', SUITE, 'npm test', 'd1', false).allow, false, 'the reservation holds the suite slot');
  x.tick(HEAVY_RESERVE_MS);
  x.l.snapshot();
  assert.deepEqual(x.told.map((t) => t.agentId), ['b', 'c']);
  assert.ok(x.logs.some((r) => r.action === 'reserve-expired' && r.agentId === 'b'));
});

test('a reservation made for another kind of job does not let a suite past a full suite slot', () => {
  const y = lock(2, 1);
  y.l.acquire('a', SUITE, './gradlew test', 'a1', false);
  y.l.acquire('x', BUILD, 'npm run build', 'x1', false);
  y.l.acquire('b', INSTALL, 'npm ci', 'b1', false);
  y.l.callDone('x', 'x1');
  assert.deepEqual(y.told.map((t) => [t.agentId, t.kind]), [['b', 'install']]);
  assert.equal(y.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b2', false).allow, false, 'its reservation was for an install');
});

test('without a suite limit, suites only count against the overall limit, as before', () => {
  const x = lock(2, 'off');
  assert.equal(x.l.acquire('a', SUITE, './gradlew test', 'a1', false).allow, true);
  assert.equal(x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false).allow, true);
  const y = new HeavyJobLock({ limit: () => 2, setTimer: () => ({}), clearTimer: () => {} });
  assert.equal(y.acquire('a', SUITE, './gradlew test', 'a1', false).allow, true);
  assert.equal(y.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false).allow, true, 'a lock built without the setting');
  const z = lock('off', 1);
  assert.deepEqual(z.l.acquire('a', SUITE, './gradlew test', 'a1', false), { allow: true, acquired: false });
  assert.deepEqual(z.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false), { allow: true, acquired: false }, 'the lock switched off holds nothing');
});

test('the suite limit is a setting: 1 by default, raised or switched off without a code change', () => {
  assert.equal(SUITE_DEFAULT_LIMIT, 1);
  for (const v of [undefined, null, 0, -1, 17, 1.5, '2', 'on']) assert.equal(suiteJobLimit(v), 1, String(v));
  assert.equal(suiteJobLimit(2), 2);
  assert.equal(suiteJobLimit(16), 16);
  assert.equal(suiteJobLimit('off'), 'off');
  const live = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'main', f), 'utf8');
  assert.match(live('index.ts'), /^\s*suiteLimit: \(\) => suiteJobLimit\(readConfig\(\)\.suiteJobsAtOnce\),$/m);
  assert.match(live('config.ts'), /^\s*suiteJobsAtOnce: 1,$/m);
  assert.match(live('config.ts'), /^\s*heavyJobsAtOnce: 2,$/m, 'the overall default is unchanged');
});

// ── a background suite stays held while its worker runs ─────────────────────

test('a background Gradle suite stays held by its java worker, and is freed two scans after it is gone', async () => {
  let procs = [
    { pid: 10, parentPid: 1, commandLine: 'claude' },
    // A wrapper whose text says nothing about the command: a shell running a script file.
    { pid: 11, parentPid: 10, commandLine: '/bin/zsh /tmp/run-4821.sh' },
    { pid: 12, parentPid: 11, commandLine: '/usr/bin/java -Xmx64m -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain test --rerun' }
  ];
  const x = lock(2, 1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', classifyCommand('cd api && ./gradlew test --rerun -q'), 'cd api && ./gradlew test --rerun -q', 'bg', true);
  x.l.callDone('a', 'bg');
  for (let i = 0; i < HEAVY_SCAN_MISSES + 1; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'held by the java worker: the wrapper text does not name the command');
  procs = procs.filter((p) => p.pid !== 11 && p.pid !== 12);
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
});

test('a background Playwright suite stays held by its node worker', async () => {
  const procs = [
    { pid: 10, parentPid: 1, commandLine: 'claude' },
    { pid: 12, parentPid: 10, commandLine: 'node /w/web/node_modules/.bin/playwright test --reporter=line' }
  ];
  const x = lock(2, 1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', classifyCommand('npx playwright test'), 'npx playwright test', 'bg', true);
  x.l.callDone('a', 'bg');
  for (let i = 0; i < HEAVY_SCAN_MISSES + 1; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
});

// ── the classifier ───────────────────────────────────────────────────────────

const SUITES = [
  '(cd api && ./gradlew test)', '( cd api && ./gradlew test )', '{ ./gradlew test; }', 'time ./gradlew test', 'time -p npm test',
  'nohup ./gradlew test > api.log 2>&1 &', 'caffeinate -i ./gradlew test', 'caffeinate -t 3600 npm test',
  'pnpm exec playwright test', 'npm exec playwright test', 'npm exec -- playwright test', 'yarn playwright test', 'pnpm playwright test',
  'bunx playwright test', 'npx playwright@1.48.0 test', 'npx --yes playwright test',
  'npm run e2e', 'npm run e2e:ci', 'pnpm e2e', 'yarn e2e', 'npm run test:e2e', 'yarn test-e2e',
  'sh ./gradlew test', '/bin/sh ./gradlew check',
  'java -cp gradle/wrapper/gradle-wrapper.jar org.gradle.wrapper.GradleWrapperMain test',
  'node /w/node_modules/.bin/playwright test', 'node /w/node_modules/@playwright/test/cli.js test',
  './gradlew test --tests "io.example.*"', "mvn -Dtest='Foo*' test", 'mvn -Dtest=FooTest,BarTest test',
  'npx playwright test e2e/auth', 'npx playwright test --grep @smoke', 'bash scripts/e2e.sh web/e2e/one.e2e.ts',
  'bash scripts/e2e-allowance.sh', 'scripts/e2e-steel-thread.sh'
];

const LIGHT = [
  "./gradlew test --tests 'io.example.SomeTest'", './gradlew test --tests io.example.SomeTest.oneCase', 'mvn -Dtest=FooTest test',
  'npx playwright test e2e/one.e2e.ts', 'npx playwright test e2e/a.spec.ts e2e/b.spec.ts:12', 'npx playwright test --list',
  'bash -n scripts/e2e.sh', 'scripts/e2e.sh --help', 'bash scripts/e2e.sh -h', 'scripts/e2e-down.sh', 'scripts/e2e-setup.sh', 'bash scripts/e2e-logs.sh',
  'java -version', 'java -jar app.jar test', 'node scripts/playwright-report.js', 'node /w/node_modules/.bin/playwright install',
  'npm exec tsc', 'pnpm exec eslint .', 'npm run lint', 'yarn dev', 'time ls', 'nohup sleep 5', '(cd api && ls)', '{ git status; }',
  'some-unknown-tool --run everything'
];

test('suites in the forms they take in practice are suites', () => {
  for (const cmd of SUITES) {
    const c = classifyCommand(cmd);
    assert.equal(c.heavy, true, cmd);
    assert.equal(c.kind, 'suite', cmd);
  }
});

test('a single test, a listing, a help or syntax check and a stack helper are light, as the refusal says', () => {
  for (const cmd of LIGHT) assert.equal(classifyCommand(cmd).heavy, false, cmd);
});

test('the refusal still says single test files are not limited, and that is now true for these tools too', () => {
  const x = lock(1, 1);
  x.l.acquire('a', SUITE, './gradlew test', 'a1', false);
  const d = x.l.acquire('b', E2E, 'bash scripts/e2e.sh', 'b1', false);
  assert.match(d.reason, /single test files, reads and edits are not limited/);
  for (const cmd of ["./gradlew test --tests 'io.example.SomeTest'", 'mvn -Dtest=FooTest test', 'npx playwright test e2e/one.e2e.ts']) {
    assert.equal(classifyCommand(cmd).heavy, false, cmd);
  }
});
