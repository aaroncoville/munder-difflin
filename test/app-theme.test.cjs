'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

// theme.ts reads window.localStorage and stamps <html> at module load, so each
// case needs a fresh module instance over a fresh fake DOM.
function freshTheme(stored) {
  const store = new Map(stored === undefined ? [] : [['cth.theme', stored]]);
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v)
    }
  };
  global.document = { documentElement: { dataset: {} } };
  return { mod: loadTs.fresh('src/renderer/src/design/theme.ts'), store };
}

test('occult is a legal persisted theme', () => {
  const { mod } = freshTheme('occult');
  assert.equal(mod.appTheme(), 'occult');
  assert.equal(global.document.documentElement.dataset.cthTheme, 'occult');
});

test('the toggle cycles light -> dark -> occult -> light', () => {
  const { mod, store } = freshTheme('light');
  assert.equal(mod.toggleAppTheme(), 'dark');
  assert.equal(mod.toggleAppTheme(), 'occult');
  assert.equal(store.get('cth.theme'), 'occult');
  assert.equal(mod.toggleAppTheme(), 'light');
});

test('an unknown stored value still falls back to light', () => {
  const { mod } = freshTheme('cerulean');
  assert.equal(mod.appTheme(), 'light');
});

test('terminals collapse occult to dark', () => {
  const { mod } = freshTheme('occult');
  assert.equal(mod.terminalThemeFor('occult'), 'dark');
  assert.equal(mod.terminalThemeFor('dark'), 'dark');
  assert.equal(mod.terminalThemeFor('light'), 'light');
});

// --- the one control's face --------------------------------------------------
//
// The ring gained a third stop, but both theme buttons kept a binary
// light/dark presentation: in occult they showed a moon and said "dark theme"
// while a click went to light, and in dark they said "light theme" while a
// click went to occult. The control now reads its icon and its wording from a
// single mapping keyed by where the ring stands, so there is one place to be
// wrong and three states that a test can pin.

const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const locale = (code) => JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));
/** Source with comments removed — naming an API must not read as calling it. */
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
/** `a.b.c` lookup into a locale tree. */
const at = (tree, key) => key.split('.').reduce((n, k) => (n == null ? n : n[k]), tree);

const THEMES = ['light', 'dark', 'occult'];

test('the face names the theme a click actually moves to', () => {
  // Not compared against a copy of the cycle: each case runs the real toggle
  // from that state, so the mapping cannot drift away from the ring.
  for (const from of THEMES) {
    const { mod } = freshTheme(from);
    const face = mod.themeControlFace(from);
    assert.equal(face.next, mod.toggleAppTheme(), `face for ${from} disagrees with the toggle`);
  }
});

test('each state gets its own icon and its own wording', () => {
  const { mod } = freshTheme('light');
  const faces = THEMES.map((t) => mod.themeControlFace(t));
  assert.equal(new Set(faces.map((f) => f.icon)).size, 3, 'two states share an icon');
  assert.equal(new Set(faces.map((f) => f.label)).size, 3, 'two states share a label');
  assert.equal(new Set(faces.map((f) => f.labelKey)).size, 3, 'two states share a key');
  for (const f of faces) {
    // The property that broke: the wording must name the DESTINATION.
    assert.match(f.label.toLowerCase(), new RegExp(`\\b${f.next}\\b`),
      `"${f.label}" does not name ${f.next}`);
    for (const other of THEMES.filter((t) => t !== f.next)) {
      assert.doesNotMatch(f.label.toLowerCase(), new RegExp(`\\b${other}\\b`),
        `"${f.label}" names ${other}, which is not where it goes`);
    }
  }
});

test('every face is translated in all three locales', () => {
  const { mod } = freshTheme('light');
  for (const code of ['en', 'zh-CN', 'ar']) {
    const tree = locale(code);
    for (const from of THEMES) {
      const { labelKey } = mod.themeControlFace(from);
      const value = at(tree, labelKey);
      assert.equal(typeof value, 'string', `${code} is missing ${labelKey}`);
      assert.ok(value.trim().length > 0, `${code}:${labelKey} is empty`);
    }
  }
});

test('the untranslated title bar and the English locale say the same thing', () => {
  // App.tsx is not wired to i18n, so it renders `face.label` directly while the
  // fullscreen mirror renders `t(face.labelKey)`. If those two drift, one of
  // the two controls starts lying again — in English, where nobody is looking.
  const { mod } = freshTheme('light');
  const en = locale('en');
  for (const from of THEMES) {
    const face = mod.themeControlFace(from);
    assert.equal(at(en, face.labelKey), face.label, `en:${face.labelKey} drifted from face.label`);
  }
});

test('both controls read the mapping and hold no theme glyph of their own', () => {
  const { mod } = freshTheme('light');
  const icons = THEMES.map((t) => mod.themeControlFace(t).icon);
  for (const file of ['src/renderer/src/App.tsx',
    'src/renderer/src/components/FullscreenTerminal.tsx']) {
    const code = strip(read(file));
    assert.match(code, /themeControlFace\(/, `${file} does not call the mapping`);
    for (const icon of icons) {
      assert.ok(!code.includes(icon), `${file} hardcodes the ${icon} glyph`);
    }
    // The binary test that caused the finding, in either direction.
    assert.doesNotMatch(code, /appThemeNow\s*===\s*'(dark|light|occult)'\s*\?/,
      `${file} still branches on one theme`);
    assert.ok(!code.includes('Toggle dark mode'), `${file} still says "Toggle dark mode"`);
  }
});
