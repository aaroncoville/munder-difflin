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
