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
const loadTs = require('./load-ts.cjs');

const { mergeHireMcpDefaults, resolveHireManifestPath } = loadTs('src/main/hireSpawn.ts');
const { buildWorkerLaunch } = loadTs('src/main/workerLaunch.ts');

// From src/shared/mcpCatalog.ts: safe-readonly vs secret.
const SAFE = 'context7';
const SECRET = 'github-token';

test('a manifest can never arm a write/secret MCP server', () => {
  const out = mergeHireMcpDefaults(undefined, [SECRET, 'db', 'email-calendar', 'search-with-key']);
  // Nothing safe was asked for, so the base is returned untouched — and crucially
  // no secret id appears anywhere.
  for (const id of [SECRET, 'db', 'email-calendar', 'search-with-key']) {
    assert.equal(out?.[id], undefined, `${id} must never be enabled by a manifest`);
  }
});

test('a mixed request enables only the safe half', () => {
  const out = mergeHireMcpDefaults({}, [SAFE, SECRET]);
  assert.deepEqual(out[SAFE], { enabled: true }, 'safe-readonly id should be enabled');
  assert.equal(out[SECRET], undefined, 'secret id must be dropped, not enabled');
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
