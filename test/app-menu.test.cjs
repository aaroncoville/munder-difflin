'use strict';

// Electron's default menu names the macOS app menu from app.name, which stays
// the package name on purpose. The app therefore installs its own menu, with the
// displayed name spelled out, in both window modes.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const root = path.join(__dirname, '..');
const code = (p) => fs.readFileSync(path.join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const { appMenuTemplate } = loadTs('src/main/appMenu.ts');
const { PRODUCT_NAME } = loadTs('src/shared/productName.ts');
const NEW_FLOOR = { label: 'New Floor', accelerator: 'CmdOrCtrl+Shift+N' };

for (const multiWindow of [true, false]) {
  test(`the macOS app menu carries the displayed name with multiWindow ${multiWindow}`, () => {
    const menu = appMenuTemplate(true, multiWindow ? NEW_FLOOR : null);
    assert.equal(menu[0].label, PRODUCT_NAME);
    const labels = Object.fromEntries(menu[0].submenu.filter((i) => i.role).map((i) => [i.role, i.label]));
    assert.equal(labels.about, `About ${PRODUCT_NAME}`);
    assert.equal(labels.hide, `Hide ${PRODUCT_NAME}`);
    assert.equal(labels.quit, `Quit ${PRODUCT_NAME}`);
    const file = menu.find((m) => m.label === 'File').submenu;
    assert.equal(file.includes(NEW_FLOOR), multiWindow);
    assert.deepEqual(file[file.length - 1], { role: 'close' });
  });
}

test('other platforms get no app menu and quit from File', () => {
  const menu = appMenuTemplate(false, null);
  assert.equal(menu[0].label, 'File');
  assert.deepEqual(menu[0].submenu, [{ role: 'quit' }]);
});

test('the menu is installed whatever multiWindow says', () => {
  const index = code('src/main/index.ts');
  assert.match(index, /^  installAppMenu\(\);$/m);
  assert.doesNotMatch(index, /if \(readConfig\(\)\.multiWindow\) installAppMenu\(\)/);
  assert.match(index, /appMenuTemplate\(process\.platform === 'darwin', readConfig\(\)\.multiWindow \? newFloorItem : null\)/);
});
