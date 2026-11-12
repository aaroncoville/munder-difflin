'use strict';
// The pipeline's operator configuration (spec 9 and 11). It lives in the app's own
// config, which agents cannot write. The pipeline is off unless it is turned on in
// so many words, and it may not be configured into the anti-goals: a merge on one
// vendor's review, or a credential in a remote URL.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { pipelineSettings, WAYFARER } = loadTs('src/main/pipeline/config.ts');

test('with nothing configured the pipeline is off, merges nothing itself, and knows Wayfarer', () => {
  for (const raw of [undefined, null, {}, 'yes', 1]) {
    const s = pipelineSettings(raw);
    assert.equal(s.enabled, false, JSON.stringify(raw));
    assert.equal(s.autoMerge, false, JSON.stringify(raw));
    assert.deepEqual(Object.keys(s.repos), ['wayfarer']);
  }
});

test('only a literal true turns it on, or turns on merging', () => {
  for (const v of ['true', 1, 'on', {}]) {
    assert.equal(pipelineSettings({ enabled: v, autoMerge: v }).enabled, false, JSON.stringify(v));
    assert.equal(pipelineSettings({ enabled: v, autoMerge: v }).autoMerge, false, JSON.stringify(v));
  }
  const on = pipelineSettings({ enabled: true, autoMerge: true });
  assert.equal(on.enabled, true);
  assert.equal(on.autoMerge, true);
});

test('Wayfarer: GitLab, main, the live version URL, one Claude and two Codex reviewers, two vendors', () => {
  assert.equal(WAYFARER.forge, 'gitlab');
  assert.equal(WAYFARER.project, 'wooden-bird/wayfarer');
  assert.equal(WAYFARER.target, 'main');
  assert.equal(WAYFARER.remote, 'https://gitlab.com/wooden-bird/wayfarer.git');
  assert.deepEqual(WAYFARER.live, { kind: 'http-json', url: 'https://wayfarer-home.fly.dev/api/version', field: 'commit' });
  assert.deepEqual(WAYFARER.panel, { anthropic: ['orsolina'], openai: ['jannings', 'tryphon'] });
  assert.equal(WAYFARER.minVendors, 2);
  assert.equal(WAYFARER.maxRounds, 3);
});

test('Wayfarer\'s human-only paths cover its CI and deploy files as they are named in the repo', () => {
  const { matchesAny } = loadTs('src/main/pipeline/config.ts');
  for (const p of ['.gitlab-ci.yml', 'scripts/ci/verify_deploy.sh', 'scripts/ci/test/test_deploy_order.sh', 'deploy/fly/api.toml', 'deploy/fly/web.toml', 'api/Dockerfile', 'web/Dockerfile']) {
    assert.equal(matchesAny(p, WAYFARER.humanOnlyPaths), true, p);
  }
  for (const p of ['web/src/App.tsx', 'api/src/main/kotlin/io/wayfarer/Application.kt', 'docs/deploy-fly.md', 'scripts/e2e.sh']) {
    assert.equal(matchesAny(p, WAYFARER.humanOnlyPaths), false, p);
  }
});

test('fewer than two vendors cannot be configured: a merge on one vendor\'s review is an anti-goal', () => {
  const s = pipelineSettings({ repos: { wayfarer: { ...WAYFARER, minVendors: 1 } } });
  assert.equal(s.repos.wayfarer.minVendors, 2);
});

test('a repo entry with a credential in its remote or a non-https URL is dropped, not used', () => {
  const bad = [
    { ...WAYFARER, remote: 'https://oauth2:glpat-secret@gitlab.com/wooden-bird/wayfarer.git' },
    { ...WAYFARER, remote: 'git@gitlab.com:wooden-bird/wayfarer.git' },
    { ...WAYFARER, live: { ...WAYFARER.live, url: 'http://wayfarer-home.fly.dev/api/version' } },
    { ...WAYFARER, forge: 'github' },
    { ...WAYFARER, target: '' },
    { ...WAYFARER, panel: { anthropic: ['orsolina'], openai: ['bad name!'] } },
    // A secret in a query string or fragment is still a secret on an argument list or in a log.
    { ...WAYFARER, remote: 'https://gitlab.com/wooden-bird/wayfarer.git?private_token=SECRET' },
    { ...WAYFARER, live: { ...WAYFARER.live, url: 'https://wayfarer-home.fly.dev/api/version?token=SECRET' } },
    { ...WAYFARER, live: { ...WAYFARER.live, url: 'https://wayfarer-home.fly.dev/api/version#token=SECRET' } },
    // The path guards fail closed: a missing or malformed list drops the repo, like any other bad field.
    { ...WAYFARER, humanOnlyPaths: undefined },
    { ...WAYFARER, sensitivePaths: undefined },
    { ...WAYFARER, humanOnlyPaths: ['.gitlab-ci.yml', 7] },
    { ...WAYFARER, sensitivePaths: ['', '**/auth/**'] },
    // One agent cannot fill both vendors' seats.
    { ...WAYFARER, panel: { anthropic: ['orsolina'], openai: ['orsolina'] } },
  ];
  for (const entry of bad) {
    const s = pipelineSettings({ enabled: true, repos: { wayfarer: entry } });
    assert.deepEqual(Object.keys(s.repos), [], JSON.stringify(entry).slice(0, 120));
  }
});

test('glob matching: ** crosses directories, * stays inside one', () => {
  const { matchesAny } = loadTs('src/main/pipeline/config.ts');
  assert.equal(matchesAny('a/b/c.toml', ['**/*.toml']), true);
  assert.equal(matchesAny('c.toml', ['**/*.toml']), true);
  assert.equal(matchesAny('a/b/c.toml', ['a/*.toml']), false);
  assert.equal(matchesAny('a/c.toml', ['a/*.toml']), true);
  assert.equal(matchesAny('a.b', ['a?b']), false);
});

test('an explicit empty human-only list is allowed: the operator said so', () => {
  const s = pipelineSettings({ repos: { wayfarer: { ...WAYFARER, humanOnlyPaths: [], sensitivePaths: [] } } });
  assert.deepEqual(s.repos.wayfarer.humanOnlyPaths, []);
});

test('Wayfarer\'s sensitive paths cover its authorization rules and session code, not only auth/ and migrations', () => {
  const { matchesAny } = loadTs('src/main/pipeline/config.ts');
  for (const p of [
    'api/src/main/kotlin/io/wayfarer/domain/Visibility.kt',
    'api/src/main/kotlin/io/wayfarer/auth/AuthService.kt',
    'api/src/main/kotlin/io/wayfarer/data/SessionRepository.kt',
    'api/src/main/kotlin/io/wayfarer/routes/SessionRoutes.kt',
    'api/src/main/kotlin/io/wayfarer/routes/AuthRoutes.kt',
    'api/src/main/kotlin/io/wayfarer/routes/GoogleAuthRoutes.kt',
    'api/src/main/kotlin/io/wayfarer/data/OAuthStateRepository.kt',
    'api/src/main/kotlin/io/wayfarer/routes/PinResetRoutes.kt',
    'api/src/main/kotlin/io/wayfarer/data/GuardianPinResetRepository.kt',
    'api/src/main/resources/db/migration/V41__x.sql',
  ]) assert.equal(matchesAny(p, WAYFARER.sensitivePaths), true, p);
  assert.equal(matchesAny('web/src/components/TaskList.tsx', WAYFARER.sensitivePaths), false);
});

test('the Wayfarer default cannot be changed by whoever holds it', () => {
  assert.throws(() => { WAYFARER.minVendors = 1; }, TypeError);
  assert.throws(() => { WAYFARER.panel.openai.push('mallory'); }, TypeError);
  assert.equal(pipelineSettings(undefined).repos.wayfarer.minVendors, 2);
});
