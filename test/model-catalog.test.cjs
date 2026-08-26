'use strict';

/**
 * The raw→typed seam of the live model catalog.
 *
 * Everything downstream of this function (the adapter, the IPC, the picker)
 * decides what to show by asking whether the parse produced anything. So the
 * properties that matter are pinned here: a real `model/list` payload maps to
 * picker options with the provider's own default identified, and ANY payload
 * that yields no usable model returns null — the signal to keep the built-in
 * list rather than render an empty picker.
 *
 * The fixtures below are trimmed from an actual `codex app-server` model/list
 * response (codex-cli 0.149.1), extra fields and all, because the payload's
 * envelope (`data`, not `models`) and its default flag (`isDefault`, not
 * `default`) are the two things a hand-written fixture is most likely to get
 * wrong — and getting them wrong yields a parser that returns null forever
 * while every test stays green.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseCodexModelList } = loadTs('src/shared/modelCatalog.ts');

/** One entry as codex actually sends it, trimmed to the fields we read plus a
 *  couple we must ignore. */
const entry = (over) => ({
  id: 'gpt-5.5',
  model: 'gpt-5.5',
  displayName: 'GPT-5.5',
  description: 'Balanced agentic coding model for everyday work.',
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
  isDefault: false,
  ...over
});

test('parses a model/list result into options plus the marked default', () => {
  const raw = {
    data: [
      entry({ id: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol', isDefault: true }),
      entry({ id: 'gpt-5.6-terra', displayName: 'GPT-5.6-Terra' }),
      entry({ id: 'gpt-5.6-luna', displayName: undefined })
    ],
    nextCursor: null
  };
  const out = parseCodexModelList(raw);
  assert.deepEqual(out.models, [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
    // No display name: the id is the only honest label — never a blank chip.
    { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' }
  ]);
  assert.equal(out.default, 'gpt-5.6-sol', 'the entry flagged isDefault must be reported as the default');
});

test('a payload with no flagged default reports no default', () => {
  const out = parseCodexModelList({ data: [entry({})] });
  assert.deepEqual(out.models, [{ id: 'gpt-5.5', label: 'GPT-5.5' }]);
  assert.equal(out.default, undefined, 'nothing may be invented as the default');
});

test('models the provider marks hidden are not offered', () => {
  const out = parseCodexModelList({
    data: [entry({ id: 'gpt-5.4-internal', hidden: true }), entry({ id: 'gpt-5.4' })]
  });
  assert.deepEqual(out.models, [{ id: 'gpt-5.4', label: 'GPT-5.5' }]);
});

test('entries without a usable id are dropped, not rendered blank', () => {
  const out = parseCodexModelList({ data: [{ id: '' }, { noId: 1 }, entry({ id: 'gpt-5.4' })] });
  assert.deepEqual(out.models, [{ id: 'gpt-5.4', label: 'GPT-5.5' }]);
});

test('returns null for a malformed or empty payload', () => {
  assert.equal(parseCodexModelList(null), null);
  assert.equal(parseCodexModelList(undefined), null);
  assert.equal(parseCodexModelList({}), null);
  assert.equal(parseCodexModelList({ data: 'nope' }), null);
  assert.equal(parseCodexModelList({ data: [] }), null);
  assert.equal(parseCodexModelList({ data: [{ noId: 1 }] }), null);
  assert.equal(parseCodexModelList({ data: [entry({ hidden: true })] }), null);
  // The envelope codex does NOT use. Accepting it would mean the parser is
  // guessing, and a guess that happens to be wrong reads as a live list.
  assert.equal(parseCodexModelList({ models: [{ id: 'gpt-5.5' }] }), null);
});
