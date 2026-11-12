'use strict';
// An ask is keyed the same way on both sides of the usage log: the floor's
// ask-filed rows and the owner's ask-shown/ask-submitted rows. The weekly digest
// pairs them by this key, so the two must agree for any form of askedAt.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { askKeyOf } = loadTs('src/shared/askKey.ts');
const U = loadTs('src/main/usageEvents.ts');

test('the key is the card id and the ask time in canonical ISO form', () => {
  assert.equal(askKeyOf('CARD-1', '2026-11-12T10:00:00Z'), 'CARD-1@2026-11-12T10:00:00.000Z');
  assert.equal(askKeyOf('CARD-1', '2026-11-12T10:00:00.000Z'), 'CARD-1@2026-11-12T10:00:00.000Z');
});

test('no key from a card id or ask time that is not one', () => {
  assert.equal(askKeyOf('a card id', '2026-11-12T10:00:00Z'), undefined);
  assert.equal(askKeyOf('CARD-1', 'yesterday, after lunch'), undefined);
});

test('the floor\'s ask-filed row uses the same key the owner\'s side does', () => {
  const askedAt = '2026-11-12T10:00:00Z'; // not in toISOString form
  const rows = U.diffTasks([{ id: 'CARD-1', status: 'blocked', humanQA: [] }], [{ id: 'CARD-1', status: 'blocked', humanQA: [{ q: 'q', askedAt }] }], 0);
  assert.equal(rows[0].askKey, askKeyOf('CARD-1', askedAt));
});
