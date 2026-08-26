'use strict';

/**
 * "Fetch issues" shells out to a provider CLI, so which CLI to run has to be
 * decided from the repo itself. The only evidence available is the `origin`
 * remote URL, which arrives in two unrelated syntaxes — `https://host/o/r` and
 * the scp-like `git@host:o/r.git` — for the same repository. A clone over SSH
 * and a clone over HTTPS must therefore route identically.
 *
 * The GitLab JSON shape asserted here was captured from `glab issue list
 * --output json` (glab 1.114.0), not inferred from the GitHub shape: GitLab
 * returns `labels` as an array of plain strings, where `gh` returns objects
 * with a `name`. Normalizing one as if it were the other silently yields empty
 * labels.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { normalizeGitLabIssues } = loadTs('src/main/gitlab.ts');
const { listIssues } = loadTs('src/main/github.ts');

const POSIX = process.platform !== 'win32';

test('glab JSON normalizes onto the shape the renderer already consumes', () => {
  // Field names as `glab issue list --output json` actually emits them.
  const raw = [
    {
      id: 198836799,
      iid: 8513,
      title: 'Harden the keyring write probe',
      description: 'Two robustness follow-ups.',
      state: 'opened',
      web_url: 'https://gitlab.com/gitlab-org/cli/-/issues/8513',
      labels: ['type::bug', 'group::code review'],
      assignees: [
        { id: 11809982, username: 'jay_mccure', name: 'Jay McCure' },
        { id: 2, username: 'second', name: 'Second Person' }
      ]
    },
    // GitLab returns null, not '', for an issue with no description.
    { iid: 12, title: 'No description', description: null, web_url: 'https://gitlab.com/g/r/-/issues/12', labels: [], assignees: [] }
  ];

  assert.deepEqual(normalizeGitLabIssues(raw), [
    {
      number: 8513,
      title: 'Harden the keyring write probe',
      body: 'Two robustness follow-ups.',
      url: 'https://gitlab.com/gitlab-org/cli/-/issues/8513',
      labels: ['type::bug', 'group::code review'],
      assignees: ['jay_mccure', 'second']
    },
    { number: 12, title: 'No description', body: '', url: 'https://gitlab.com/g/r/-/issues/12', labels: [], assignees: [] }
  ]);
});

test('normalization survives fields the API omits', () => {
  assert.deepEqual(normalizeGitLabIssues([{}]), [
    { number: 0, title: '', body: '', url: '', labels: [], assignees: [] }
  ]);
  // `iid` is the per-project number users see as #N; `id` is global and must not
  // be substituted for it.
  assert.equal(normalizeGitLabIssues([{ id: 198836799, iid: 42 }])[0].number, 42);
  assert.deepEqual(normalizeGitLabIssues('not an array'), []);
});

/** A repo whose `origin` is `remoteUrl`, plus a directory for fake CLIs.
 *  The git config is emptied out so a developer's own `url.<base>.insteadOf`
 *  rewrite rules cannot change which host the remote resolves to. */
function repoWithOrigin(t, remoteUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-issue-host-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const opts = { cwd: repo, env: { ...process.env, ...HERMETIC } };
  execFileSync('git', ['init', '-q'], opts);
  if (remoteUrl) execFileSync('git', ['remote', 'add', 'origin', remoteUrl], opts);
  return { repo, bin: path.join(dir, 'bin') };
}

const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

/** A stand-in CLI on PATH that prints `stdout` — so which one got run is
 *  observable without a network, an account, or the real tool being installed. */
function fakeCli(bin, name, stdout) {
  fs.mkdirSync(bin, { recursive: true });
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\n`);
  fs.chmodSync(file, 0o755);
}

/** Run `fn` with `bin` first on PATH and a neutral git config, both of which
 *  the child processes under test inherit. */
async function withFakeClis(bin, fn) {
  const before = { ...process.env };
  Object.assign(process.env, HERMETIC, { PATH: `${bin}${path.delimiter}${process.env.PATH}` });
  try {
    return await fn();
  } finally {
    for (const key of ['PATH', ...Object.keys(HERMETIC)]) {
      if (key in before) process.env[key] = before[key];
      else delete process.env[key];
    }
  }
}

test('a gitlab.com origin fetches through glab, not gh', { skip: !POSIX }, async (t) => {
  const { repo, bin } = repoWithOrigin(t, 'git@gitlab.com:group/repo.git');
  fakeCli(bin, 'glab', JSON.stringify([
    { iid: 7, title: 'From glab', description: 'b', web_url: 'https://gitlab.com/g/r/-/issues/7', labels: ['bug'], assignees: [{ username: 'ada' }] }
  ]));
  // If routing picked `gh` instead, this would answer in the GitHub shape and
  // the assertion below would show it rather than a spawn failure.
  fakeCli(bin, 'gh', JSON.stringify([{ number: 999, title: 'From gh' }]));

  const res = await withFakeClis(bin, () => listIssues(repo));
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.issues, [
    { number: 7, title: 'From glab', body: 'b', url: 'https://gitlab.com/g/r/-/issues/7', labels: ['bug'], assignees: ['ada'] }
  ]);
});

test('a github.com origin still fetches through gh', { skip: !POSIX }, async (t) => {
  const { repo, bin } = repoWithOrigin(t, 'https://github.com/owner/repo.git');
  fakeCli(bin, 'gh', JSON.stringify([
    { number: 3, title: 'From gh', body: 'x', url: 'https://github.com/o/r/issues/3', labels: [{ name: 'bug' }], assignees: [{ login: 'ada' }] }
  ]));
  fakeCli(bin, 'glab', JSON.stringify([{ iid: 999, title: 'From glab' }]));

  const res = await withFakeClis(bin, () => listIssues(repo));
  assert.equal(res.ok, true, res.error);
  assert.deepEqual(res.issues, [
    { number: 3, title: 'From gh', body: 'x', url: 'https://github.com/o/r/issues/3', labels: ['bug'], assignees: ['ada'] }
  ]);
});

test('an unsupported host is refused by name instead of guessed at', { skip: !POSIX }, async (t) => {
  const { repo, bin } = repoWithOrigin(t, 'https://gitlab.example.com/group/repo.git');
  // Both CLIs are available and would happily answer; neither may be run.
  fakeCli(bin, 'gh', JSON.stringify([{ number: 1, title: 'nope' }]));
  fakeCli(bin, 'glab', JSON.stringify([{ iid: 1, title: 'nope' }]));

  const res = await withFakeClis(bin, () => listIssues(repo));
  assert.equal(res.ok, false);
  assert.match(res.error, /github\.com and gitlab\.com/);
  assert.equal(res.issues, undefined);
});

test('a repo with no origin remote reports that, not a CLI failure', { skip: !POSIX }, async (t) => {
  const { repo, bin } = repoWithOrigin(t, null);
  fakeCli(bin, 'gh', JSON.stringify([{ number: 1, title: 'nope' }]));

  const res = await withFakeClis(bin, () => listIssues(repo));
  assert.equal(res.ok, false);
  assert.match(res.error, /origin/);
});

test('a credential embedded in the origin URL is not echoed into the error', { skip: !POSIX }, async (t) => {
  // The error string is rendered in the app; a remote carrying a PAT must not
  // put it on screen (or into a bug report pasted from it).
  const { repo, bin } = repoWithOrigin(t, 'https://user:s3cr3t-token@git.example.com/group/repo.git');
  const res = await withFakeClis(bin, () => listIssues(repo));
  assert.equal(res.ok, false);
  assert.equal(res.error.includes('s3cr3t-token'), false, res.error);
});
