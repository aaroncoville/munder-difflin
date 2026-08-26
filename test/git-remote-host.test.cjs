'use strict';

/**
 * A repository's `origin` URL is the only evidence always at hand for which
 * forge a checkout belongs to, and it arrives in two unrelated syntaxes for the
 * same repository: `https://host/owner/repo` from an HTTPS clone and the
 * scp-like `git@host:owner/repo.git` from an SSH one. Both must resolve to the
 * same host, or the same project routes differently depending on how a
 * contributor happened to clone it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');

const { parseGitRemoteHost, issueHostFor } = loadTs('src/main/gitHost.ts');
const { getRemoteUrl } = loadTs('src/main/git.ts');

test('a remote URL yields its host in both syntaxes git uses', () => {
  assert.equal(parseGitRemoteHost('https://github.com/owner/repo.git'), 'github.com');
  assert.equal(parseGitRemoteHost('https://github.com/owner/repo'), 'github.com');
  assert.equal(parseGitRemoteHost('git@github.com:owner/repo.git'), 'github.com');
  assert.equal(parseGitRemoteHost('ssh://git@github.com:22/owner/repo.git'), 'github.com');
  assert.equal(parseGitRemoteHost('git://github.com/owner/repo.git'), 'github.com');

  // GitLab nests groups, so the path after the host has more segments.
  assert.equal(parseGitRemoteHost('https://gitlab.com/group/sub/repo.git'), 'gitlab.com');
  assert.equal(parseGitRemoteHost('git@gitlab.com:group/sub/repo.git'), 'gitlab.com');

  // Credentials embedded in the URL are not part of the host.
  assert.equal(parseGitRemoteHost('https://user:tok@gitlab.com/g/r.git'), 'gitlab.com');
  assert.equal(parseGitRemoteHost('https://token@github.com/o/r.git'), 'github.com');

  // Case is not significant in a hostname; callers compare exact strings.
  assert.equal(parseGitRemoteHost('https://GitHub.COM/o/r'), 'github.com');

  assert.equal(parseGitRemoteHost(''), null);
  assert.equal(parseGitRemoteHost('   '), null);
  assert.equal(parseGitRemoteHost('/Users/someone/local/repo'), null);
  assert.equal(parseGitRemoteHost('./relative/repo'), null);
});

test('only github.com and gitlab.com resolve to a forge', () => {
  assert.equal(issueHostFor('git@github.com:o/r.git'), 'github');
  assert.equal(issueHostFor('https://github.com/o/r'), 'github');
  assert.equal(issueHostFor('git@gitlab.com:o/r.git'), 'gitlab');
  assert.equal(issueHostFor('https://gitlab.com/o/r'), 'gitlab');

  // A self-hosted instance is NOT inferred from a hostname that merely reads
  // like one: its API and its CLI authentication are a separate question.
  assert.equal(issueHostFor('https://gitlab.example.com/o/r.git'), null);
  assert.equal(issueHostFor('git@gitlab.internal.corp:o/r.git'), null);
  assert.equal(issueHostFor('https://github.enterprise.corp/o/r.git'), null);
  assert.equal(issueHostFor('https://bitbucket.org/o/r.git'), null);
  assert.equal(issueHostFor('https://codeberg.org/o/r.git'), null);
  assert.equal(issueHostFor(''), null);
});

/**
 * `git remote get-url` reports the *effective* URL, so a developer's own
 * `url.<base>.insteadOf` rewrite rules change its answer. That is the behaviour
 * we want in the app — the rewritten URL is the host git actually contacts —
 * but it makes an exact-string assertion depend on whoever runs the suite, so
 * the config the test's own git sees is emptied out.
 */
const HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };

function tempRepo(t, remotes = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-remote-url-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const opts = { cwd: dir, env: { ...process.env, ...HERMETIC } };
  execFileSync('git', ['init', '-q'], opts);
  for (const [name, url] of Object.entries(remotes)) {
    execFileSync('git', ['remote', 'add', name, url], opts);
  }
  return dir;
}

/** Run `fn` with `HERMETIC` applied, so the git `getRemoteUrl` spawns inherits it. */
async function hermetically(fn) {
  const before = { ...process.env };
  Object.assign(process.env, HERMETIC);
  try {
    return await fn();
  } finally {
    for (const key of Object.keys(HERMETIC)) {
      if (key in before) process.env[key] = before[key];
      else delete process.env[key];
    }
  }
}

test('the configured URL is read back for origin and for a named remote', async (t) => {
  const repo = tempRepo(t, {
    origin: 'git@gitlab.com:group/repo.git',
    fork: 'https://github.com/me/repo.git'
  });

  await hermetically(async () => {
    assert.deepEqual(await getRemoteUrl(repo), { ok: true, url: 'git@gitlab.com:group/repo.git' });
    assert.deepEqual(await getRemoteUrl(repo, 'fork'), { ok: true, url: 'https://github.com/me/repo.git' });
  });
});

test('a repo with no such remote fails rather than reporting an empty URL', async (t) => {
  const repo = tempRepo(t);
  const res = await hermetically(() => getRemoteUrl(repo));
  assert.equal(res.ok, false);
  assert.equal('url' in res, false);
  assert.match(res.error, /origin/);
});
