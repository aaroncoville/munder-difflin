'use strict';

// `hive tasks add|patch|ask`: a command-line way to edit the task ledger
// (tasks.json) that takes the ledger lock, so an agent or a service editing a
// card cannot interleave its write with the app's or another process's.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { runHiveCli } = loadTs('src/core/hiveCli.ts');

function hive(t, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'tasks.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return { dir, file, lock: `${file}.lock` };
}

/** Runs the CLI in this process and captures what it prints. */
function run(argv, env = {}, readFile) {
  let stdout = '';
  let stderr = '';
  const io = { stdout: (s) => { stdout += s; }, stderr: (s) => { stderr += s; } };
  if (readFile) io.readFile = readFile;
  const code = runHiveCli(argv, env, io);
  return { code, stdout, stderr };
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const card = (file, id) => read(file).tasks.find((c) => c.id === id);

test('add appends a card that is not there yet', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', title: 'A' }] });
  const r = run(['--hive', dir, 'tasks', 'add', '--json', '{"id":"b","title":"B","status":"todo"}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'added b\n');
  assert.deepEqual(read(file).tasks.map((c) => c.id), ['a', 'b']);
  assert.equal(card(file, 'b').title, 'B');
  assert.equal(fs.existsSync(`${file}.lock`), false, 'the lock is released');
});

test('add leaves an existing card alone and says so', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', title: 'A' }] });
  const before = fs.readFileSync(file, 'utf8');
  const r = run(['tasks', 'add', '--json', '{"id":"a","title":"other"}'], { HIVE_ROOT: dir });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'exists a\n');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('add creates tasks.json when the hive has none', (t) => {
  const { dir, file } = hive(t);
  const r = run(['--hive', dir, 'tasks', 'add', '--json', '{"id":"a"}']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(read(file).tasks.map((c) => c.id), ['a']);
});

test('add refuses a card without a string id', (t) => {
  const { dir, file } = hive(t, { tasks: [] });
  for (const json of ['{"title":"no id"}', '{"id":7}', '{"id":""}', '[{"id":"a"}]', '"a"']) {
    const r = run(['--hive', dir, 'tasks', 'add', '--json', json]);
    assert.equal(r.code, 1, json);
    assert.match(r.stderr, /"id"|JSON object/, json);
  }
  assert.deepEqual(read(file).tasks, []);
});

test('patch merges fields into the card, keeps its other fields and its id', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', title: 'A', status: 'todo', repo: 'x' }, { id: 'b', title: 'B' }] });
  const r = run(['--hive', dir, 'tasks', 'patch', 'a', '--json', '{"status":"doing","id":"a","note":"n"}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'patched a\n');
  const a = card(file, 'a');
  assert.equal(a.status, 'doing');
  assert.equal(a.note, 'n');
  assert.equal(a.title, 'A');
  assert.equal(a.repo, 'x');
  assert.deepEqual(read(file).tasks.map((c) => c.id), ['a', 'b'], 'the id is preserved and no card is added');
  const { updatedAt, ...b } = card(file, 'b');
  assert.deepEqual(b, { id: 'b', title: 'B' }, 'the other card keeps its fields (the ledger may stamp updatedAt)');
});

test('patch refuses to clear the assignee, and writes nothing', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', assignee: 'x', status: 'doing' }] });
  const before = fs.readFileSync(file, 'utf8');
  for (const json of ['{"assignee":null}', '{"assignee":""}', '{"assignee":7}', '{"assignee":["y"]}', '{"status":"done","assignee":null}', '{"assignee":"  "}', '{"assignee":"\\t\\n"}',
    // Characters that show nothing: zero-width space, joiners, word joiner, BOM, soft hyphen, Hangul filler.
    '{"assignee":"\\u200b"}', '{"assignee":"\\u200c\\u200d"}', '{"assignee":" \\u2060\\ufeff "}', '{"assignee":"\\u00ad"}', '{"assignee":"\\u3164"}', '{"assignee":"\\u2800"}']) {
    const r = run(['--hive', dir, 'tasks', 'patch', 'a', '--json', json]);
    assert.equal(r.code, 1, json);
    assert.match(r.stderr, /assignee/, json);
    assert.equal(r.stdout, '', json);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('patch may hand the card to another assignee', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', assignee: 'x' }] });
  const r = run(['--hive', dir, 'tasks', 'patch', 'a', '--json', '{"assignee":"y"}']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(card(file, 'a').assignee, 'y');
});

test('patch refuses any humanQA, so the question and answer history cannot be rewritten or erased', (t) => {
  const prior = [{ q: 'old', askedAt: '2026-01-01T00:00:00.000Z', a: 'ans' }];
  const { dir, file } = hive(t, { tasks: [{ id: 'a', assignee: 'x', humanQA: prior }] });
  const before = fs.readFileSync(file, 'utf8');
  for (const json of ['{"humanQA":[]}', '{"humanQA":null}', '{"humanQA":"x"}', `{"humanQA":${JSON.stringify([...prior, { q: 'new' }])}}`,
    '{"assignee":null,"humanQA":[]}']) {
    const r = run(['--hive', dir, 'tasks', 'patch', 'a', '--json', json]);
    assert.equal(r.code, 1, json);
    assert.match(r.stderr, /humanQA|assignee/, json);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(card(file, 'a').humanQA, prior);
});

test('patch refuses to change the card id, and writes nothing', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }, { id: 'b' }] });
  const before = fs.readFileSync(file, 'utf8');
  for (const json of ['{"id":"zzz"}', '{"id":"b"}', '{"id":null}', '{"id":7}']) {
    const r = run(['--hive', dir, 'tasks', 'patch', 'a', '--json', json]);
    assert.equal(r.code, 1, json);
    assert.match(r.stderr, /"id"/, json);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('patch of an unknown id fails and writes nothing', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.readFileSync(file, 'utf8');
  const r = run(['--hive', dir, 'tasks', 'patch', 'nope', '--json', '{"status":"done"}']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no card with id nope/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('ask appends the question to humanQA, keeps earlier entries, and blocks the card', (t) => {
  const prior = [{ q: 'first?', askedAt: '2026-01-01T00:00:00.000Z', a: 'yes', answeredAt: '2026-01-02T00:00:00.000Z' }];
  const { dir, file } = hive(t, { tasks: [{ id: 'a', status: 'doing', humanQA: prior }] });
  const qFile = path.join(dir, 'q.txt');
  fs.writeFileSync(qFile, 'Which "branch" should it target?\nmain or next?\n');
  const before = Date.now();
  const r = run(['--hive', dir, 'tasks', 'ask', 'a', '--q-file', qFile]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'asked a\n');
  const a = card(file, 'a');
  assert.equal(a.status, 'blocked');
  assert.equal(a.humanQA.length, 2);
  assert.deepEqual(a.humanQA[0], prior[0]);
  assert.equal(a.humanQA[1].q, 'Which "branch" should it target?\nmain or next?');
  assert.ok(Date.parse(a.humanQA[1].askedAt) >= before - 1000, 'askedAt is now, as an ISO time');
  assert.equal(new Date(a.humanQA[1].askedAt).toISOString(), a.humanQA[1].askedAt);
});

test('ask creates humanQA on a card that has none', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', status: 'todo' }] });
  const r = run(['--hive', dir, 'tasks', 'ask', 'a', '--q-file', 'virtual.txt'], {}, (p) => {
    assert.equal(p, 'virtual.txt');
    return 'why?';
  });
  assert.equal(r.code, 0, r.stderr);
  const a = card(file, 'a');
  assert.equal(a.status, 'blocked');
  assert.deepEqual(a.humanQA.map((e) => e.q), ['why?']);
});

test('ask of an unknown id fails and writes nothing', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.readFileSync(file, 'utf8');
  const r = run(['--hive', dir, 'tasks', 'ask', 'nope', '--q-file', 'q'], {}, () => 'why?');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no card with id nope/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('ask refuses a humanQA that is not a list rather than replace it', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', humanQA: 'free text' }] });
  const before = fs.readFileSync(file, 'utf8');
  const r = run(['--hive', dir, 'tasks', 'ask', 'a', '--q-file', 'q'], {}, () => 'why?');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /humanQA/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('--json @path reads the JSON from a file', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a', title: 'A' }] });
  const cardFile = path.join(dir, 'card.json');
  fs.writeFileSync(cardFile, JSON.stringify({ id: 'b', title: "it's \"quoted\"" }));
  const patchFile = path.join(dir, 'patch.json');
  fs.writeFileSync(patchFile, JSON.stringify({ title: 'A2' }));
  assert.equal(run(['--hive', dir, 'tasks', 'add', '--json', `@${cardFile}`]).code, 0);
  assert.equal(run(['--hive', dir, 'tasks', 'patch', 'a', `--json=@${patchFile}`]).code, 0);
  assert.equal(card(file, 'b').title, "it's \"quoted\"");
  assert.equal(card(file, 'a').title, 'A2');
});

test('a --json or --q-file file over 1 MB is refused and nothing is written', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.readFileSync(file, 'utf8');
  const MB = 1024 * 1024;
  // A card of exactly 1 MB is accepted; one byte more is not.
  const sized = (id, bytes) => {
    const head = `{"id":"${id}","pad":"`;
    return head + 'x'.repeat(bytes - head.length - 2) + '"}';
  };
  const big = path.join(dir, 'big.json');
  fs.writeFileSync(big, sized('b', MB + 1));
  const bigQ = path.join(dir, 'big.txt');
  fs.writeFileSync(bigQ, 'q'.repeat(MB + 1));
  for (const argv of [['tasks', 'add', '--json', `@${big}`], ['tasks', 'patch', 'a', '--json', `@${big}`], ['tasks', 'ask', 'a', '--q-file', bigQ]]) {
    const r = run(['--hive', dir, ...argv]);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.stderr, /larger than 1 MB/, argv.join(' '));
  }
  assert.equal(fs.readFileSync(file, 'utf8'), before);

  const atLimit = path.join(dir, 'limit.json');
  fs.writeFileSync(atLimit, sized('c', MB));
  assert.equal(fs.statSync(atLimit).size, MB);
  const ok = run(['--hive', dir, 'tasks', 'add', '--json', `@${atLimit}`]);
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(card(file, 'c').pad.length, MB - '{"id":"c","pad":"'.length - 2);
});

test('a missing hive root is a usage error', () => {
  const r = run(['tasks', 'add', '--json', '{"id":"a"}'], {});
  assert.equal(r.code, 2);
  assert.match(r.stderr, /HIVE_ROOT/);
  assert.match(r.stderr, /usage: hive/);
});

test('--hive wins over HIVE_ROOT', (t) => {
  const { dir, file } = hive(t, { tasks: [] });
  const other = hive(t, { tasks: [] });
  assert.equal(run(['--hive', dir, 'tasks', 'add', '--json', '{"id":"a"}'], { HIVE_ROOT: other.dir }).code, 0);
  assert.deepEqual(read(file).tasks.map((c) => c.id), ['a']);
  assert.deepEqual(read(other.file).tasks, []);
});

test('a hive root that is not a folder fails without creating anything', (t) => {
  const { dir } = hive(t);
  const missing = path.join(dir, 'nowhere');
  const r = run(['--hive', missing, 'tasks', 'add', '--json', '{"id":"a"}']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /nowhere/);
  assert.equal(fs.existsSync(missing), false);
});

test('--help prints the usage to stdout and exits 0, wherever it is given', () => {
  for (const argv of [['--help'], ['-h'], ['tasks', '--help'], ['tasks', 'add', '--help'], ['--hive', '/nowhere', 'tasks', 'patch', 'a', '-h']]) {
    const r = run(argv, {});
    assert.equal(r.code, 0, argv.join(' '));
    assert.match(r.stdout, /^usage: hive /, argv.join(' '));
    assert.equal(r.stderr, '', argv.join(' '));
  }
});

test('no arguments and bad arguments print the usage to stderr and exit 2', () => {
  for (const argv of [[], ['tasks'], ['tasks', 'frobnicate'], ['jobs', 'list'],
    ['tasks', 'add'], ['tasks', 'patch', '--json', '{}'], ['tasks', 'ask', 'a'], ['tasks', 'add', '--json'],
    ['tasks', 'add', '--json', '{"id":"a"}', '--bogus'], ['tasks', 'patch', 'a', 'b', '--json', '{}']]) {
    const r = run(argv, { HIVE_ROOT: os.tmpdir() });
    assert.equal(r.code, 2, argv.join(' '));
    assert.match(r.stderr, /usage: hive/, argv.join(' '));
    assert.equal(r.stdout, '', argv.join(' '));
    assert.match(r.stderr, /@path|@<path>/, 'the usage says --json takes @path');
  }
});

test('bad JSON fails with the parser message and writes nothing', (t) => {
  const { dir, file } = hive(t, { tasks: [{ id: 'a' }] });
  const before = fs.readFileSync(file, 'utf8');
  for (const argv of [['tasks', 'add', '--json', '{id:a}'], ['tasks', 'patch', 'a', '--json', '{"status":']]) {
    const r = run(['--hive', dir, ...argv]);
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.stderr, /JSON/, argv.join(' '));
  }
  const missing = run(['--hive', dir, 'tasks', 'add', '--json', `@${path.join(dir, 'missing.json')}`]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /missing\.json/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a corrupt tasks.json is refused and left exactly as it was', (t) => {
  const { dir, file } = hive(t, '{"tasks": [ {"id": "a"');
  const r = run(['--hive', dir, 'tasks', 'add', '--json', '{"id":"b"}']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"tasks": [ {"id": "a"');
  assert.deepEqual(fs.readdirSync(dir), ['tasks.json'], 'no lock or temporary file is left');
});

test('a tasks.json that is valid JSON but not a ledger is refused and left exactly as it was', (t) => {
  for (const text of ['[{"id":"legacy"}]', '{"tasks":{"x":1}}']) {
    const { dir, file } = hive(t, text);
    const r = run(['--hive', dir, 'tasks', 'add', '--json', '{"id":"C"}']);
    assert.equal(r.code, 1, text);
    assert.match(r.stderr, /not a task ledger/, text);
    assert.equal(fs.readFileSync(file, 'utf8'), text);
    assert.deepEqual(fs.readdirSync(dir), ['tasks.json'], 'no lock or temporary file is left');
  }
});

test('a lock held by another live process times out with exit 75, naming the holder', async (t) => {
  const { dir, file, lock } = hive(t, { tasks: [{ id: 'a' }] });
  const holder = spawn(process.execPath, ['-e', `
    const fs = require('node:fs'); const os = require('node:os');
    fs.writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid, host: os.hostname(), acquiredAt: new Date().toISOString() }), { flag: 'wx' });
    process.stdout.write('held\\n');
    setTimeout(() => {}, 60000);`, lock], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => holder.kill());
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const before = fs.readFileSync(file, 'utf8');
  const started = Date.now();
  const r = run(['--hive', dir, 'tasks', 'add', '--json', '{"id":"b"}'], { HIVE_TASKS_LOCK_TIMEOUT_MS: '200' });
  assert.equal(r.code, 75, r.stderr);
  assert.ok(Date.now() - started < 3000, 'the timeout from the environment was used');
  assert.match(r.stderr, new RegExp(`pid ${holder.pid}`));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.existsSync(lock), true, "another process's live lock is not removed");
});

test('the CLI in another process and the app adding cards at the same time lose none', async (t) => {
  const { allCommitsIdle } = loadTs('src/core/hiveCommit.ts');
  const { HiveManager } = loadTs('src/main/hive.ts');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-hive-cli-race-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const app = new HiveManager(() => home);
  app.ensureHive();
  const root = app.root();
  const file = path.join(root, 'tasks.json');
  const N = 50;
  const startAt = Date.now() + 1500;
  const proc = spawn(process.execPath, ['-e', `
    const loadTs = require(${JSON.stringify(path.join(__dirname, 'load-ts.cjs'))});
    const { runHiveCli } = loadTs('src/core/hiveCli.ts');
    const [root, n, startAt] = process.argv.slice(1);
    const io = { stdout: () => {}, stderr: (s) => process.stderr.write(s) };
    while (Date.now() < Number(startAt)) {}
    for (let i = 0; i < Number(n); i++) {
      const code = runHiveCli(['tasks', 'add', '--json', JSON.stringify({ id: 'cli-' + i, title: 'cli ' + i })],
        { HIVE_ROOT: root, HIVE_TASKS_LOCK_TIMEOUT_MS: '30000' }, io);
      if (code !== 0) process.exit(code);
    }`, root, String(N), String(startAt)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'ignore', 'pipe'] });
  t.after(() => proc.kill());
  let err = '';
  proc.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve, reject) => proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`CLI child exited ${code}: ${err}`)))));
  while (Date.now() < startAt) { /* start together */ }
  for (let i = 0; i < N; i++) {
    // The app waits only briefly for the lock (its writes run on the UI thread)
    // and reports a busy ledger instead; like its callers, retry until written.
    for (;;) {
      try {
        assert.equal(app.addTask({ id: `app-${i}`, title: `app ${i}`, status: 'todo', createdAt: '2026-11-26T00:00:00.000Z' }), true);
        break;
      } catch (e) {
        if (e.name !== 'TaskLedgerLockTimeout') throw e;
      }
    }
  }
  await done;
  const got = new Set(read(file).tasks.map((c) => c.id));
  const lost = [];
  for (const who of ['app', 'cli']) for (let i = 0; i < N; i++) if (!got.has(`${who}-${i}`)) lost.push(`${who}-${i}`);
  assert.deepEqual(lost, [], `${lost.length} of ${2 * N} cards lost`);
});
