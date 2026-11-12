'use strict';
// The multi-model review panel (spec 7.1 to 7.3). For each sha the conductor asks one
// reviewer per vendor, and decides once every one of them has answered:
//   1. any BLOCK blocks; a CONFIRMED from the other vendor never outvotes it;
//   2. else CONFIRMED from at least minVendors distinct vendors confirms;
//   3. else the review is degraded. In the steel thread both 1 and 3 hold the card.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { choosePanel, combine, vendorOf } = loadTs('src/main/pipeline/panel.ts');

const PANEL = { anthropic: ['orsolina'], openai: ['jannings', 'tryphon'] };
const agent = (name, provider, over = {}) => ({ id: `${name}-mtx`, name, provider, archived: false, ...over });
const ROSTER = [agent('orsolina', 'claude'), agent('jannings', 'codex'), agent('tryphon', 'codex'), agent('mireya', 'claude')];

test('a vendor is the provider\'s company', () => {
  assert.equal(vendorOf('claude'), 'anthropic');
  assert.equal(vendorOf('codex'), 'openai');
  assert.equal(vendorOf('qwen'), null);
});

test('the panel is the first live reviewer of each vendor, in the configured order', () => {
  assert.deepEqual(choosePanel(PANEL, ROSTER), {
    reviewers: [{ vendor: 'anthropic', reviewer: 'orsolina-mtx' }, { vendor: 'openai', reviewer: 'jannings-mtx' }],
    missing: [],
  });
});

test('an archived or absent first choice gives way to the next of that vendor', () => {
  const roster = [agent('orsolina', 'claude'), agent('jannings', 'codex', { archived: true }), agent('tryphon', 'codex')];
  assert.deepEqual(choosePanel(PANEL, roster).reviewers.map((r) => r.reviewer), ['orsolina-mtx', 'tryphon-mtx']);
  assert.deepEqual(choosePanel(PANEL, [agent('orsolina', 'claude'), agent('tryphon', 'codex')]).reviewers.map((r) => r.reviewer), ['orsolina-mtx', 'tryphon-mtx']);
});

test('a vendor with nobody live is reported missing, not filled from another vendor', () => {
  const r = choosePanel(PANEL, [agent('orsolina', 'claude'), agent('mireya', 'claude')]);
  assert.deepEqual(r.reviewers.map((x) => x.reviewer), ['orsolina-mtx']);
  assert.deepEqual(r.missing, ['openai']);
});

test('a configured name is only taken by an agent of that vendor: a Claude agent named like a Codex reviewer is not', () => {
  const r = choosePanel(PANEL, [agent('orsolina', 'claude'), agent('jannings', 'claude')]);
  assert.deepEqual(r.missing, ['openai']);
});

const A = (verdict) => ({ vendor: 'anthropic', state: verdict });
const O = (verdict) => ({ vendor: 'openai', state: verdict });

// [description, reviewers' terminal states (null = not yet terminal), expected outcome] — spec 7.3, in its order.
const COMBINING = [
  ['both confirm', [A('CONFIRMED'), O('CONFIRMED')], 'confirm'],
  ['one blocks, the other confirms: the confirmation never outvotes a block', [A('CONFIRMED'), O('BLOCK')], 'block'],
  ['the Claude side blocks, Codex confirms', [A('BLOCK'), O('CONFIRMED')], 'block'],
  ['both block', [A('BLOCK'), O('BLOCK')], 'block'],
  ['a block beside an abstention still blocks', [A('BLOCK'), O('ABSTAIN')], 'block'],
  ['one confirms, one abstains', [A('CONFIRMED'), O('ABSTAIN')], 'degraded'],
  ['one confirms, one is unavailable', [A('CONFIRMED'), O('UNAVAILABLE')], 'degraded'],
  ['one confirms, one drifted to a disallowed model', [A('CONFIRMED'), O('DRIFTED')], 'degraded'],
  ['both abstain', [A('ABSTAIN'), O('ABSTAIN')], 'degraded'],
  ['only one vendor was asked, and confirmed', [A('CONFIRMED')], 'degraded'],
  ['two confirmations from the same vendor are one vendor', [A('CONFIRMED'), A('CONFIRMED')], 'degraded'],
  ['one has not answered yet: nothing is decided, even with a block in', [A('BLOCK'), O(null)], 'pending'],
  ['nobody has answered', [A(null), O(null)], 'pending'],
  ['no reviewer at all', [], 'degraded'],
];

for (const [what, reviewers, expected] of COMBINING) {
  test(`combining: ${what} → ${expected}`, () => {
    assert.equal(combine(reviewers, 2), expected);
  });
}

test('minVendors is a floor of two whatever it is called with', () => {
  assert.equal(combine([A('CONFIRMED')], 1), 'degraded');
  assert.equal(combine([A('CONFIRMED'), O('CONFIRMED')], 3), 'degraded');
});
