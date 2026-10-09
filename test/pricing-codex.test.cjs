'use strict';

/**
 * Fallback prices for the Codex models. A model id the table does not know is
 * priced as Sonnet, which puts GPT-5.6 Sol at under half its list price and
 * GPT-6.1 Sol's cached input at three times its own.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { priceFor } = loadTs('src/main/pricing.ts');

test('Codex models are priced at their own list price, not as Sonnet', () => {
  assert.deepEqual(priceFor('gpt-5.6-sol'), { inputPerM: 4, outputPerM: 20, cacheReadPerM: 0.4, cacheWritePerM: 0 });
  assert.deepEqual(priceFor('gpt-6.1-sol'), { inputPerM: 2, outputPerM: 10, cacheReadPerM: 0.1, cacheWritePerM: 0 });
});
