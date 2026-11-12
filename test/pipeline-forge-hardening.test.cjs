'use strict';
// The forge, mirror and live probe read answers from outside the app (GitLab, git,
// a deploy's version URL) and run programs. These tests hold them to the rules the
// rest of the pipeline keeps: JSON with a name given twice is refused (the parser is
// tested in pipeline-json.test.cjs); a field is read only if the object itself has
// it; a malformed answer is refused, never thrown; programs are found in fixed system
// folders, never through PATH and never under a folder an agent can write; git runs
// with no user or system config; and the mirror's answers match git's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { GitlabForge, toForgeMr, resolveTool, toolEnv } = loadTs('src/main/pipeline/forgeGitlab.ts');
const { GitMirror } = loadTs('src/main/pipeline/gitMirror.ts');
const { probeLive } = loadTs('src/main/pipeline/liveProbe.ts');

const S = 'fa862a4a5d84f8924d3bf0559ec525a7868b0db3';
const M = '2222222222222222222222222222222222222222';
const MR = { state: 'opened', draft: false, sha: S, source_branch: 'feat/x', target_branch: 'main', head_pipeline: { id: 1, sha: S, status: 'success' }, merge_commit_sha: null };

// --- the forge ---

test('a GitLab answer that gives a name twice is no answer: the MR is unknown and a merge is refused', async () => {
  const twice = '{"state":"opened","state":"merged","sha":"' + S + '","source_branch":"feat/x","target_branch":"main"}';
  const forge = new GitlabForge('wooden-bird/wayfarer', async () => ({ code: 0, stdout: twice, stderr: '' }));
  assert.equal(await forge.mr(7), null);
  const merged = new GitlabForge('wooden-bird/wayfarer', async () => ({ code: 0, stdout: `{"merge_commit_sha":"${M}","merge_commit_sha":"${S}"}`, stderr: '' }));
  assert.equal((await merged.merge(7, S)).ok, false);
});

test('an MR field is read only if the answer itself has it, never from a prototype', () => {
  assert.equal(toForgeMr(Object.create(MR)), null);
  const withInherited = Object.assign(Object.create({ draft: true, head_pipeline: MR.head_pipeline }), { ...MR, draft: undefined, head_pipeline: undefined });
  delete withInherited.draft; delete withInherited.head_pipeline;
  const r = toForgeMr(withInherited);
  assert.equal(r.draft, false);
  assert.equal(r.pipeline, null);
});

test('reading any JSON value as an MR refuses or answers, and never throws', () => {
  const odd = [null, 0, 'x', [], [MR], { ...MR, state: 'OPENED' }, { ...MR, sha: S.toUpperCase() }, { ...MR, head_pipeline: [] }, { ...MR, head_pipeline: { id: '1', sha: S, status: 'success' } }, { ...MR, source_branch: 7 }];
  for (const v of odd) assert.doesNotThrow(() => toForgeMr(v));
  assert.equal(toForgeMr({ ...MR, head_pipeline: { id: '1', sha: S, status: 'success' } }).pipeline, null);
});

// --- programs and their environment ---

test('git and glab are found in fixed system folders, never through PATH, and never under a forbidden folder', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-tools-'));
  const hive = path.join(base, 'hive', 'bin');
  const sys = path.join(base, 'usr', 'bin');
  for (const d of [hive, sys]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'git'), '#!/bin/sh\n', { mode: 0o755 });
  }
  assert.equal(resolveTool('git', [hive, sys], [path.join(base, 'hive')]), fs.realpathSync(path.join(sys, 'git')));
  assert.equal(resolveTool('git', [hive], [path.join(base, 'hive')]), null);
  assert.equal(resolveTool('git', ['relative/bin', sys], []), fs.realpathSync(path.join(sys, 'git')), 'a relative folder is skipped');
  assert.equal(resolveTool('git', [path.relative(process.cwd(), sys)], []), null, 'a relative folder is never used, even one that exists');
  fs.writeFileSync(path.join(base, 'usr', 'git'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(resolveTool('../git', [sys], []), null, 'a name with a path in it is refused');
  // A link in a system folder that leads under a forbidden folder is refused too.
  const linkDir = path.join(base, 'opt', 'bin');
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(path.join(hive, 'git'), path.join(linkDir, 'git'));
  assert.equal(resolveTool('git', [linkDir], [path.join(base, 'hive')]), null);
});

test('git runs with no user or system config and no GIT_ variables from the app\'s environment', () => {
  const env = toolEnv({ PATH: '/usr/bin', HOME: '/Users/x', GIT_DIR: '/tmp/evil', GIT_CONFIG_PARAMETERS: "'core.fsmonitor=/tmp/x'", GIT_SSH_COMMAND: 'x', GITLAB_HOST: 'gitlab.com' });
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_SSH_COMMAND, undefined);
  assert.equal(env.GIT_CONFIG_PARAMETERS, undefined);
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(env.GITLAB_HOST, 'gitlab.com', 'glab\'s own settings are kept');
});

// --- the mirror ---

test('the mirror refuses, and never throws, on a malformed sha, ref or branch from outside', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mirror-')), 'm.git');
  const calls = [];
  const m = new GitMirror(dir, 'https://gitlab.com/wooden-bird/wayfarer.git', async (f, a) => { calls.push(a); return { code: 0, stdout: '', stderr: '' }; });
  for (const bad of ['', 'HEAD', S.slice(0, 7), `${S}x`, '--upload-pack=x', S.toUpperCase()]) {
    assert.equal(await m.hasCommit(bad), false, bad);
    assert.equal(await m.mergeTree(bad, S), null, bad);
    assert.equal(await m.isAncestor(S, bad), null, bad);
    assert.equal(await m.secondParent(bad), null, bad);
    assert.equal(await m.changedFiles(S, bad), null, bad);
  }
  assert.equal(await m.revParse('refs/heads/../../x'), null);
  assert.equal(await m.fetch(['--upload-pack=x']), false);
  assert.equal(await m.fetch(['main'], [0]), false);
  assert.deepEqual(calls, [], 'git was never asked');
});

test('the mirror folder must be an absolute path outside every forbidden folder', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mirror-'));
  assert.throws(() => new GitMirror('rel/m.git', 'x', undefined, null, []), /absolute/);
  assert.throws(() => new GitMirror(path.join(base, 'hive', 'm.git'), 'x', undefined, null, [path.join(base, 'hive')]), /forbidden|under/);
  fs.mkdirSync(path.join(base, 'hive'));
  fs.symlinkSync(path.join(base, 'hive'), path.join(base, 'appdata'));
  assert.throws(() => new GitMirror(path.join(base, 'appdata', 'm.git'), 'x', undefined, null, [path.join(base, 'hive')]), /forbidden|under/, 'through a link');
});

/** A real repo with random history: branches, merges, file edits. Returns its commits. */
function randomRepo(seed) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-src-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' } }).toString().trim();
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  git('init', '--quiet', '-b', 'main');
  const commits = [];
  const commit = (file, text) => { fs.writeFileSync(path.join(dir, file), text); git('add', '-A'); git('commit', '--quiet', '-m', 'c'); commits.push(git('rev-parse', 'HEAD')); };
  commit('a.txt', 'base\n');
  for (let i = 0; i < 6; i++) {
    const r = rnd();
    if (r < 0.3) { git('checkout', '--quiet', '-B', `b${i}`, commits[Math.floor(rnd() * commits.length)]); commit(`f${i}.txt`, `${i}\n`); }
    else if (r < 0.5) { commit('a.txt', `edit ${i}\n`); }
    else if (r < 0.7 && i > 0) {
      const other = commits[Math.floor(rnd() * commits.length)];
      try { git('merge', '--quiet', '--no-ff', '--no-edit', other); commits.push(git('rev-parse', 'HEAD')); } catch { git('merge', '--abort'); }
    } else { commit(`g${i}.txt`, `${i}\n`); }
  }
  return { dir, git, commits: [...new Set(commits)] };
}

test('property: on random histories the mirror\'s answers match git\'s own in the source repository', async () => {
  for (let seed = 1; seed <= 12; seed++) {
    const src = randomRepo(seed);
    const branches = src.git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);
    const mirrorDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mir-')), 'm.git');
    const mirror = new GitMirror(mirrorDir, src.dir, undefined, null, []);
    assert.equal(await mirror.fetch(branches), true, `seed ${seed}: fetch`);
    const cs = src.commits;
    for (let i = 0; i < cs.length; i++) {
      const a = cs[i];
      const b = cs[(i * 7 + 3) % cs.length];
      assert.equal(await mirror.hasCommit(a), true);
      let anc = true;
      try { src.git('merge-base', '--is-ancestor', a, b); } catch { anc = false; }
      assert.equal(await mirror.isAncestor(a, b), anc, `seed ${seed}: ${a} ancestor of ${b}`);
      let p2 = null;
      try { p2 = src.git('rev-parse', '--verify', '--quiet', `${a}^2`); } catch { p2 = null; }
      assert.equal(await mirror.secondParent(a), p2 || null, `seed ${seed}: second parent of ${a}`);
      const files = src.git('diff', '--name-only', `${a}...${b}`).split('\n').filter(Boolean);
      assert.deepEqual(await mirror.changedFiles(a, b), files, `seed ${seed}: changed files`);
      let clean = true;
      try { src.git('merge-tree', '--write-tree', '--no-messages', a, b); } catch { clean = false; }
      assert.equal(await mirror.mergeTree(a, b), clean ? 'clean' : 'conflict', `seed ${seed}: merge-tree`);
    }
    assert.equal(await mirror.hasCommit('0'.repeat(40)), false);
  }
});

test('changed files come back exactly, whatever characters a file name holds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mr-names-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
  const git = (...a) => execFileSync('git', a, { cwd: dir, env }).toString().trim();
  git('init', '--quiet', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'a');
  const T = git('rev-parse', 'HEAD');
  const odd = ['say "hi"\nthere.txt', 'é ✓.txt', 'tab\there.txt'];
  for (const n of odd) fs.writeFileSync(path.join(dir, n), 'x\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'b');
  const S2 = git('rev-parse', 'HEAD');
  const mirror = new GitMirror(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mr-mir-')), 'm.git'), dir, undefined, null, []);
  assert.equal(await mirror.fetch(['main']), true);
  assert.deepEqual((await mirror.changedFiles(T, S2)).sort(), [...odd].sort());
});

// --- the live probe ---

test('the live probe reads only the answer\'s own field, and a name given twice is unknown', async () => {
  const answer = (text) => async () => ({ ok: true, text: async () => text, json: async () => JSON.parse(text) });
  const cfg = (field) => ({ kind: 'http-json', url: 'https://x.example/api/version', field });
  assert.deepEqual(await probeLive(cfg('commit'), answer(`{"commit":"${S}"}`)), { deployed: S });
  assert.deepEqual(await probeLive(cfg('commit'), answer(`{"commit":"${M}","commit":"${S}"}`)), { deployed: null });
  assert.deepEqual(await probeLive(cfg('constructor'), answer('{}')), { deployed: null });
  assert.deepEqual(await probeLive(cfg('__proto__'), answer(`{"__proto__":"${S}"}`)), { deployed: S }, 'an own "__proto__" is an ordinary name');
  assert.deepEqual(await probeLive(cfg('commit'), answer('not json')), { deployed: null });
});
