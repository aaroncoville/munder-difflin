'use strict';

/**
 * The provider→adapter registry and the body behind the models:refresh IPC.
 *
 * Only codex can answer a live catalog today, so the registry's job is to say
 * so plainly for everything else instead of leaving the renderer to guess. The
 * IPC body never rejects and never returns an empty list: the picker's fallback
 * needs a reason string it can show next to the built-in list.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getVersion: () => '0.0.0-test' } }
};

const { modelCatalogFor, refreshModels, CATALOG_CAPABLE_PROVIDERS } =
  loadTs('src/main/modelCatalogRegistry.ts');

test('only codex has an adapter', () => {
  assert.ok(modelCatalogFor('codex'), 'codex must resolve to an adapter');
  assert.equal(modelCatalogFor('claude'), undefined);
  assert.equal(modelCatalogFor('cursor'), undefined);
  assert.equal(modelCatalogFor(''), undefined);
});

test('the capability list names exactly the providers that have an adapter', () => {
  // Written out literally: a list derived from the registry it is checking
  // would agree with itself no matter which providers actually resolve.
  assert.deepEqual([...CATALOG_CAPABLE_PROVIDERS], ['codex']);
  for (const provider of CATALOG_CAPABLE_PROVIDERS) {
    assert.ok(modelCatalogFor(provider), `${provider} is advertised but has no adapter`);
  }
});

test('an unsupported provider gets an error naming it, not a rejection', async () => {
  const result = await refreshModels('claude');
  assert.ok('error' in result, 'the renderer must get a reason, never an empty catalog');
  assert.match(result.error, /claude/);
  assert.ok(!('models' in result));
});

test('an adapter that cannot answer becomes an error the picker can show', async () => {
  const result = await refreshModels('codex', () => ({ queryModels: async () => null }));
  assert.ok('error' in result);
  assert.match(result.error, /built-in list/, 'the message must tell the user what they are looking at');
});

test('a live catalog is passed through untouched', async () => {
  const live = { models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }], default: 'gpt-5.5' };
  const result = await refreshModels('codex', () => ({ queryModels: async () => live }));
  assert.deepEqual(result, live);
});

test('an adapter that throws still resolves to an error string', async () => {
  const result = await refreshModels('codex', () => ({
    queryModels: async () => { throw new Error('boom'); }
  }));
  assert.ok('error' in result, 'the IPC handler must never reject into the renderer');
});
