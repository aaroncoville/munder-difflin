'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { activeSource, boundedSlice } = require('./source-assert.cjs');

const FIXTURE = 'test/fixtures/source-assert-fixture.ts';

test('activeSource strips /* */ block comments', () => {
  const src = activeSource(FIXTURE);
  assert.doesNotMatch(src, /blockedCall/);
  assert.match(src, /activeCall/);
});

test('activeSource strips trailing // comments', () => {
  const src = activeSource(FIXTURE);
  assert.doesNotMatch(src, /inlineComment/);
  assert.match(src, /activeCall/);
});

test('activeSource is anchored to the repo root, not the caller', () => {
  assert.doesNotThrow(() => activeSource(FIXTURE));
});

test('activeSource preserves // inside a string literal', () => {
  const src = activeSource(FIXTURE);
  assert.match(src, /urlCall/);
  assert.match(src, /example\.test\/x/);
});

test('activeSource preserves /* */ tokens inside a string literal', () => {
  const src = activeSource(FIXTURE);
  assert.match(src, /markerCall/);
  assert.match(src, /not a comment/);
});

test('activeSource preserves // inside a template literal', () => {
  const src = activeSource(FIXTURE);
  assert.match(src, /tmplCall/);
  assert.match(src, /x\.io\/path/);
});

test('activeSource preserves // inside a regex literal', () => {
  const src = activeSource(FIXTURE);
  assert.match(src, /reCall/);
});

test('boundedSlice returns the text between the two anchors', () => {
  const src = activeSource(FIXTURE);
  const region = boundedSlice(src, 'fixture_start', 'fixture_end');
  assert.match(region, /activeCall/);
  assert.ok(!region.includes('fixture_end'), 'end anchor must not appear in the slice');
});

test('boundedSlice throws when startAnchor is absent', () => {
  assert.throws(
    () => boundedSlice('hello world', 'missing', 'world'),
    /startAnchor not found/
  );
});

test('boundedSlice throws when endAnchor is absent after start', () => {
  assert.throws(
    () => boundedSlice('hello world', 'hello', 'missing'),
    /endAnchor not found/
  );
});

test('boundedSlice throws when endAnchor appears only before startAnchor', () => {
  // 'end' is at index 0; 'start' is at index 4 — indexOf('end', 4) returns -1
  assert.throws(
    () => boundedSlice('end|start', 'start', 'end'),
    /endAnchor not found/
  );
});
