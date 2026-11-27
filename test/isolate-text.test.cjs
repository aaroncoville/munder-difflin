'use strict';

// isolate() wraps a part of a sentence in FSI (U+2068) and PDI (U+2069), the plain-text form of <bdi>. Isolate marks
// already in that part (U+2066 to U+2069) are dropped first, so a title or error cannot close the isolation early.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const { isolate } = loadTs('src/renderer/src/i18n/isolate.ts');

test('a part is wrapped in FSI and PDI', () => {
  assert.equal(isolate('ship it'), '⁨ship it⁩');
});

test('a title holding a PDI (or any isolate mark) stays isolated', () => {
  const wrapped = isolate('ship⁩ it⁦⁧⁨');
  assert.equal(wrapped, '⁨ship it⁩');
  assert.equal([...wrapped].filter((c) => c === '⁩').length, 1, 'one PDI, at the end');
});
