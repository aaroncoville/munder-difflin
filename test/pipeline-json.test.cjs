'use strict';
// A strict JSON parser for text from outside the app (an agent's message, a forge or
// deploy answer). JSON.parse keeps the last copy of a name given twice, and another
// reader may keep the first, so one text could mean two things to two readers. This
// parser refuses it, agrees with JSON.parse on everything else, and never throws.

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/main/pipeline/mr-core.cjs');

test('JSON with a name given twice is refused, at any depth and however the name is escaped', () => {
  for (const text of [
    '{"sha":"a","sha":"b"}',
    '{"x":{"state":"opened","state":"merged"}}',
    '[{"k":1,"k":1}]',
    '{"sha":"a","\\u0073ha":"b"}',
  ]) {
    const r = core.parseJson(text);
    assert.equal(r.ok, false, text);
    assert.match(r.reason, /twice|duplicate/i, text);
  }
});

test('the strict parser agrees with JSON.parse on valid JSON and refuses, never throws, on anything else', () => {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const value = (d) => {
    const k = d > 3 ? pick(['n', 's', 'b', 'z']) : pick(['n', 's', 'b', 'z', 'a', 'o']);
    if (k === 'n') return pick([0, -1, 1.5, 1e21, 123456789]);
    if (k === 's') return pick(['', 'é✓𝄞', 'a"b\\c', ' ', 'x\ny']);
    if (k === 'b') return rnd() < 0.5;
    if (k === 'z') return null;
    if (k === 'a') return Array.from({ length: Math.floor(rnd() * 3) }, () => value(d + 1));
    const o = {};
    for (let i = 0; i < Math.floor(rnd() * 4); i++) o[pick(['a', 'b', 'sha', '__proto__', 'constructor', 'é'])] = value(d + 1);
    return o;
  };
  for (let i = 0; i < 300; i++) {
    const v = value(0);
    const text = JSON.stringify(v);
    const r = core.parseJson(text);
    assert.equal(r.ok, true, text);
    assert.deepEqual(r.value, JSON.parse(text), text);
  }
  const junk = ['', ' ', '{', '}', '[1,]', '{"a":}', '{"a" 1}', 'nul', 'tru', '01', '1.', '.5', '"\\x"', '"\u0001"', '{"a":1}x', '[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]', '"\\ud800"x', null, 7];
  for (let i = 0; i < 300; i++) junk.push(Array.from({ length: Math.floor(rnd() * 12) }, () => pick(['{', '}', '[', ']', '"', ':', ',', 'a', '1', ' ', '\\', 'n', 'u'])).join(''));
  for (const t of junk) {
    let r;
    assert.doesNotThrow(() => { r = core.parseJson(t); }, String(t));
    let native = true;
    try { JSON.parse(t); } catch { native = false; }
    if (!native || typeof t !== 'string') assert.equal(r.ok, false, String(t));
  }
});

test('"__proto__" in JSON is an ordinary own name, as JSON.parse makes it, and sets no prototype', () => {
  const r = core.parseJson('{"__proto__":{"state":"opened"}}');
  assert.equal(r.ok, true);
  assert.equal(Object.getPrototypeOf(r.value), Object.prototype);
  assert.equal(Object.hasOwn(r.value, '__proto__'), true);
  assert.equal(r.value.state, undefined);
});

