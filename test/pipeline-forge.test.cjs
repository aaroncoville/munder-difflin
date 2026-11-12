'use strict';
// The pipeline's probes (spec 12.4, 10.4, 11; steel-thread ST-6 and ST-9): GitLab
// through glab, the conductor's own bare mirror through git, and the live version URL.
// Each is read-only except the merge, which carries the sha so the forge refuses a
// head that moved. No token is ever on an argument list: glab and git authenticate
// through their own logins and credential helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

/** A forbidden list for tests that are not about it: one folder nothing here uses. */
const NONE = [require('node:path').join(require('node:os').tmpdir(), 'mr-pipeline-nothing-forbidden')];

const { GitlabForge, toForgeMr } = loadTs('src/main/pipeline/forgeGitlab.ts');
const { GitMirror } = loadTs('src/main/pipeline/gitMirror.ts');
const { probeLive } = loadTs('src/main/pipeline/liveProbe.ts');

const S = 'fa862a4a5d84f8924d3bf0559ec525a7868b0db3';
// GitLab's answer for Wayfarer !185 on 2026-11-12, trimmed to the fields the pipeline reads.
const MR_185 = {
  iid: 185, state: 'opened', draft: false, sha: S, source_branch: 'fix/feedback-followups-2', target_branch: 'main',
  merge_commit_sha: null, head_pipeline: { id: 3060038898, sha: S, status: 'success' },
};

/** A runner that records each call and answers from [answers] in order. */
function fakeRunner(...answers) {
  const calls = [];
  const run = async (file, args) => {
    calls.push([file, ...args]);
    return answers.shift() ?? { code: 1, stdout: '', stderr: 'no answer' };
  };
  return { run, calls };
}
const ok = (body) => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });

test('an MR reads as the stage machine needs it, from GitLab\'s own JSON', async () => {
  const { run, calls } = fakeRunner(ok(MR_185));
  const mr = await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run }).mr(185);
  assert.deepEqual(mr, {
    state: 'opened', draft: false, head: S, source: 'fix/feedback-followups-2', target: 'main',
    pipeline: { id: 3060038898, sha: S, status: 'success' }, mergeCommit: null,
  });
  assert.deepEqual(calls, [['glab', 'api', '--hostname', 'gitlab.com', 'projects/wooden-bird%2Fwayfarer/merge_requests/185']]);
});

test('an MR with no head pipeline, a short sha, or a failed read is reported as such, never guessed', async () => {
  assert.equal(toForgeMr({ ...MR_185, head_pipeline: null }).pipeline, null);
  assert.equal(toForgeMr({ ...MR_185, head_pipeline: { id: 1, sha: 'abc', status: 'success' } }).pipeline, null);
  assert.equal(toForgeMr({ ...MR_185, sha: 'fa862a4a' }), null);
  assert.equal(toForgeMr({ ...MR_185, state: 'weird' }), null);
  assert.equal(await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run: fakeRunner({ code: 1, stdout: '', stderr: 'HTTP 404' }).run }).mr(185), null);
  assert.equal(await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run: fakeRunner({ code: 0, stdout: 'not json', stderr: '' }).run }).mr(185), null);
});

test('the merge is one PUT that carries the full sha, and returns the merge commit', async () => {
  const M = '2'.repeat(40);
  const { run, calls } = fakeRunner(ok({ ...MR_185, state: 'merged', merge_commit_sha: M }));
  assert.deepEqual(await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run }).merge(185, S), { ok: true, mergeCommit: M });
  assert.deepEqual(calls, [['glab', 'api', '--hostname', 'gitlab.com', '--method', 'PUT', 'projects/wooden-bird%2Fwayfarer/merge_requests/185/merge', '--raw-field', `sha=${S}`]]);
});

test('a refused merge comes back refused with GitLab\'s reason, and a short sha is never sent', async () => {
  const { run } = fakeRunner({ code: 1, stdout: JSON.stringify({ message: 'SHA does not match HEAD of source branch' }), stderr: 'glab: 409 Conflict (HTTP 409)' });
  const r = await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run }).merge(185, S);
  assert.equal(r.ok, false);
  assert.equal(r.status, '409');
  assert.match(r.error, /SHA does not match HEAD/);
  const never = fakeRunner();
  assert.equal((await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run: never.run }).merge(185, 'fa862a4a')).ok, false);
  assert.deepEqual(never.calls, []);
});

test('open MRs for a branch are counted, with the branch encoded into the query', async () => {
  const { run, calls } = fakeRunner(ok([MR_185]));
  assert.equal(await new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run }).openMrsForBranch('fix/a&b'), 1);
  assert.match(calls[0][4], /source_branch=fix%2Fa%26b$/);
});

test('no argument list carries a credential: the project path is the only thing that varies', async () => {
  const { run, calls } = fakeRunner(ok(MR_185), ok([]), ok({ state: 'merged', merge_commit_sha: '3'.repeat(40) }));
  const forge = new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: NONE, run });
  await forge.mr(185); await forge.openMrsForBranch('b'); await forge.merge(185, S);
  for (const call of calls) for (const arg of call) assert.doesNotMatch(arg, /glpat-|token|oauth2|@gitlab/i, arg);
});

// --- The mirror: real git, against a throwaway repository ---

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
}
function upstream() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-up-'));
  git(dir, 'init', '-q', '-b', 'main');
  const commit = (file, text, msg) => { fs.writeFileSync(path.join(dir, file), text); git(dir, 'add', file); git(dir, 'commit', '-q', '-m', msg); return git(dir, 'rev-parse', 'HEAD'); };
  const base = commit('a.txt', 'one\n', 'base');
  git(dir, 'checkout', '-q', '-b', 'feat');
  const S1 = commit('b.txt', 'feature\n', 'feature');
  git(dir, 'checkout', '-q', 'main');
  const T1 = commit('c.txt', 'main moves\n', 'main moves');
  git(dir, 'checkout', '-q', '-b', 'clash', base);
  const C1 = commit('c.txt', 'other\n', 'clashes with main');
  git(dir, 'checkout', '-q', 'main');
  git(dir, 'merge', '-q', '--no-ff', '-m', 'merge feat', 'feat');
  const M1 = git(dir, 'rev-parse', 'HEAD');
  return { dir, base, S1, T1, C1, M1 };
}

test('the mirror fetches into its own bare repository and answers merge-tree, ancestry and second parent', async () => {
  const up = upstream();
  const mirrorDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mirror-')), 'wayfarer.git');
  const m = new GitMirror({ dir: mirrorDir, remote: up.dir, forbidden: NONE });
  await m.fetch(['main', 'feat', 'clash']);
  assert.equal(fs.existsSync(path.join(mirrorDir, 'HEAD')), true, 'a bare repository');
  assert.equal(await m.hasCommit(up.S1), true);
  assert.equal(await m.hasCommit('9'.repeat(40)), false);
  assert.equal(await m.mergeTree(up.T1, up.S1), 'clean');
  assert.equal(await m.mergeTree(up.T1, up.C1), 'conflict');
  assert.equal(await m.isAncestor(up.S1, up.M1), true);
  assert.equal(await m.isAncestor(up.C1, up.M1), false);
  assert.equal(await m.secondParent(up.M1), up.S1);
  assert.equal(await m.secondParent(up.S1), null, 'a commit with one parent has no second');
  assert.deepEqual(await m.changedFiles(up.T1, up.S1), ['b.txt']);
});

test('the mirror refuses a short or malformed sha rather than letting git resolve it', async () => {
  const up = upstream();
  const m = new GitMirror({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mirror-')), 'w.git'), remote: up.dir, forbidden: NONE });
  assert.equal(await m.fetch(['main', 'feat']), true);
  assert.equal(await m.mergeTree('main', up.S1), null);
  assert.equal(await m.isAncestor(up.S1.slice(0, 8), up.M1), null);
  assert.equal(await m.secondParent('--output=/tmp/x'), null);
});

test('the mirror never runs in, or writes to, the repository it fetches from', async () => {
  const up = upstream();
  const before = git(up.dir, 'for-each-ref');
  const m = new GitMirror({ dir: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mirror-')), 'w.git'), remote: up.dir, forbidden: NONE });
  await m.fetch(['main', 'feat']);
  await m.mergeTree(up.T1, up.S1);
  assert.equal(git(up.dir, 'for-each-ref'), before);
});

// --- The live probe ---

const stream = (text) => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });

test('the live probe reads the deployed commit from its JSON field', async () => {
  const D = '5bd88d3abad124db5aff6192199f71b255999eb0';
  const fetchFn = async (url) => ({ ok: true, body: stream(JSON.stringify({ commit: D })), text: async () => { throw new Error('unbounded read'); }, url });
  assert.deepEqual(await probeLive({ kind: 'http-json', url: 'https://w.example/api/version', field: 'commit' }, fetchFn), { deployed: D });
});

test('a live probe that fails, times out, or answers anything but a full sha is unknown, not "not live"', async () => {
  const cfg = { kind: 'http-json', url: 'https://w.example/api/version', field: 'commit' };
  const cases = [
    async () => { throw new Error('ECONNREFUSED'); },
    async () => ({ ok: false, text: async () => JSON.stringify({ commit: 'a'.repeat(40) }) }),
    async () => ({ ok: true, text: async () => JSON.stringify({ commit: 'abc123' }) }),
    async () => ({ ok: true, text: async () => JSON.stringify({ version: 'a'.repeat(40) }) }),
    async () => ({ ok: true, body: stream('{"commit":') }),
    async () => ({ ok: true, body: new ReadableStream({ pull(c) { c.error(new Error('connection reset')); } }) }),
  ];
  for (const f of cases) assert.deepEqual(await probeLive(cfg, f), { deployed: null });
});
