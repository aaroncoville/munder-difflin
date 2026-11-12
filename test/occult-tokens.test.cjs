'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const readRaw = (p) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
/**
 * Stylesheets, with comments removed. These files explain their palettes at
 * length and name tokens while doing it, so a comment can satisfy an assertion
 * about what the CSS declares — including a commented-out @import, which would
 * leave the theme unloaded with this file green.
 */
const read = (p) => readRaw(p).replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations inside one CSS block, as written. */
const bodyOf = (css, blockRe) => {
  const m = css.match(blockRe);
  assert.ok(m, `block ${blockRe} not found`);
  return m[1];
};
/** Names of the custom properties declared inside one CSS block. */
const tokensOf = (css, blockRe) =>
  new Set([...bodyOf(css, blockRe).matchAll(/--cth-[\w-]+(?=\s*:)/g)].map((x) => x[0]));

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

test('no stylesheet still carries a theme block for light or dark', () => {
  // Sixth History is the only theme design/theme.ts can stamp, so a
  // `data-cth-theme` block for any other name is a palette nothing can select:
  // it costs a reader the time to work out that it is dead, and it is where
  // the next palette change would be wrongly made.
  const stamps = [base, occult, read('src/renderer/src/design/global.css')]
    .flatMap((css) => [...css.matchAll(/data-cth-theme='([\w-]+)'/g)].map((m) => m[1]));
  assert.deepEqual([...new Set(stamps)], ['occult']);
});

test('global.css imports the occult tokens', () => {
  assert.match(read('src/renderer/src/design/global.css'),
    /@import '\.\/occult\/occult-tokens\.css';/);
});

test('occult swaps the display face but keeps the CJK/Arabic fallback tail', () => {
  // Press Start 2P is latin-only, and so is Cormorant SC. Dropping the system
  // CJK/Arabic faces from the tail would leave a zh-CN or ar heading falling
  // through to generic monospace — the exact breakage self-hosting fixed.
  assert.match(occult, /--cth-font-display:\s*"Cormorant SC",[^;]*"Noto Naskh Arabic"/);
  assert.match(occult, /--cth-text-display-lg:\s*22px/);
  assert.match(occult, /--cth-text-display-md:\s*17px/);
  assert.match(occult, /--cth-text-display-sm:\s*12px/);
  assert.match(occult, /--cth-lh-display-lg:\s*26px/);
  assert.match(occult, /--cth-lh-display-sm:\s*16px/);
});

test('the display face is self-hosted, like every other face here', () => {
  const fonts = read('src/renderer/src/design/occult/occult-fonts.css');
  for (const weight of [400, 700]) {
    assert.match(fonts, new RegExp(
      `font-family:\\s*'Cormorant SC';[\\s\\S]*?url\\('\\.\\./\\.\\./assets/fonts/cormorant-sc-latin-${weight}\\.woff2'\\)`));
  }
  assert.match(read('src/renderer/src/design/global.css'),
    /@import '\.\/occult\/occult-fonts\.css';/);
});

test('the bundled-font licence notice covers the new face', () => {
  // OFL section 2: the notice travels with every copy. A font file added
  // without its attribution is a licence breach, not a docs omission.
  const notice = readRaw('src/renderer/src/assets/fonts/LICENSE.txt');
  assert.match(notice, /cormorant-sc-latin-400\.woff2/);
  assert.match(notice, /cormorant-sc-latin-700\.woff2/);
  assert.match(notice, /Cormorant/);
});

test('ReleaseDrop reads tokens instead of a private palette', () => {
  const src = read('src/renderer/src/components/ReleaseDrop.tsx');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const hexes = code.match(/#[0-9A-Fa-f]{6}\b/g) ?? [];
  assert.deepEqual(hexes, [], 'raw hex colours survive in ReleaseDrop');
  assert.match(code, /var\(--cth-drop-paper\)/);
  assert.match(code, /var\(--cth-drop-ink\)/);
});

test('the drop palette keeps its landing-site values outside occult', () => {
  // The drop is the landing site's window, restated in app chrome because the
  // sandboxed frame inside it cannot reach a stylesheet. Light and dark must
  // therefore resolve to exactly the hexes the frame hardcodes.
  for (const [token, hex] of [
    ['--cth-drop-paper', '#FFFDF7'], ['--cth-drop-ink', '#1B1B1B'],
    ['--cth-drop-ink-faint', '#8A867A'], ['--cth-drop-yellow', '#FFCA54'],
    ['--cth-drop-sky', '#72C2DF'], ['--cth-drop-maroon', '#B23A4E']
  ]) {
    assert.match(base, new RegExp(`${token}:\\s*${hex}`), `${token} drifted from the landing palette`);
  }
  // …and the frame's own copy still agrees, or the seam between chrome and
  // page reopens.
  const frame = read('src/shared/releaseDrop.ts');
  assert.match(frame, /--paper:\s*#FFFDF7/);
  assert.match(frame, /--ink:\s*#1B1B1B/);
});

test('occult replaces the I-beam cursor and gives selection a ground', () => {
  // The mouse I-beam is an OS cursor, which `color-scheme` cannot reach — the
  // reason global.css draws its own. That one wears a cream halo sized for a
  // cream input; on a night ground it is the halo that disappears.
  const rule = occult.match(
    /:root\[data-cth-theme='occult'\] input[^{]*{([\s\S]*?)\n}/);
  assert.ok(rule, 'no occult cursor rule');
  assert.match(rule[1], /cursor:\s*url\("data:image\/svg\+xml/);
  assert.doesNotMatch(rule[1], /%23fdf6e3/i, 'still wearing the cream halo');
  assert.match(occult, /:root\[data-cth-theme='occult'\]\s*::selection\s*{[\s\S]*?background:/);
});
