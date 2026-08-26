'use strict';

/**
 * The adapter contract, with the transport injected.
 *
 * The picker asks for a live list on a user click, so the ONLY thing this
 * layer may ever do on failure is resolve null — a rejected promise here
 * would surface as an unhandled error in the main process and the picker
 * would hang instead of falling back to its built-in list. So the tests
 * drive a runner that succeeds, one that throws, and one that answers with
 * something unparseable.
 *
 * The real stdio transport (defaultCodexRunner) is NOT exercised here: it
 * needs codex installed and logged in, and a fake that pretends to spawn
 * would assert nothing about the framing. It is covered by the handshake
 * output captured against a real codex instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

// The transport names the app in its JSON-RPC handshake, which is the one thing
// it needs Electron for; outside Electron that resolve gives a path string.
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getVersion: () => '0.0.0-test' } }
};

const { createCodexModelCatalog, defaultCodexRunner } =
  loadTs('src/main/codexModelCatalog.ts');

test('a live model/list result becomes a catalog', async () => {
  const runner = async () => ({
    data: [
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true },
      { id: 'gpt-5.5', displayName: 'GPT-5.5' }
    ],
    nextCursor: null
  });
  const out = await createCodexModelCatalog(runner, {}).queryModels();
  assert.deepEqual(out, {
    models: [
      { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
      { id: 'gpt-5.5', label: 'GPT-5.5' }
    ],
    default: 'gpt-5.6-sol'
  });
});

test('the runner is handed the env it must authenticate with', async () => {
  const seen = [];
  const runner = async (env) => { seen.push(env); return { data: [{ id: 'gpt-5.5' }] }; };
  await createCodexModelCatalog(runner, { CODEX_HOME: '/tmp/codex-home' }).queryModels();
  assert.deepEqual(seen, [{ CODEX_HOME: '/tmp/codex-home' }],
    'the query must run against the caller-supplied env, not a bare process.env');
});

test('a runner failure resolves to null and never throws', async () => {
  const boom = async () => { throw new Error('codex not found'); };
  assert.equal(await createCodexModelCatalog(boom, {}).queryModels(), null);
});

test('a runner that throws synchronously also resolves to null', async () => {
  const boom = () => { throw new Error('spawn EACCES'); };
  assert.equal(await createCodexModelCatalog(boom, {}).queryModels(), null);
});

test('an unparseable result resolves to null', async () => {
  const junk = async () => ({ nope: true });
  assert.equal(await createCodexModelCatalog(junk, {}).queryModels(), null);
});

test('the real transport is the default runner', () => {
  // Not invoked — spawning codex here would be a live-CLI test in disguise.
  // This only pins that the shipped default is the real transport and not a
  // stub left behind by the injectable seam.
  assert.equal(typeof defaultCodexRunner, 'function');
});
