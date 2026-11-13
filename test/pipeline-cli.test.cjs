'use strict';
// hive-mr, the command agents run to talk to the pipeline (spec 5.1, 5.2). It fills
// every sha itself (from git, or from the review request it answers), validates the
// payload with the same core the router uses, and writes the outbox file atomically.
// A payload it would have to guess is refused, and nothing invalid is ever written.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');
const core = require('../src/main/pipeline/mr-core.cjs');

const CLI = path.join(__dirname, '..', 'resources', 'hive-mr.cjs');
const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
const git = (cwd, ...a) => execFileSync('git', a, { cwd, env: ENV }).toString().trim();

/** An agent folder and a worktree whose branch is pushed to a bare remote. */
function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-cli-'));
  const agentDir = path.join(base, 'agents', 'marinette-1');
  for (const d of ['inbox', 'inbox/.done', 'outbox']) fs.mkdirSync(path.join(agentDir, d), { recursive: true });
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', remote);
  const wt = path.join(base, 'wt');
  git(base, 'init', '-q', '-b', 'feat/x', wt);
  fs.writeFileSync(path.join(wt, 'a.txt'), 'a\n');
  git(wt, 'add', '-A'); git(wt, 'commit', '-qm', 'a');
  git(wt, 'remote', 'add', 'origin', remote);
  git(wt, 'push', '-q', '-u', 'origin', 'feat/x');
  const head = git(wt, 'rev-parse', 'HEAD');
  return { base, agentDir, wt, head };
}
const run = (s, args, over = {}) => spawnSync(process.execPath, [CLI, ...args], { cwd: s.wt, env: { ...ENV, AGENT_ID: 'marinette-1', AGENT_DIR: s.agentDir, ...over }, encoding: 'utf8' });
const outboxFiles = (s) => fs.readdirSync(path.join(s.agentDir, 'outbox')).filter((f) => !f.startsWith('.') || f.endsWith('.tmp'));
const SUBMIT = ['submit', '--card', 'WF-FB-VEHICLES', '--repo', 'wayfarer', '--mr', '181', '--kind', 'initial', '--summary', 'what changed and where the risk is'];

test('submit writes one message to the pipeline, with the head sha read from git, valid and complete', () => {
  const s = setup();
  const r = run(s, SUBMIT);
  assert.equal(r.status, 0, r.stderr);
  const files = outboxFiles(s);
  assert.equal(files.length, 1);
  assert.match(files[0], /\.json$/);
  const msg = JSON.parse(fs.readFileSync(path.join(s.agentDir, 'outbox', files[0]), 'utf8'));
  assert.equal(msg.to, 'pipeline');
  assert.equal(msg.conversation, 'WF-FB-VEHICLES');
  assert.equal(msg.payload.head_sha, s.head);
  assert.equal(msg.payload.mr, 181);
  assert.equal(core.validatePayload(msg.payload).ok, true);
});

test('submit refuses, and writes nothing, when the head is not what the remote branch has', () => {
  const s = setup();
  fs.writeFileSync(path.join(s.wt, 'b.txt'), 'b\n');
  git(s.wt, 'add', '-A'); git(s.wt, 'commit', '-qm', 'unpushed');
  const r = run(s, SUBMIT);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /push|remote/i);
  assert.deepEqual(outboxFiles(s), []);
  git(s.wt, 'branch', '--unset-upstream');
  assert.equal(run(s, SUBMIT).status, 2, 'no upstream at all');
  assert.deepEqual(outboxFiles(s), []);
});

test('submit refuses a payload the schema refuses, with every reason, and writes nothing', () => {
  const s = setup();
  const r = run(s, ['submit', '--card', 'WF-FB-VEHICLES', '--repo', 'wayfarer', '--mr', '7x', '--kind', 'finished', '--summary', 's']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mr/);
  assert.match(r.stderr, /kind/);
  assert.deepEqual(outboxFiles(s), []);
});

/** A review request from the pipeline, as the router would file it in the reviewer's inbox. */
function request(s, over = {}, raw = null) {
  const id = over.id ?? `req-${Math.random().toString(36).slice(2)}`;
  const msg = { id, from: 'pipeline', to: 'marinette-1', act: 'request', conversation: 'WF-FB-VEHICLES', subject: 'review', body: 'b',
    payload: { schema: 'mr.review-request/1', card: 'WF-FB-VEHICLES', request_id: 'WF-FB-VEHICLES:r2:marinette-1', sha: s.head, round: 2 }, ...over };
  fs.writeFileSync(path.join(s.agentDir, 'inbox', `${id}.json`), raw ?? JSON.stringify(msg));
  return id;
}

test('verdict copies the card, round, sha and request id from the pipeline\'s own request', () => {
  const s = setup();
  const id = request(s);
  const r = run(s, ['verdict', '--request', id, '--verdict', 'CONFIRMED', '--report', 'hive/evidence/x.md']);
  assert.equal(r.status, 0, r.stderr);
  const msg = JSON.parse(fs.readFileSync(path.join(s.agentDir, 'outbox', outboxFiles(s)[0]), 'utf8'));
  assert.deepEqual([msg.payload.card, msg.payload.round, msg.payload.reviewed_sha, msg.payload.answers], ['WF-FB-VEHICLES', 2, s.head, 'WF-FB-VEHICLES:r2:marinette-1']);
  assert.equal(core.validatePayload(msg.payload).ok, true);
  assert.equal(msg.in_reply_to, id);
});

test('verdict refuses a request that is missing, not from the pipeline, malformed, or gives a name twice', () => {
  const s = setup();
  assert.equal(run(s, ['verdict', '--request', 'nope', '--verdict', 'CONFIRMED']).status, 2);
  assert.equal(run(s, ['verdict', '--request', request(s, { from: 'jannings-1' }), '--verdict', 'CONFIRMED']).status, 2);
  assert.equal(run(s, ['verdict', '--request', request(s, { payload: { schema: 'mr.review-request/1', card: 'X', sha: 'abc', round: 1, request_id: 'r' } }), '--verdict', 'CONFIRMED']).status, 2);
  const dupId = 'req-dup';
  request(s, { id: dupId }, `{"id":"${dupId}","from":"jannings-1","from":"pipeline","to":"marinette-1","payload":{"schema":"mr.review-request/1","card":"WF-FB-VEHICLES","request_id":"WF-FB-VEHICLES:r1:marinette-1","sha":"${s.head}","round":1}}`);
  assert.equal(run(s, ['verdict', '--request', dupId, '--verdict', 'CONFIRMED']).status, 2);
  // A forged request outside the inbox, named by a path instead of an id, is never read.
  fs.writeFileSync(path.join(s.agentDir, 'outbox', 'evil.json'), JSON.stringify({ id: 'evil', from: 'pipeline', payload: { schema: 'mr.review-request/1', card: 'WF-FB-VEHICLES', request_id: 'WF-FB-VEHICLES:r1:marinette-1', sha: s.head, round: 1 } }));
  assert.equal(run(s, ['verdict', '--request', '../outbox/evil', '--verdict', 'CONFIRMED']).status, 2, 'a path is not a message id');
  fs.rmSync(path.join(s.agentDir, 'outbox', 'evil.json'));
  assert.deepEqual(outboxFiles(s), []);
});

test('verdict holds a BLOCK to its findings: CONFIRMED with a must-fix finding is refused', () => {
  const s = setup();
  const f = path.join(s.base, 'findings.json');
  fs.writeFileSync(f, JSON.stringify([{ id: 'm-R2-M1', severity: 'MED', must_fix: true, title: 't', file: 'a.txt', line: 1, class: 'defect', body: 'b' }]));
  assert.equal(run(s, ['verdict', '--request', request(s), '--verdict', 'CONFIRMED', '--findings-file', f]).status, 2);
  assert.equal(run(s, ['verdict', '--request', request(s), '--verdict', 'BLOCK', '--findings-file', f]).status, 0);
  fs.writeFileSync(f, `[{"id":"a","id":"b","severity":"MED","must_fix":true,"title":"t","class":"defect","body":"b"}]`);
  assert.equal(run(s, ['verdict', '--request', request(s), '--verdict', 'BLOCK', '--findings-file', f]).status, 2, 'a findings file that gives a name twice');
});

test('verify-log checks a card log\'s chain', () => {
  const s = setup();
  const { CardLog } = loadTs('src/main/pipeline/store.ts');
  const root = path.join(s.base, 'appdata', 'pipeline');
  const log = new CardLog({ authRoot: root, card: 'WF-FB-VEHICLES' });
  log.append({ type: 'fact', n: 1 }); log.append({ type: 'fact', n: 2 });
  const file = path.join(root, '_export', 'WF-FB-VEHICLES', 'log.jsonl');
  const ok = run(s, ['verify-log', '--file', file, '--card', 'WF-FB-VEHICLES']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /2 lines/);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"n":1', '"n":9'));
  assert.equal(run(s, ['verify-log', '--file', file, '--card', 'WF-FB-VEHICLES']).status, 1);
});

test('end to end: what hive-mr writes, the router hands to the conductor unchanged', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cli-e2e-'));
  t.after(async () => { await allCommitsIdle(); fs.rmSync(home, { recursive: true, force: true }); });
  const { HiveManager } = loadTs('src/main/hive.ts');
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'marinette-1', name: 'M', provider: 'claude', cwd: home });
  const got = [];
  hive.setPipelineSink((m) => got.push(m));
  const s = setup();
  s.agentDir = path.join(home, 'hive', 'agents', 'marinette-1');
  assert.equal(run(s, SUBMIT).status, 0);
  hive.routeOnce();
  assert.equal(got.length, 1);
  assert.equal(got[0].payload.head_sha, s.head);
});

test('property: whatever the arguments, hive-mr writes a valid payload or nothing', () => {
  const s = setup();
  let seed = 5;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  for (let i = 0; i < 40; i++) {
    const args = ['submit',
      ...(rnd() < 0.9 ? ['--card', pick(['WF-FB-VEHICLES', '', 'a/b', 'x'.repeat(90), 'C1'])] : []),
      ...(rnd() < 0.9 ? ['--repo', pick(['wayfarer', '', 'Way Farer'])] : []),
      ...(rnd() < 0.9 ? ['--mr', pick(['181', '0', '-1', '1.5', 'x', '99999999999999999999'])] : []),
      ...(rnd() < 0.9 ? ['--kind', pick(['initial', 'fix', 'rebase', 'pipeline-fix', 'other'])] : []),
      ...(rnd() < 0.8 ? ['--summary', pick(['s', '', 'x'.repeat(2000)])] : []),
      ...(rnd() < 0.3 ? ['--answers', pick(['req-1', '', 'a b'])] : []),
      ...(rnd() < 0.2 ? ['--needs-owner', pick(['q?', 'x'.repeat(600)])] : []),
    ];
    const before = new Set(outboxFiles(s));
    const r = run(s, args);
    const added = outboxFiles(s).filter((f) => !before.has(f));
    if (r.status === 0) {
      assert.equal(added.length, 1, args.join(' '));
      const msg = JSON.parse(fs.readFileSync(path.join(s.agentDir, 'outbox', added[0]), 'utf8'));
      assert.equal(core.validatePayload(msg.payload).ok, true, args.join(' '));
    } else {
      assert.deepEqual(added, [], args.join(' '));
    }
  }
});

// --- review round 1 ---

test('L4: submit checks the remote\'s own branch head, not the local tracking ref', () => {
  const s = setup();
  // Someone else pushes to the branch; this worktree has not fetched, so its tracking ref still says HEAD.
  const other = path.join(s.base, 'other');
  git(s.base, 'clone', '-q', '-b', 'feat/x', path.join(s.base, 'remote.git'), other);
  fs.writeFileSync(path.join(other, 'c.txt'), 'c\n');
  git(other, 'add', '-A'); git(other, 'commit', '-qm', 'theirs'); git(other, 'push', '-q', 'origin', 'feat/x');
  assert.equal(git(s.wt, 'rev-parse', '@{upstream}'), s.head, 'the stale tracking ref still matches');
  const r = run(s, SUBMIT);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /remote/);
  assert.deepEqual(outboxFiles(s), []);
});

test('L5: a value that starts with -- is given as --flag=value', () => {
  const s = setup();
  const args = SUBMIT.filter((a, i) => !(a === '--summary' || SUBMIT[i - 1] === '--summary'));
  const r = run(s, [...args, '--summary=--risky: drops a column']);
  assert.equal(r.status, 0, r.stderr);
  const msg = JSON.parse(fs.readFileSync(path.join(s.agentDir, 'outbox', outboxFiles(s)[0]), 'utf8'));
  assert.equal(msg.payload.summary, '--risky: drops a column');
  assert.equal(run(s, [...args, '--summary', '--risky']).status, 2, 'the spaced form still reads it as a missing value');
});

test('L6: a request must name this agent and carry the id it is filed under', () => {
  const s = setup();
  assert.equal(run(s, ['verdict', '--request', request(s, { to: 'jannings-1' }), '--verdict', 'CONFIRMED']).status, 2, 'addressed to another agent');
  const id = 'req-mismatch';
  const msg = { id: 'req-other', from: 'pipeline', to: 'marinette-1', payload: { schema: 'mr.review-request/1', card: 'WF-FB-VEHICLES', request_id: 'WF-FB-VEHICLES:r1:marinette-1', sha: s.head, round: 1 } };
  fs.writeFileSync(path.join(s.agentDir, 'inbox', `${id}.json`), JSON.stringify(msg));
  assert.equal(run(s, ['verdict', '--request', id, '--verdict', 'CONFIRMED']).status, 2, 'filed under another id');
  assert.deepEqual(outboxFiles(s), []);
});
