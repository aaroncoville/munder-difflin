'use strict';
// Where the forge, the mirror and the live probe meet the system: which programs run,
// with which PATH, in which folder, and how an answer that is absent or the wrong
// type reads. Absent or malformed always reads as unknown, never as a pass.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const core = require('../src/main/pipeline/mr-core.cjs');

const { GitlabForge, toForgeMr, toolEnv, resolveTool, isUnder, SYSTEM_TOOL_DIRS, credentialHelper } = loadTs('src/main/pipeline/forgeGitlab.ts');
const { GitMirror } = loadTs('src/main/pipeline/gitMirror.ts');
const { probeLive } = loadTs('src/main/pipeline/liveProbe.ts');

const S = 'fa862a4a5d84f8924d3bf0559ec525a7868b0db3';
const M = '2222222222222222222222222222222222222222';
const MR = { state: 'opened', draft: false, sha: S, source_branch: 'feat/x', target_branch: 'main', head_pipeline: { id: 1, sha: S, status: 'success' }, merge_commit_sha: null };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const forgeWith = (answer, calls = []) => new GitlabForge({ host: 'gitlab.com', project: 'wooden-bird/wayfarer', forbidden: [], run: async (f, a, o) => { calls.push({ f, a, o }); return answer; } });

// --- M1: no program is chosen through PATH, not even by git or glab ---

test('M1: tools run with a PATH of the fixed system folders only, never the app\'s', () => {
  const env = toolEnv({ PATH: '/Users/x/hive/bin:/usr/bin', HOME: '/h' });
  assert.deepEqual(env.PATH.split(':'), [...SYSTEM_TOOL_DIRS, '/bin']);
  const mixed = toolEnv({ Path: '/Users/x/hive/bin', path: '/hive' });
  assert.deepEqual(Object.keys(mixed).filter((k) => k.toUpperCase() === 'PATH'), ['PATH'], 'no other spelling of PATH survives');
});

test('M1: the credential helper names glab by its absolute path, so git\'s shell finds no other glab', () => {
  assert.equal(credentialHelper('/opt/homebrew/bin/glab'), "!'/opt/homebrew/bin/glab' auth git-credential");
  for (const bad of ['glab', 'bin/glab', "/opt/x'; rm -rf /", '/opt/a b/glab', '']) assert.equal(credentialHelper(bad), null, bad);
});

test('M1: with a planted glab first on the app\'s PATH, a fetch through the helper never runs it', async () => {
  const planted = tmp('mr-plant-');
  const marker = path.join(planted, 'ran');
  fs.writeFileSync(path.join(planted, 'glab'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  assert.equal(typeof credentialHelper, 'function');
  const realGlab = resolveTool('glab', SYSTEM_TOOL_DIRS, []) ?? '/usr/bin/false';
  const git = resolveTool('git', SYSTEM_TOOL_DIRS, []);
  const appPath = `${planted}:${process.env.PATH}`;
  const fill = (helper, env) => {
    try {
      execFileSync(git, ['-c', `credential.helper=${helper}`, 'credential', 'fill'], { env, input: 'protocol=https\nhost=example.invalid\n\n', stdio: ['pipe', 'ignore', 'ignore'], timeout: 20000 });
    } catch { /* no credentials for that host: fine */ }
  };
  // Control: a bare helper under the app's own PATH runs the planted file.
  fill('!glab auth git-credential', { ...process.env, PATH: appPath, GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  assert.equal(fs.existsSync(marker), true, 'control: the planted glab ran');
  fs.rmSync(marker);
  // As built: the absolute helper and toolEnv's PATH.
  fill(credentialHelper(realGlab), toolEnv({ ...process.env, PATH: appPath }));
  assert.equal(fs.existsSync(marker), false);
});

// --- M2: draft must be stated ---

test('M2: an MR whose draft flag is absent or not a boolean is unknown, not "not a draft"', () => {
  for (const d of [undefined, 'true', 1, null, 'false', 0]) {
    const raw = { ...MR, draft: d };
    if (d === undefined) delete raw.draft;
    assert.equal(toForgeMr(raw), null, JSON.stringify(d));
  }
  assert.equal(toForgeMr({ ...MR, draft: true }).draft, true);
  const legacy = { ...MR, work_in_progress: true };
  delete legacy.draft;
  assert.equal(toForgeMr(legacy).draft, true, 'the older name, when it is the one given');
});

// --- M3: the MR number ---

test('M3: an MR number that is not a positive integer never reaches glab', async () => {
  for (const iid of ['7/../8', '5/merge?x=1', -1, 0, 1.5, NaN, ':id', 2 ** 53]) {
    const calls = [];
    const f = forgeWith({ code: 0, stdout: JSON.stringify(MR), stderr: '' }, calls);
    assert.equal(await f.mr(iid), null, String(iid));
    assert.equal((await f.merge(iid, S)).ok, false, String(iid));
    assert.equal(calls.length, 0, String(iid));
  }
});

// --- L1: the guards are not optional ---

test('L1: the forge, the mirror and the runner cannot be made without a forbidden list', () => {
  assert.throws(() => new GitMirror({ dir: path.join(tmp('mr-'), 'm.git'), remote: 'https://gitlab.com/a/b.git' }), /forbidden/);
  assert.throws(() => new GitlabForge({ host: 'gitlab.com', project: 'a/b' }), /forbidden/);
});

// --- L2: case on a case-blind disk ---

test('L2: a folder named in another case is still under the forbidden folder', () => {
  const base = tmp('mr-case-');
  fs.mkdirSync(path.join(base, 'hive', 'mirror'), { recursive: true });
  const other = path.join(base, 'HIVE', 'mirror');
  if (!fs.existsSync(other)) return; // a case-sensitive disk: nothing to show
  assert.equal(isUnder(other, path.join(base, 'hive')), true);
  assert.throws(() => new GitMirror({ dir: path.join(base, 'HIVE', 'm.git'), remote: 'https://gitlab.com/a/b.git', forbidden: [path.join(base, 'hive')] }), /forbidden|under/);
});

// --- L3: the mirror never answers from another repository ---

test('L3: a mirror folder that is not a repository answers nothing from a repository around it', async () => {
  const outer = tmp('mr-outer-');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@a', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@a' };
  execFileSync('git', ['init', '-q', outer], { env });
  fs.writeFileSync(path.join(outer, 'f'), 'x');
  execFileSync('git', ['add', '-A'], { cwd: outer, env });
  execFileSync('git', ['commit', '-qm', 'c'], { cwd: outer, env });
  const c = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: outer, env }).toString().trim();
  const inner = path.join(outer, 'm.git');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'HEAD'), 'junk\n');
  const m = new GitMirror({ dir: inner, remote: 'https://gitlab.com/a/b.git', forbidden: [] });
  assert.equal(await m.hasCommit(c), false);
});

test('the mirror fetches only over https or from a local path, never another transport', () => {
  for (const remote of ['ext::sh -c touch% /tmp/x', 'ssh://git@gitlab.com/a/b.git', 'git@gitlab.com:a/b.git', 'http://gitlab.com/a/b.git', 'https://user:tok@gitlab.com/a/b.git', 'fd::3', 'relative/path']) {
    assert.throws(() => new GitMirror({ dir: path.join(tmp('mr-'), 'm.git'), remote, forbidden: [] }), /remote/, remote);
  }
});

// --- L4: what a merge answer means ---

test('L4: a merge is "merged" only when GitLab says merged and names the merge commit; anything unclear is unknown, not refused', async () => {
  const run = (code, body, stderr = '') => forgeWith({ code, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr });
  assert.deepEqual(await run(0, { state: 'merged', merge_commit_sha: M }).merge(7, S), { ok: true, mergeCommit: M });
  assert.equal((await run(0, { state: 'opened', merge_commit_sha: M }).merge(7, S)).outcome, 'unknown');
  assert.equal((await run(0, { state: 'merged', merge_commit_sha: null }).merge(7, S)).outcome, 'unknown', 'merged without a merge commit (a fast-forward): look again');
  assert.equal((await run(1, '', 'glab: context deadline exceeded').merge(7, S)).outcome, 'unknown', 'a timeout');
  assert.equal((await run(1, { message: 'SHA does not match HEAD of source branch' }, 'glab: 409 Conflict (HTTP 409)').merge(7, S)).outcome, 'refused');
  const long = await run(1, { message: `x${'\u0007y'.repeat(500)}` }, 'glab: 405 Method Not Allowed (HTTP 405)').merge(7, S);
  assert.ok(long.error.length <= 200 && !/[\u0000-\u001f]/.test(long.error), 'a short, printable reason');
});

// --- L5: shape of an MR ---

test('L5: empty branch names or a non-integer pipeline id are unknown', () => {
  assert.equal(toForgeMr({ ...MR, source_branch: '' }), null);
  assert.equal(toForgeMr({ ...MR, target_branch: '' }), null);
  assert.equal(toForgeMr({ ...MR, head_pipeline: { id: 1.5, sha: S, status: 'success' } }).pipeline, null);
  assert.equal(toForgeMr({ ...MR, head_pipeline: { id: -2, sha: S, status: 'success' } }).pipeline, null);
  for (const id of [Infinity, NaN, 2 ** 53, 0]) assert.equal(toForgeMr({ ...MR, head_pipeline: { id, sha: S, status: 'success' } }).pipeline, null, String(id));
  // As GitLab would send it: a string draft flag and an id of 1e999 (Infinity once parsed).
  assert.equal(toForgeMr(core.parseJson(`{"state":"opened","draft":"false","sha":"${S}","source_branch":"a","target_branch":"main","head_pipeline":{"id":1e999,"sha":"${S}","status":"success"}}`).value), null);
  const huge = toForgeMr(core.parseJson(`{"state":"opened","draft":false,"sha":"${S}","source_branch":"a","target_branch":"main","head_pipeline":{"id":1e999,"sha":"${S}","status":"success"}}`).value);
  assert.equal(huge.pipeline, null, 'an id of 1e999 is no pipeline');
});

// --- L6: environment, host and folder ---

test('L6: git variables are dropped in any case, glab\'s host and config redirections too, and glab names its host and runs from /', async () => {
  const env = toolEnv({ git_dir: '/x', Git_Config_Parameters: 'y', GITLAB_HOST: 'evil.example', GITLAB_URI: 'https://evil.example', GL_HOST: 'evil.example', GLAB_CONFIG_DIR: '/hive/x', HOME: '/h' });
  for (const k of ['git_dir', 'Git_Config_Parameters', 'GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GLAB_CONFIG_DIR']) assert.equal(env[k], undefined, k);
  assert.equal(env.HOME, '/h');
  const calls = [];
  await forgeWith({ code: 0, stdout: JSON.stringify(MR), stderr: '' }, calls).mr(7);
  assert.deepEqual(calls[0].a.slice(0, 3), ['api', '--hostname', 'gitlab.com']);
  assert.equal(calls[0].o.cwd, '/');
  assert.throws(() => new GitlabForge({ host: 'gitlab.com/evil', project: 'a/b', forbidden: [] }), /host/);
});

// --- L7: the probe reads at most a bounded body ---

test('L7: the live probe stops reading past its size limit and reads the answer as unknown', async () => {
  let pulled = 0;
  const big = new ReadableStream({ pull(c) { pulled += 1; if (pulled > 64) { c.close(); return; } c.enqueue(new Uint8Array(64 * 1024).fill(0x20)); } });
  const res = { ok: true, body: big, text: async () => { throw new Error('read whole'); } };
  assert.deepEqual(await probeLive({ kind: 'http-json', url: 'https://x.example/v', field: 'commit' }, async () => res), { deployed: null });
  assert.ok(pulled <= 20, `stopped early (${pulled} chunks)`);
  const small = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"commit":"${S}"}`)); c.close(); } });
  assert.deepEqual(await probeLive({ kind: 'http-json', url: 'https://x.example/v', field: 'commit' }, async () => ({ ok: true, body: small, text: async () => { throw new Error('x'); } })), { deployed: S });
});

// --- L9: depth ---

test('L9: nesting is refused past 64 levels, counted exactly', () => {
  assert.equal(core.parseJson('['.repeat(64) + ']'.repeat(64)).ok, true);
  assert.equal(core.parseJson('['.repeat(65) + ']'.repeat(65)).ok, false);
});

// --- self-audit: other ways a program or a config gets chosen, and other fields read as a pass ---

test('audit: no library injection or config-folder redirection reaches git or glab', () => {
  const env = toolEnv({ DYLD_INSERT_LIBRARIES: '/hive/x.dylib', DYLD_LIBRARY_PATH: '/hive', LD_PRELOAD: '/hive/x.so', LD_LIBRARY_PATH: '/hive', XDG_CONFIG_HOME: '/hive/cfg', HOME: '/h' });
  for (const k of ['DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'XDG_CONFIG_HOME']) assert.equal(env[k], undefined, k);
});

test('audit: every git call pins the hooks folder to nothing, so no hook in the mirror runs', async () => {
  const calls = [];
  const m = new GitMirror({ dir: path.join(tmp('mr-'), 'm.git'), remote: 'https://gitlab.com/a/b.git', forbidden: [], run: async (f, a) => { calls.push(a); return { code: 0, stdout: `${S}\n`, stderr: '' }; } });
  await m.fetch(['main']); await m.hasCommit(S); await m.mergeTree(S, S); await m.isAncestor(S, S); await m.secondParent(S); await m.changedFiles(S, S); await m.revParse('refs/heads/main');
  const gitCalls = calls.filter((a) => !a.includes('init'));
  assert.ok(gitCalls.length >= 7);
  for (const a of gitCalls) assert.ok(a.includes('core.hooksPath=/dev/null'), a.join(' '));
});

test('audit: open MRs are counted only from an answer whose every entry is an MR', async () => {
  const count = async (body) => forgeWith({ code: 0, stdout: JSON.stringify(body), stderr: '' }).openMrsForBranch('feat/x');
  assert.equal(await count([{ iid: 3 }, { iid: 4 }]), 2);
  for (const bad of [[1], [null], [{}], [{ iid: '3' }], { length: 1 }]) assert.equal(await count(bad), null, JSON.stringify(bad));
});
