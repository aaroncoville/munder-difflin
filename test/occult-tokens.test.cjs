'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');

/** Names of the custom properties declared inside one CSS block. */
const tokensOf = (css, blockRe) => {
  const m = css.match(blockRe);
  assert.ok(m, `block ${blockRe} not found`);
  return new Set([...m[1].matchAll(/--cth-[\w-]+(?=\s*:)/g)].map((x) => x[0]));
};

const base = read('src/renderer/src/design/tokens.css');
const occult = read('src/renderer/src/design/occult/occult-tokens.css');
const baseRoot = tokensOf(base, /:root\s*{([\s\S]*?)\n}/);
const occultRoot = tokensOf(occult, /:root\[data-cth-theme='occult'\]\s*{([\s\S]*?)\n}/);

test('occult redefines every base token', () => {
  const missing = [...baseRoot].filter((t) => !occultRoot.has(t));
  assert.deepEqual(missing, [], 'tokens the occult theme forgot');
});

test('occult invents no token the base does not declare', () => {
  // A token only the occult block knows about is a token light/dark resolve to
  // nothing — the fallback path is silently broken until someone opens that
  // screen in the wrong theme.
  const stray = [...occultRoot].filter((t) => !baseRoot.has(t));
  assert.deepEqual(stray, [], 'tokens missing an inert base default');
});

test('new families have inert base defaults', () => {
  for (const t of ['--cth-radius-panel', '--cth-radius-control', '--cth-radius-badge',
    '--cth-hairline', '--cth-gilt', '--cth-gilt-soft',
    '--cth-dur-slow', '--cth-dur-drift', '--cth-ease-glide']) {
    assert.ok(baseRoot.has(t), `${t} missing from base :root`);
  }
  assert.match(base, /--cth-radius-panel:\s*0px/);
  assert.match(base, /--cth-radius-control:\s*0px/);
  assert.match(base, /--cth-radius-badge:\s*0px/);
});

test('the light and dark blocks are untouched by the occult work', () => {
  // The regression contract: light and dark must render byte-identically. The
  // new families are additive, so the only legal edit to this file is an
  // append to the base :root — never a change to an existing value, never a
  // line in the dark block.
  const dark = tokensOf(base, /:root\[data-cth-theme='dark'\]\s*{([\s\S]*?)\n}/);
  assert.equal(dark.size, 34, 'the dark block gained or lost a token');
  assert.match(base, /--cth-ink-300:\s*#787684/);
  assert.match(base, /--cth-status-ghost:\s*#6C6A76/);
  assert.match(base, /--cth-cream-50:\s*#FFFDF5/);
  assert.match(base, /--cth-ink-300:\s*#A899B5/);
  assert.match(base, /--cth-shadow-hard:\s*3px 3px 0 rgba\(26, 19, 32, 0\.14\)/);
  assert.match(base, /--cth-panel-border:\s*inset 0 0 0 1px var\(--cth-ink-300\)/);
});

test('global.css imports the occult tokens', () => {
  assert.match(read('src/renderer/src/design/global.css'),
    /@import '\.\/occult\/occult-tokens\.css';/);
});
