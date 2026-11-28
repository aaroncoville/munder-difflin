'use strict';

// The weekly digest counts each canary's results three ways: passed, failed, and not judged (ok null: the feature was
// off, or the machine slept during the probe). A row not judged is neither a pass nor a failure, and "All passed"
// appears only when nothing failed and everything was judged.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const D = loadTs('src/core/usageDigest.ts');
const MON = Date.parse('2026-11-02T00:00:00Z');
const H = 3600_000;

function digest(rows) {
  const log = rows.map((r, k) => JSON.stringify({ ts: MON + (k + 1) * H, kind: 'canary', ...r }));
  const s = D.summarize({ log, ledger: [], usage: [], cards: new Set(), start: MON, end: MON + 7 * 86400_000 });
  return { s, md: D.renderDigest(s, '2026-W45') };
}

test('a week of only unjudged rows does not say All passed', () => {
  const { s, md } = digest([{ feature: 'memory-search', ok: null, detail: 'host-slept' }]);
  assert.doesNotMatch(md, /All passed/);
  assert.match(md, /\*\*memory-search\*\*: 0 passed, 1 not judged \(host-slept\)/);
  assert.deepEqual(s.canaryCounts['memory-search'], { passed: 0, failed: 0, notJudged: 1, details: [], notJudgedDetails: ['host-slept'] });
});

test('mixed results render all three counts, and an unjudged row does not dilute the failures', () => {
  const { md } = digest([
    { feature: 'memory-search', ok: true }, { feature: 'memory-search', ok: true }, { feature: 'memory-search', ok: true },
    { feature: 'memory-search', ok: false, detail: 'timeout' }, { feature: 'memory-search', ok: null, detail: 'host-slept' },
    { feature: 'kg-search', ok: true },
  ]);
  assert.match(md, /\*\*memory-search\*\*: 3 passed, 1 failed \(timeout\), 1 not judged \(host-slept\)/);
  assert.match(md, /\*\*kg-search\*\*: 1 passed/);
  assert.doesNotMatch(md, /All passed/);
});

test('All passed when every row passed', () => {
  const { md } = digest([{ feature: 'memory-search', ok: true }, { feature: 'kg-search', ok: true }]);
  assert.match(md, /All passed \(kg-search, memory-search\)\./);
});

test('a feature that is off is not judged either, so it no longer reads as passed', () => {
  const { md } = digest([{ feature: 'kg-search', ok: null, detail: 'off' }]);
  assert.match(md, /\*\*kg-search\*\*: 0 passed, 1 not judged \(off\)/);
});
