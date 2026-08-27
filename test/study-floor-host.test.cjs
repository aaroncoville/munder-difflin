'use strict';

/**
 * The one place the Study meets the rest of the app: which floor gets mounted.
 *
 * OfficeFloor cannot be loaded in this harness — it pulls in Pixi and a handful
 * of Vite `?url` asset imports that only a bundler resolves — which is also
 * exactly why the host reaches it through React.lazy: under the occult theme
 * the pixel office's bundle is never fetched at all, and vice versa.
 *
 * So the react stub gets `lazy` and `Suspense` here (render-hooks.cjs seeds the
 * rest), with `lazy` recording the loader it was handed. That keeps the office
 * branch assertable without a bundler, while the occult branch is checked
 * against the REAL StudyScene reference.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
// MUST come before loadTs of any component — it seeds require.cache for react.
const { mount } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');
const fs = require('node:fs');
const path = require('node:path');

const React = require('react');
React.Suspense = Symbol.for('react.suspense');
React.lazy = (loader) => ({ $$typeof: Symbol.for('react.lazy'), loader });

const { StudyScene } = loadTs('src/renderer/src/scene/study/StudyScene.tsx');

/** Load the host and the theme module afresh, with the theme already chosen —
 *  theme.ts reads localStorage once, at module load. */
function hostFor(theme) {
  global.window = { localStorage: { getItem: () => theme, setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
  loadTs.fresh('src/renderer/src/design/theme.ts');
  return loadTs.fresh('src/renderer/src/scene/study/FloorHost.tsx');
}

/** Every theme in the shipped ring, walked from the module itself rather than
 *  written down here — a theme added later joins this test on its own. */
function allThemes() {
  const { themeControlFace } = hostFor('light') && loadTs('src/renderer/src/design/theme.ts');
  const seen = [];
  let t = 'light';
  while (!seen.includes(t)) { seen.push(t); t = themeControlFace(t).next; }
  return seen;
}

const find = (n, pred) => {
  if (!n || typeof n !== 'object') return undefined;
  if (pred(n)) return n;
  for (const k of [].concat(n.props?.children ?? [])) {
    const h = find(k, pred);
    if (h) return h;
  }
  return undefined;
};

test('the occult theme mounts the Study, every other theme the office', () => {
  const themes = allThemes();
  assert.ok(themes.length >= 3, `walked the ring: ${themes.join(', ')}`);
  for (const theme of themes) {
    const { floorForTheme } = hostFor(theme);
    assert.equal(floorForTheme(theme), theme === 'occult' ? 'study' : 'office',
      `${theme} floor`);
  }
});

test('under the occult theme the host really renders the Study', () => {
  const { FloorHost } = hostFor('occult');
  const inst = mount(FloorHost, {});
  assert.ok(find(inst.tree, (n) => n.type === StudyScene), 'the real StudyScene is mounted');
});

test('outside the occult theme the host renders the office, lazily', () => {
  for (const theme of ['light', 'dark']) {
    const { FloorHost, OfficeFloorLazy } = hostFor(theme);
    const inst = mount(FloorHost, {});
    assert.equal(find(inst.tree, (n) => n.type === StudyScene), undefined,
      `${theme}: the Study stays out of the pixel office`);
    const office = find(inst.tree, (n) => n.type === OfficeFloorLazy);
    assert.ok(office, `${theme}: the office is mounted`);
    // The loader the module actually built — read off the live function, not
    // grepped out of the file — has to point at the office floor.
    assert.match(String(OfficeFloorLazy.loader), /scene\/office\/OfficeFloor/,
      'the lazy chunk is the office floor');
    assert.ok(find(inst.tree, (n) => n.type === React.Suspense),
      `${theme}: a lazy floor is wrapped in Suspense, or React throws on first paint`);
  }
});

test('the office chunk is not pulled in just to decide against it', () => {
  // A static import would defeat the whole point: the occult theme would still
  // download Pixi and the tileset atlases to render a painting instead.
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/src/scene/study/FloorHost.tsx'), 'utf8');
  assert.doesNotMatch(src, /^import\s[^\n]*scene\/office\/OfficeFloor/m,
    'OfficeFloor must be reached through a dynamic import');
});

test('App mounts the host instead of the floor directly', () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/src/App.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /<OfficeFloor\b/, 'App still mounts the office floor directly');
  assert.doesNotMatch(src, /scene\/office\/OfficeFloor/, 'App still imports the office floor');
  assert.match(src, /<FloorHost\s*\/>/, 'App mounts the floor host');
});
