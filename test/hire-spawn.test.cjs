'use strict';

/**
 * T-045 — a spawn-request may instantiate a HIRE, not just an ad-hoc worker.
 *
 * The security property this file exists to pin down: a hire manifest is authored
 * by god (or arrives in a shared file), and **a god-authored spawn-request is not
 * human consent**. So no manifest may ever arm a write/secret MCP server, however
 * it asks. `mergeHireMcpDefaults` is the second of two tier gates and the one that
 * runs on the spawn path, so it is tested directly rather than through the plan.
 *
 * The rest covers the merge/precedence rules a hire relies on to stay a DEFAULT
 * rather than an override.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const loadTs = require('./load-ts.cjs');

const { mergeHireMcpDefaults, resolveHireManifestPath, resolveHireDefaults } = loadTs('src/main/hireSpawn.ts');
const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');
const { MCP_CATALOG } = loadTs('src/shared/mcpCatalog.ts');

// DERIVED from the catalog, never copied literals. Review of PR #1 caught the
// copied-literal version, and rightly: a test that hardcodes the same ids the
// implementation classifies keeps passing when the catalog's tiers change
// underneath it, which is the one moment it most needs to fail. This is the same
// defect god flagged in someone else's work the same morning.
const SAFE = MCP_CATALOG.find((e) => e.tier === 'safe-readonly').id;
const UNSAFE = MCP_CATALOG.filter((e) => e.tier !== 'safe-readonly').map((e) => e.id);
assert.ok(SAFE, 'catalog must contain at least one safe-readonly entry');
assert.ok(UNSAFE.length, 'catalog must contain at least one write/secret entry');

test('a manifest can never arm ANY write/secret MCP server in the catalog', () => {
  // Every non-safe id, not a sample: a new secret entry added to the catalog
  // tomorrow is covered by this test today.
  const out = mergeHireMcpDefaults(undefined, UNSAFE);
  for (const id of UNSAFE) {
    assert.equal(out?.[id], undefined, `${id} must never be enabled by a manifest`);
  }
});

test('a mixed request enables only the safe half', () => {
  const out = mergeHireMcpDefaults({}, [SAFE, ...UNSAFE]);
  assert.deepEqual(out[SAFE], { enabled: true }, 'safe-readonly id should be enabled');
  for (const id of UNSAFE) assert.equal(out[id], undefined, `${id} must be dropped, not enabled`);
});

test("an explicit human 'off' outranks the manifest", () => {
  const out = mergeHireMcpDefaults({ [SAFE]: { enabled: false } }, [SAFE]);
  assert.deepEqual(out[SAFE], { enabled: false }, 'a manifest may not re-enable what the human switched off');
});

test('an already-on entry is left exactly as the human set it', () => {
  const base = { [SAFE]: { enabled: true } };
  const out = mergeHireMcpDefaults(base, [SAFE]);
  assert.deepEqual(out[SAFE], { enabled: true });
  assert.notEqual(out, base, 'the base map must not be mutated in place');
});

test('a hire id may not escape the hires directory', () => {
  for (const bad of ['../secrets', 'a/b', '/etc/passwd', '', '   ']) {
    assert.equal(resolveHireManifestPath('/hive/hires', bad).ok, false, `"${bad}" must be rejected`);
  }
  assert.equal(resolveHireManifestPath('/hive/hires', 'dwight-qa').ok, true);
  assert.equal(resolveHireManifestPath('/hive/hires', 'dwight-qa.hire.json').ok, true);
});

test("a hire's flags ride BEHIND the request's own", () => {
  const l = buildWorkerLaunch({
    requestCommand: 'claude --verbose',
    autoMode: false,
    hireFlags: ['--permission-mode', 'plan']
  });
  assert.equal(l.bin, 'claude');
  assert.deepEqual(l.args, ['--verbose', '--permission-mode', 'plan']);
  assert.equal(l.command, 'claude --verbose --permission-mode plan');
});

test('a hire model does not override a model the command line already picked', () => {
  // The request's own --model wins; the separate model field must not double up.
  const l = buildWorkerLaunch({
    requestCommand: 'claude --model gpt-5.6-terra',
    requestModel: 'claude-opus-5',
    autoMode: false
  });
  assert.equal(l.args.filter((a) => a === '--model').length, 1, 'exactly one --model may survive');
  assert.ok(l.args.includes('gpt-5.6-terra'));
  assert.ok(!l.args.includes('claude-opus-5'));
});

test('no hire flags is identical to the pre-hire behaviour', () => {
  const withNone = buildWorkerLaunch({ requestCommand: 'claude --verbose', autoMode: false });
  const withEmpty = buildWorkerLaunch({ requestCommand: 'claude --verbose', autoMode: false, hireFlags: [] });
  assert.deepEqual(withEmpty, withNone);
});


// ── precedence (regression: PR #1 review) ───────────────────────────────────
// A codex hire with no request provider launched under codex but was BROADCAST
// as claude, so a restart restored it as the wrong CLI. The bug was one consumer
// reading the request's value and forgetting the manifest's. These pin the rule
// itself rather than any one call site.

test('the request wins on every field it states', () => {
  const eff = resolveHireDefaults(
    { provider: 'codex', model: 'm-req', name: 'n-req', character: 'c-req', accent: 'a-req' },
    { provider: 'claude', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire' }
  );
  assert.deepEqual(eff, { provider: 'codex', model: 'm-req', name: 'n-req', character: 'c-req', accent: 'a-req', tokenCap: undefined });
});

test('the manifest fills every field the request leaves unset', () => {
  const eff = resolveHireDefaults({}, {
    provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire', tokenCap: undefined
  });
  assert.deepEqual(eff, { provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire', tokenCap: undefined });
  assert.equal(eff.provider, 'codex', "the exact regression: a codex hire must not resolve to claude");
});

test('an empty or whitespace request value is not a stated choice', () => {
  const eff = resolveHireDefaults(
    { provider: '', model: '   ', name: '', character: null, accent: undefined },
    { provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire' }
  );
  assert.deepEqual(eff, { provider: 'codex', model: 'm-hire', name: 'n-hire', character: 'c-hire', accent: 'a-hire', tokenCap: undefined });
});

test('with no manifest at all, nothing is invented', () => {
  assert.deepEqual(resolveHireDefaults({ provider: 'codex' }, undefined),
    { provider: 'codex', model: undefined, name: undefined, character: undefined, accent: undefined, tokenCap: undefined });
});


// ── tokenCap precedence (T-062: spend control) ──────────────────────────────
// A manifest's `tokenCap` was never consulted on spawn: the cap came solely from
// the spawn-request JSON, so a hire that declares a ceiling launched UNCAPPED
// whenever the request omitted one — and omitting it is the safe-looking choice.
// tokenCap now resolves through the same one place as every other hire field.
// The numbers below are arbitrary literals; nothing here is shared with the
// implementation, which carries no cap constant of its own.

test('a request token cap wins over the manifest (both set)', () => {
  const eff = resolveHireDefaults({ tokenCap: 250000 }, { tokenCap: 4000000 });
  assert.equal(eff.tokenCap, 250000, 'the request states a ceiling; the manifest is only a default');
});

test('the manifest token cap applies when the request omits it', () => {
  // THE BUG. Before the fix this resolved to undefined and the worker ran uncapped.
  const eff = resolveHireDefaults({}, { tokenCap: 4000000 });
  assert.equal(eff.tokenCap, 4000000, 'a hire that declares a ceiling must never spawn uncapped');
});

test('a request token cap applies with no manifest at all', () => {
  const eff = resolveHireDefaults({ tokenCap: 250000 }, undefined);
  assert.equal(eff.tokenCap, 250000);
});

test('a non-positive or non-numeric request cap is not a stated choice', () => {
  // Same rule as the string fields: an unusable request value must fall back to
  // the manifest, not silently disable the hire's ceiling.
  for (const bad of [0, -1, NaN, Infinity, '4000000', null, true]) {
    assert.equal(resolveHireDefaults({ tokenCap: bad }, { tokenCap: 4000000 }).tokenCap, 4000000,
      `tokenCap ${String(bad)} must fall through to the manifest`);
  }
});

test('with a cap nowhere, none is invented', () => {
  assert.equal(resolveHireDefaults({}, {}).tokenCap, undefined);
  assert.equal(resolveHireDefaults({}, undefined).tokenCap, undefined);
});

test('the spawn path registers the RESOLVED cap, not the raw request one', () => {
  // The call site is where the bug actually lived, and index.ts imports electron
  // so it cannot be loaded here. Same source-assertion pattern hire-import.test.cjs
  // uses for the hire:openFile handler: pin the real line rather than restate it.
  const source = readFileSync('src/main/index.ts', 'utf8');
  const start = source.indexOf('// Register for done-scan / idle-reap / token-cap');
  const end = source.indexOf('liveWorkers.set(', start);
  assert.ok(start >= 0 && end > start, 'worker registration block is present');
  const block = source.slice(start, end);
  assert.match(block, /const tokenCap = eff\.tokenCap;/,
    'the cap must come from resolveHireDefaults so a manifest ceiling is honoured');
  assert.doesNotMatch(block, /raw\.tokenCap/,
    'reading the spawn-request directly is what let a hire spawn uncapped');
});
