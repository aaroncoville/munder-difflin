'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mount, text, flatten } = require('./render-hooks.cjs');
const loadTs = require('./load-ts.cjs');

function creditUnder(theme) {
  global.window = { localStorage: { getItem: () => theme, setItem: () => {} } };
  global.document = { documentElement: { dataset: {} } };
  loadTs.fresh('src/renderer/src/design/theme.ts');
  const { SixthHistoryCredit } = loadTs.fresh('src/renderer/src/components/SixthHistoryCredit.tsx');
  return mount(SixthHistoryCredit, {});
}

test('the credit carries the licence wording and the logo under occult', () => {
  const inst = creditUnder('occult');
  const rendered = text(inst.tree).join(' ');
  assert.match(rendered, /unofficial content/i);
  assert.match(rendered, /Weather Factory Ltd/);
  assert.match(rendered, /weatherfactory\.biz/);
  // The src has to be the URL itself, not something that merely CONTAINS it:
  // a default import that resolves to a module object stringifies past a
  // looser assertion and renders as "[object Object]".
  const img = flatten(inst.tree).find((n) => n.node.type === 'img');
  assert.ok(img, 'no logo element');
  assert.equal(typeof img.node.props.src, 'string');
  assert.match(img.node.props.src, /sixth-history\/logo\.png$/);
});

test('the credit is absent in every other theme', () => {
  // Not cosmetic: it is the theme that triggers the licence obligation, so the
  // two have to be inseparable in both directions.
  for (const theme of ['light', 'dark']) {
    assert.equal(creditUnder(theme).tree, null, `credit rendered under ${theme}`);
  }
});

test('the licensed logo actually ships', () => {
  const logo = path.resolve(__dirname, '..', 'src/renderer/src/assets/sixth-history/logo.png');
  assert.ok(fs.existsSync(logo), 'logo.png missing');
  // A PNG, and big enough to be the real mark rather than a placeholder stub.
  assert.equal(fs.readFileSync(logo).subarray(1, 4).toString('latin1'), 'PNG');
  assert.ok(fs.statSync(logo).size > 4096, 'logo.png looks like a placeholder');
});

test('the credit is mounted where a user will see it', () => {
  // A component nothing renders discharges no obligation.
  const modal = fs.readFileSync(
    path.resolve(__dirname, '..', 'src/renderer/src/components/SettingsModal.tsx'), 'utf8');
  assert.match(modal, /import \{ SixthHistoryCredit \}/);
  assert.match(modal, /<SixthHistoryCredit \/>/);
});

test('the obligations are written down beside the asset', () => {
  const doc = fs.readFileSync(path.resolve(__dirname, '..',
    'src/renderer/src/assets/sixth-history/ATTRIBUTION-SIXTH-HISTORY.md'), 'utf8');
  assert.match(doc, /sixth-history-community-licence/);
  assert.match(doc, /50,000/);
});
