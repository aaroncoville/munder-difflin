'use strict';

/**
 * The fallback price table, for the Haiku generations. The live path takes
 * Claude's own per-model cost; this table is what a cost estimate falls back to
 * when that is missing, so a Haiku 5.5 session priced as Haiku 4.5 would read
 * eight times too expensive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { priceFor, estimateCostUsd } = loadTs('src/main/pricing.ts');

test('Haiku 5.5 falls back to its own list price', () => {
  assert.deepEqual(priceFor('claude-haiku-5-5'), {
    inputPerM: 0.1, outputPerM: 0.5, cacheReadPerM: 0.01, cacheWritePerM: 0.125,
  });
  // A million of each kind of token, priced end to end.
  const usd = estimateCostUsd('claude-haiku-5-5', {
    inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6,
  });
  assert.ok(Math.abs(usd - 0.735) < 1e-9, String(usd));
});

test('Haiku 4.5 keeps the price it had', () => {
  assert.deepEqual(priceFor('claude-haiku-4-5-20251001'), {
    inputPerM: 0.8, outputPerM: 4, cacheReadPerM: 0.08, cacheWritePerM: 1.0,
  });
});
