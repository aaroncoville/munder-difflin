'use strict';
// The classifier and the lock on their own: every clock, timer and process
// listing is injected, so nothing here inspects the real machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const {
  classifyCommand, classifyHeavy, isBackground, heavyLimit, parsePsOutput, heavySlotNotice, HeavyJobLock,
  HEAVY_TTL_MS, HEAVY_SCAN_MISSES, HEAVY_RESERVE_MS
} = loadTs('src/main/heavyJob.ts');

// ── classifier ───────────────────────────────────────────────────────────────

const HEAVY = [
  ['npm ci', 'install'], ['env -u FOO npm ci > ../x.log 2>&1', 'install'], ['npm install', 'install'], ['npm i', 'install'],
  ['pnpm install', 'install'], ['yarn', 'install'], ['npm rebuild', 'install'], ['npx electron-rebuild -f', 'install'], ['node-gyp rebuild', 'install'],
  ['npm run build', 'build'], ['npm run -s build > ../b.log 2>&1', 'build'], ['npm run dist:win', 'build'], ['electron-vite build', 'build'], ['npx electron-builder --win', 'build'],
  ['npm test', 'suite'], ['npm run test:focused', 'suite'], ['node --test test/*.test.cjs', 'suite'], ['node --test', 'suite'], ['node --test test', 'suite'], ['timeout 600 node --test test/*.test.cjs', 'suite'],
  ['vitest run', 'suite'], ['cd /c/x && npm run -s typecheck && node --test test/*.test.cjs', 'suite'],
  [`node --test ${Array.from({ length: 20 }, (_, i) => `test/t${i}.test.cjs`).join(' ')}`, 'suite'],
  ['node _work/speed-driver.cjs --exe x', 'bench'], ['node test/tools/inbox-wake-mutants.cjs', 'bench'],
  ['bash -c "npm ci"', 'install'], ['cmd //c "npm run build"', 'build'], ['powershell -NoProfile -Command "npm test"', 'suite'],
  ['node --test test/*.test.cjs &', 'suite']
];
const LIGHT = [
  'node --test test/one.test.cjs', 'node --test test/a.test.cjs test/b.test.cjs', 'node --test --test-name-pattern "x y" test/a.test.cjs',
  'echo npm ci', 'grep "npm ci" README.md', 'git commit -m "run npm ci then npm run build"', 'cat package.json', 'npm run -s typecheck',
  'npx tsc --noEmit -p tsconfig.node.json', 'vitest run src/a.test.ts', 'node scripts/release-markers.cjs node_modules resources/models',
  'git log --oneline -3', 'ls node_modules', 'node -e "console.log(1)"', 'npm view electron version', ''
];
const WRAPPED_HEAVY = [
  ['bash -lc "npm test"', 'suite'], ['zsh -lc "dotnet build"', 'build'], ['bash -ic "npm ci"', 'install'], ['bash -l -c "npm test"', 'suite'],
  ['yarn build', 'build'], ['pnpm build', 'build'], ['yarn dist:mac', 'build'], ['pnpm test:unit', 'suite'],
  ['make', 'build'], ['make all', 'build'], ['make -j8 build', 'build'], ['make -j 8 test', 'suite'], ['make -C sub check', 'suite'], ['make CC=clang test', 'suite'],
  ['cargo build --release', 'build'], ['cargo +nightly check', 'build'], ['cargo run', 'build'], ['cargo clippy', 'build'], ['cargo test', 'suite'], ['cargo bench', 'bench'], ['cargo install ripgrep', 'install'],
  ['./build.sh', 'build'], ['bash build.sh', 'build'], ['sh -x scripts/compile.sh', 'build'], ['scripts/ci.sh', 'suite'], ['./test.sh', 'suite'], ['./run-tests.sh', 'suite'],
  ['npx vitest --config vitest.config.ts run', 'suite'], ['npx vitest run --reporter dot', 'suite'],
  ['result=$(npm test)', 'suite'], ['echo "$(dotnet build)"', 'build'], ['x=`npm ci`', 'install']
];
const WRAPPED_LIGHT = [
  'bash -lc "ls"', 'bash other.sh', './deploy.sh', 'yarn lint', 'pnpm lint', 'make clean', 'make -C sub lint', 'cargo fmt', 'cargo --version', 'cargo add serde', 'cargo test --help',
  'npx vitest run src/a.test.ts --reporter dot', 'x=$(git rev-parse HEAD)', "grep '$(npm ci)' notes.txt",
  'git commit -m "$(cat <<\'EOF\'\nfix npm test\nnpm ci\nEOF\n)"', "cat > notes.txt <<'EOF'\nnpm test\nEOF"
];
const DOTNET_HEAVY = [
  ['dotnet build', 'build'], ['dotnet build src/Game.sln -c Release', 'build'], ['dotnet.exe build', 'build'], ['/usr/local/share/dotnet/dotnet build', 'build'],
  ['dotnet publish -c Release', 'build'], ['dotnet pack', 'build'], ['dotnet restore', 'install'],
  ['dotnet test', 'suite'], ['dotnet test tests/Game.Tests.csproj --no-build', 'suite'], ['cd src && dotnet test 2>&1 | tail -5', 'suite'],
  ['dotnet test -- --filter x', 'suite'],
  ['dotnet run', 'build'], ['dotnet run --project src/Game -- --seed 4', 'build'], ['bash -c "dotnet test"', 'suite']
];
const DOTNET_LIGHT = [
  'dotnet test --filter FullyQualifiedName~Combat', 'dotnet test tests/x.csproj --filter Name=One', 'dotnet test --filter:Name=One', 'dotnet test --filter=Name=One',
  'dotnet test --list-tests', 'dotnet test -t', 'dotnet run --no-build', 'dotnet run --project src/Game --no-build -- --seed 4',
  'dotnet --version', 'dotnet --info', 'dotnet --list-sdks', 'dotnet format', 'dotnet new console', 'dotnet add package Foo', 'dotnet ef migrations list',
  'dotnet build --help', 'dotnet test -h', 'dotnet build-server shutdown', 'dotnet bin/Game.dll', 'dotnet /x/sdk/MSBuild.dll /nodemode:1 /nodeReuse:true',
  'echo dotnet test', 'git commit -m "fix dotnet build"'
];

test('every heavy command in the corpus is heavy, with its kind', () => {
  for (const [cmd, kind] of HEAVY) {
    const c = classifyCommand(cmd);
    assert.equal(c.heavy, true, cmd);
    assert.equal(c.kind, kind, cmd);
  }
});

test('light work stays light: single test files, echo/grep/commit text, typecheck, one vitest file', () => {
  for (const cmd of LIGHT) assert.equal(classifyCommand(cmd).heavy, false, cmd);
});

test('login-shell wrappers, script shorthand, make, cargo, build scripts and substitutions are heavy', () => {
  for (const [cmd, kind] of WRAPPED_HEAVY) {
    const c = classifyCommand(cmd);
    assert.equal(c.heavy, true, cmd);
    assert.equal(c.kind, kind, cmd);
  }
});

test('their light neighbours stay light, including text inside heredocs and single quotes', () => {
  for (const cmd of WRAPPED_LIGHT) assert.equal(classifyCommand(cmd).heavy, false, cmd);
});

test('dotnet build, test, run, publish, pack and restore are heavy, with their kinds', () => {
  for (const [cmd, kind] of DOTNET_HEAVY) {
    const c = classifyCommand(cmd);
    assert.equal(c.heavy, true, cmd);
    assert.equal(c.kind, kind, cmd);
  }
});

test('filtered or listing dotnet tests, --no-build runs, and other dotnet subcommands are light', () => {
  for (const cmd of DOTNET_LIGHT) assert.equal(classifyCommand(cmd).heavy, false, cmd);
});

test('tool input shapes (Claude Bash command, Codex argv, non-command tools) and background detection', () => {
  assert.equal(classifyHeavy('Bash', { command: 'npm ci' }).heavy, true);
  assert.equal(classifyHeavy('shell', { command: ['npm', 'run', 'build'] }).heavy, true);
  assert.equal(classifyHeavy('Read', { file_path: 'npm ci' }).heavy, false);
  assert.equal(classifyHeavy('Edit', 'x').heavy, false);
  assert.equal(isBackground({ command: 'node --test test/*.test.cjs', run_in_background: true }), true);
  assert.equal(isBackground({ command: 'npm run build &' }), true);
  assert.equal(isBackground({ command: 'npm run build' }), false);
  assert.equal(isBackground({ command: 'a && b' }), false);
});

test('heavyLimit: off, N clamped to 16, and a default of 2 for anything unreadable', () => {
  assert.equal(heavyLimit('off'), 'off');
  assert.equal(heavyLimit(0), 'off');
  assert.equal(heavyLimit(undefined), 2);
  assert.equal(heavyLimit(1), 1);
  assert.equal(heavyLimit('3'), 3);
  assert.equal(heavyLimit(99), 16);
  assert.equal(heavyLimit(-1), 2);
});

test('parsePsOutput reads pid, parent pid and the full command line, and skips what it cannot read', () => {
  assert.deepEqual(parsePsOutput('  10     1 /bin/zsh -c npm test\n 11 10 npm test \ngarbage\n'), [
    { pid: 10, parentPid: 1, commandLine: '/bin/zsh -c npm test' },
    { pid: 11, parentPid: 10, commandLine: 'npm test' }
  ]);
});

// ── the lock ─────────────────────────────────────────────────────────────────

function lock(limit, extra = {}) {
  let now = 1_000_000; let lim = limit; const logs = []; const timers = []; const told = [];
  const l = new HeavyJobLock({
    limit: () => lim, now: () => now,
    setTimer: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimer: () => {},
    log: (r) => logs.push(r), notify: (agentId, kind, until) => told.push({ agentId, kind, until }),
    ...extra
  });
  return { l, logs, timers, told, tick: (ms) => { now += ms; }, setLimit: (v) => { lim = v; } };
}
const H = { heavy: true, kind: 'suite', why: 'npm test' };
const take = (x, a, id = a) => x.l.acquire(a, H, 'npm test', id, false);

test('N=1: the first job takes the slot, another agent is denied naming the holder, the holder re-enters, its last PostToolUse frees it', () => {
  const x = lock(1);
  assert.deepEqual(x.l.acquire('a', H, 'node --test test/*.test.cjs', 'c1', false), { allow: true, acquired: true });
  const d = x.l.acquire('b', H, 'npm ci', 'b1', false);
  assert.equal(d.allow, false);
  assert.match(d.reason, /allows 1 heavy job at once and it is held by a \(suite: npm test, since \d\d:\d\d:\d\dZ\)/);
  assert.match(d.reason, /queued \(position 1\)/);
  assert.match(d.reason, /Do not retry or poll/);
  assert.deepEqual(x.l.acquire('a', H, 'npm run build', 'c2', false), { allow: true, acquired: false }, 're-entrant');
  x.l.callDone('a', 'c1');
  assert.equal(x.l.snapshot().length, 1, 'one call still running');
  x.l.callDone('a', 'c2');
  assert.equal(x.l.snapshot().length, 0, 'freed');
  assert.equal(x.logs.find((r) => r.action === 'release').reason, 'posttool');
});

test('N=2: two agents hold and the third is denied naming both', () => {
  const x = lock(2);
  assert.equal(take(x, 'a').allow, true);
  assert.equal(take(x, 'b').allow, true);
  const d = take(x, 'c');
  assert.equal(d.allow, false);
  assert.match(d.reason, /allows 2 heavy jobs at once and they are held by a \(.*\); b \(/);
});

test('off holds nothing; a live change applies at the next acquire', () => {
  const x = lock('off');
  for (const a of ['a', 'b', 'c']) assert.deepEqual(take(x, a), { allow: true, acquired: false });
  assert.equal(x.l.snapshot().length, 0);
  const y = lock(1);
  take(y, 'a');
  assert.equal(take(y, 'b').allow, false);
  y.setLimit(2);
  assert.equal(take(y, 'b').allow, true, 'raised live, and b was first in the queue');
  assert.equal(take(y, 'c').allow, false);
  y.setLimit('off');
  assert.equal(take(y, 'c').allow, true, 'off live');
});

test('a background job outlives its PostToolUse; two scans with no heavy process under its PTY free it', async () => {
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'zsh' }, { pid: 11, parentPid: 10, commandLine: 'node --test test/*.test.cjs' }, { pid: 20, parentPid: 2, commandLine: 'npm ci' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }, { agentId: 'b', pid: 2 }], probe: async () => procs });
  x.l.acquire('a', H, 'node --test test/*.test.cjs', 'bg', true);
  x.l.callDone('a', 'bg');
  assert.equal(x.l.snapshot().length, 1, 'still held after the call returned');
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'its run is still a descendant of its PTY');
  procs = procs.filter((p) => p.pid !== 11); // the other agent's npm ci is not this agent's
  for (let i = 0; i < HEAVY_SCAN_MISSES - 1; i++) { await x.l.scan(); assert.equal(x.l.snapshot().length, 1, 'one miss is not enough'); }
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'process-exit');
});

test('a running job the classifier cannot recognise in a process listing keeps its slot, because its shell still carries the command', async () => {
  const procs = [{ pid: 10, parentPid: 1, commandLine: 'claude' }, { pid: 11, parentPid: 10, commandLine: "/bin/zsh -c eval 'npx vitest run'" }, { pid: 12, parentPid: 11, commandLine: 'node /x/node_modules/vitest/vitest.mjs run' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npx vitest run', 'c1', false);
  for (let i = 0; i < HEAVY_SCAN_MISSES + 1; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
});

test('the PTY root process itself does not count as the job, even when its arguments quote the command', async () => {
  const procs = [{ pid: 10, parentPid: 1, commandLine: 'claude "please run npm test"' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm test', 'c1', false);
  await x.l.scan();
  assert.equal(x.l.status().holders[0].started, false);
});

test('the process check runs only while something is held, and frees a started foreground call that lost its PostToolUse', async () => {
  let probes = 0;
  let procs = [{ pid: 11, parentPid: 10, commandLine: 'npm ci' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => { probes++; return procs; } });
  assert.equal(x.timers.length, 0, 'nothing held: no timer');
  x.l.acquire('a', H, 'npm ci', '1', false);
  assert.equal(x.timers.length, 1, 'armed while held');
  await x.l.scan();
  assert.equal(probes, 1);
  procs = [];
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'one empty scan is not enough');
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'process-exit');
});

test('a failed process probe is not evidence that the job exited', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => { throw new Error('denied'); } });
  x.l.acquire('a', H, 'npm ci', '1', false);
  await x.l.scan(); await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
});

test('turnOver frees foreground calls that never got a PostToolUse, but not a background job', () => {
  const x = lock(1);
  take(x, 'a');
  x.l.turnOver('a');
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'turn-end');
  x.l.acquire('b', H, 'npm ci', 'bg', true);
  x.l.turnOver('b');
  assert.equal(x.l.snapshot().length, 1);
});

test('PTY exit, bulk shutdown and the TTL free a slot', () => {
  const x = lock(2);
  x.l.acquire('a', H, 'npm ci', '1', true);
  x.l.agentGone('a');
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'pty-exit');
  x.l.acquire('c', H, 'npm ci', '3', true);
  x.l.acquire('d', H, 'npm ci', '4', true);
  x.l.agentsGone(['c', 'd']);
  assert.deepEqual(x.l.snapshot(), []);
  x.l.acquire('b', H, 'npm ci', '2', true);
  x.tick(HEAVY_TTL_MS);
  assert.deepEqual(x.l.snapshot(), []);
  assert.ok(x.logs.some((r) => r.action === 'release' && r.agentId === 'b' && r.reason === 'ttl'));
});

// ── the queue ────────────────────────────────────────────────────────────────

test('a freed slot goes to the oldest waiter: first in, first out, and each is told', () => {
  const x = lock(1);
  take(x, 'a');
  assert.match(take(x, 'b').reason, /position 1/);
  assert.match(take(x, 'c').reason, /position 2/);
  x.l.callDone('a', 'a');
  assert.deepEqual(x.told.map((t) => t.agentId), ['b']);
  assert.equal(x.told[0].kind, 'suite');
  assert.equal(take(x, 'b').allow, true);
  x.l.callDone('b', 'b');
  assert.deepEqual(x.told.map((t) => t.agentId), ['b', 'c']);
});

test('a retry while queued keeps the agent\'s place instead of joining twice', () => {
  const x = lock(1);
  take(x, 'a');
  take(x, 'b');
  take(x, 'c');
  assert.match(take(x, 'b', 'b2').reason, /position 1/);
  x.l.callDone('a', 'a');
  assert.equal(take(x, 'b').allow, true);
  x.l.callDone('b', 'b');
  assert.deepEqual(x.told.map((t) => t.agentId), ['b', 'c'], 'b served once');
});

test('a reserved slot cannot be taken by anyone else, even an agent that never queued', () => {
  const x = lock(1);
  take(x, 'a');
  take(x, 'b');
  x.l.callDone('a', 'a');
  const d = take(x, 'late');
  assert.equal(d.allow, false);
  assert.match(d.reason, /reserved for b/);
  assert.equal(take(x, 'b').allow, true);
});

test('an unused reservation expires after 5 minutes and passes to the next waiter', () => {
  const x = lock(1);
  take(x, 'a');
  take(x, 'b');
  take(x, 'c');
  x.l.callDone('a', 'a');
  assert.equal(x.told[0].until, 1_000_000 + HEAVY_RESERVE_MS);
  x.tick(HEAVY_RESERVE_MS - 1);
  x.l.snapshot();
  assert.deepEqual(x.told.map((t) => t.agentId), ['b'], 'not yet');
  x.tick(1);
  x.l.snapshot();
  assert.deepEqual(x.told.map((t) => t.agentId), ['b', 'c']);
  assert.ok(x.logs.some((r) => r.action === 'reserve-expired' && r.agentId === 'b'));
  assert.equal(take(x, 'b').allow, false, 'b lost its turn');
});

test('the watcher stays armed for a reservation, so it can expire with no holder and no further hook', async () => {
  const cleared = [];
  const x = lock(1, { clearTimer: (t) => cleared.push(t) });
  const live = () => x.timers.filter((t) => !cleared.includes(t)).length;
  take(x, 'a');
  take(x, 'b');
  x.l.callDone('a', 'a');
  assert.equal(x.l.snapshot().length, 0, 'no holder left');
  assert.equal(live(), 1, 'armed for the reservation');
  x.tick(HEAVY_RESERVE_MS);
  await x.l.scan();
  assert.deepEqual(x.l.queueSnapshot().reservations, []);
  take(x, 'c');
  x.l.callDone('c', 'c');
  assert.equal(live(), 0, 'nothing held or reserved: the timer stops');
});

test('a secret in the command never reaches another agent\'s deny text, the log or the snapshot', () => {
  const x = lock(1);
  x.l.acquire('a', H, 'TOKEN=hunter2 npm test', 'c1', false);
  const d = x.l.acquire('b', H, 'TOKEN=hunter2 npm test', 'c2', false);
  x.l.acquire('a', H, 'SECOND=hunter2 npm test', 'c3', false);
  const seen = JSON.stringify([d, x.logs, x.l.snapshot(), x.l.queueSnapshot()]);
  assert.equal(seen.includes('hunter2'), false, seen);
});

test('a waiter whose agent has gone is skipped, and one that exits while reserved passes it on', () => {
  const alive = new Set(['a', 'b', 'c', 'd']);
  const x = lock(1, { alive: (id) => alive.has(id) });
  take(x, 'a');
  take(x, 'b');
  take(x, 'c');
  take(x, 'd');
  alive.delete('b');
  x.l.callDone('a', 'a');
  assert.deepEqual(x.told.map((t) => t.agentId), ['c'], 'b skipped');
  assert.ok(x.logs.some((r) => r.action === 'queue-dropped' && r.agentId === 'b'));
  alive.delete('c');
  x.l.agentGone('c');
  assert.deepEqual(x.told.map((t) => t.agentId), ['c', 'd']);
});

test('a raised limit serves the queue before anyone new', () => {
  const x = lock(1);
  take(x, 'a');
  take(x, 'b');
  x.setLimit(2);
  assert.equal(take(x, 'late').allow, false, 'the new slot is b\'s');
  assert.deepEqual(x.told.map((t) => t.agentId), ['b']);
});

test('bulk shutdown frees every holder and tells nobody, because the waiters are going too', () => {
  const x = lock(1);
  take(x, 'a');
  take(x, 'b');
  take(x, 'c');
  x.l.agentsGone(['a', 'b', 'c']);
  assert.deepEqual(x.l.snapshot(), []);
  assert.deepEqual(x.l.queueSnapshot(), { waiting: [], reservations: [] });
  assert.deepEqual(x.told, []);
});

test('a notifier that throws does not break the release', () => {
  const x = lock(1, { notify: () => { throw new Error('no'); } });
  take(x, 'a');
  take(x, 'b');
  x.l.callDone('a', 'a');
  assert.equal(x.l.snapshot().length, 0);
});

test('heavySlotNotice names the job and the deadline, and asks for no reply', () => {
  const n = heavySlotNotice('suite', Date.UTC(2026, 0, 1, 9, 5));
  assert.match(n.subject, /suite/);
  assert.match(n.subject, /09:05Z/);
  assert.match(n.body, /No reply is needed/);
});

test('two overlapping calls with the same id hold the slot until both have finished', () => {
  const x = lock(1);
  x.l.acquire('a', H, 'npm test', 'cmd:npm test', false);
  x.l.acquire('a', H, 'npm test', 'cmd:npm test', false);
  x.l.callDone('a', 'cmd:npm test');
  assert.equal(x.l.snapshot().length, 1, 'the second is still running');
  x.l.callDone('a', 'cmd:npm test');
  assert.equal(x.l.snapshot().length, 0);
});

// A call waiting at a permission prompt has no process, and nothing reports the prompt's answer.
test('a call still waiting for approval keeps its slot past any number of empty scans, then runs counted', async () => {
  let procs = [{ pid: 10, parentPid: 1, commandLine: 'claude' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm test', 'c1', false);
  assert.equal(x.l.status().holders[0].started, false);
  for (let i = 0; i < HEAVY_SCAN_MISSES + 3; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1, 'the prompt may still be open');
  assert.equal(take(x, 'b').allow, false, 'so its slot is not reassigned');
  procs = [...procs, { pid: 11, parentPid: 10, commandLine: "/bin/zsh -c eval 'npm test'" }];
  await x.l.scan();
  assert.equal(x.l.status().holders[0].started, true, 'approved, and seen running');
  assert.deepEqual(x.told, []);
  procs = procs.filter((p) => p.pid !== 11);
  for (let i = 0; i < HEAVY_SCAN_MISSES; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 0, 'seen running, then gone: its PostToolUse was lost');
  assert.deepEqual(x.told.map((t) => t.agentId), ['b']);
});

test('one running call does not let empty scans free a second call that has not started', async () => {
  let procs = [{ pid: 11, parentPid: 10, commandLine: 'npm test' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm test', 'c1', false);
  x.l.acquire('a', { heavy: true, kind: 'build', why: 'dotnet build' }, 'dotnet build', 'c2', false);
  await x.l.scan();
  x.l.callDone('a', 'c1');
  procs = [];
  for (let i = 0; i < HEAVY_SCAN_MISSES + 1; i++) await x.l.scan();
  assert.equal(x.l.snapshot().length, 1);
});

test('a job recognised by its label counts as started even when its command text is not in the listing', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => [{ pid: 11, parentPid: 10, commandLine: 'npm test' }] });
  x.l.acquire('a', H, 'FOO=1 npm test --silent', 'c1', false);
  await x.l.scan();
  assert.equal(x.l.status().holders[0].started, true);
});

test('a never-started call the agent abandoned is freed by the TTL', async () => {
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => [] });
  x.l.acquire('a', H, 'npm test', 'c1', false);
  x.tick(HEAVY_TTL_MS);
  await x.l.scan();
  assert.equal(x.l.snapshot().length, 0);
  assert.equal(x.logs.at(-1).reason, 'ttl');
});

test('the TTL runs from the last sighting, so a job confirmed live past the hour keeps its slot', async () => {
  const procs = [{ pid: 11, parentPid: 10, commandLine: 'npm test' }];
  const x = lock(1, { roots: () => [{ agentId: 'a', pid: 10 }], probe: async () => procs });
  x.l.acquire('a', H, 'npm test', 'c1', false);
  for (let i = 0; i < 4; i++) { x.tick(HEAVY_TTL_MS / 2); await x.l.scan(); assert.equal(x.l.snapshot().length, 1, `tick ${i}`); }
  assert.equal(take(x, 'b').allow, false);
});
