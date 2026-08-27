'use strict';
/**
 * The gilt redraw of the icon set.
 *
 * The whole risk in a "redraw" task is a redraw that did not happen: a table
 * that copied the originals, or one missing a name so that a button renders as
 * a blank square in one theme only. Both are checked here against `Icon.tsx`'s
 * own union rather than against a list restated in this file, because a list
 * restated here would go stale the moment a name is added and would then pass
 * while the app rendered a hole.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const at = (p) => path.resolve(__dirname, '..', p);
const read = (p) => fs.readFileSync(at(p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const iconSrc = read('src/renderer/src/components/Icon.tsx');

/** Every name in `IconName`, read out of the type itself. */
const ICON_NAMES = (() => {
  const union = iconSrc.match(/export type IconName\s*=\s*([\s\S]*?);/)[1];
  return [...union.matchAll(/'([^']+)'/g)].map((m) => m[1]);
})();

const { DECO_PATHS } = loadTs('src/renderer/src/components/decoIcons.ts');

test('the union is worth deriving from', () => {
  assert.ok(ICON_NAMES.length >= 20, `only found ${ICON_NAMES.length} icon names`);
});

test('every icon has a deco counterpart', () => {
  const missing = ICON_NAMES.filter((n) => !DECO_PATHS[n]);
  assert.deepEqual(missing, [], 'icons that would render blank under the occult theme');
  const stray = Object.keys(DECO_PATHS).filter((n) => !ICON_NAMES.includes(n));
  assert.deepEqual(stray, [], 'deco paths for icons that do not exist');
});

test('every deco path is a path', () => {
  for (const name of ICON_NAMES) {
    const def = DECO_PATHS[name];
    assert.equal(typeof def.ink, 'string', `${name}.ink`);
    assert.match(def.ink, /^M/, `${name} does not start with a moveto`);
    // Only real SVG path commands. A stray letter is a silently-truncated path:
    // the browser renders up to the bad token and drops the rest.
    assert.doesNotMatch(def.ink, /[^MmLlHhVvCcSsQqTtAaZz0-9.,\-+eE\s]/,
      `${name} has a character no path command uses`);
    assert.ok(def.ink.length > 20, `${name} is too short to be a drawing`);
    assert.match(String(def.accentColor), /^var\(--cth-[\w-]+\)$/, `${name}.accentColor`);
    if (def.accent !== undefined) assert.match(def.accent, /^M/, `${name}.accent`);
  }
});

test('the redraw is a redraw, not a copy', () => {
  // The defect this task exists to avoid: a table that satisfies "every icon
  // has a deco counterpart" by pasting the pixel path in beside it.
  const pixel = (() => {
    const body = iconSrc.match(/const paths: Record<IconName, IconDef> = {([\s\S]*?)\n};/)[1];
    const out = {};
    for (const m of body.matchAll(/ink:\s*'([^']+)'/g)) out[m[1]] = true;
    return out;
  })();
  const copied = ICON_NAMES.filter((n) => pixel[DECO_PATHS[n].ink]);
  assert.deepEqual(copied, [], 'deco paths copied verbatim from the pixel set');
});

test('the deco set is curved, and the pixel set is not', () => {
  // The pixel grid's whole idiom is integer horizontal/vertical runs; the deco
  // idiom is the curve. A "deco" table with no curve command in it anywhere is
  // the pixel set with different numbers.
  const curved = ICON_NAMES.filter((n) => /[CcSsQqTtAa]/.test(DECO_PATHS[n].ink));
  assert.ok(curved.length >= ICON_NAMES.length * 0.7,
    `only ${curved.length} of ${ICON_NAMES.length} deco icons use a curve`);
});

test('Icon picks its table and its rendering by theme', () => {
  const src = strip(iconSrc);
  assert.match(src, /DECO_PATHS/, 'Icon.tsx never reads the deco table');
  assert.match(src, /useAppTheme|occult/, 'Icon.tsx never asks which theme it is in');
  // crispEdges is the pixel grid's own instruction — it snaps every edge to the
  // device pixel, which is precisely what turns a swept curve into a staircase.
  assert.doesNotMatch(src, /shapeRendering="crispEdges"/,
    'crispEdges is still applied unconditionally');
  assert.match(src, /crispEdges/, 'the pixel set lost its crisp rendering');
});
