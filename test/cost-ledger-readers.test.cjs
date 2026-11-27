'use strict';

// Every reader of cost-ledger.jsonl skips a line that does not parse (a fragment a killed writer left): with such a
// line in the middle of the ledger, each reads the same as without it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const FRAGMENT = '{"agent_id":"god","session_id":"s","ts":17';

/** The ledger text, with the torn fragment as a line of its own after the first row when `torn` is set. */
const ledgerText = (rows, torn) => {
  const lines = rows.map((r) => JSON.stringify(r));
  if (torn) lines.splice(1, 0, FRAGMENT);
  return `${lines.join('\n')}\n`;
};

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-ledger-readers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('lifetime cost (costLifetime.ts) skips a torn line', async (t) => {
  const { CostLedgerTotals } = loadTs('src/core/costLifetime.ts');
  const rows = [{ agent_id: 'god', session_id: 's', usd: 1 }, { agent_id: 'god', session_id: 's', usd: 2.5 }, { agent_id: 'jc', session_id: 't', usd: 4 }];
  const read = async (torn) => {
    const file = path.join(tmp(t), 'cost-ledger.jsonl');
    fs.writeFileSync(file, ledgerText(rows, torn));
    const totals = new CostLedgerTotals();
    await totals.refreshFully(file);
    return [totals.usdFor('god'), totals.usdFor('jc')];
  };
  assert.deepEqual(await read(true), await read(false));
  assert.deepEqual(await read(true), [2.5, 4]);
});

test('the weekly usage digest (usageDigest.ts) skips a torn line', (t) => {
  const D = loadTs('src/core/usageDigest.ts');
  const MON = Date.UTC(2026, 10, 2);
  const H = 3600_000;
  const rows = [
    { agent_id: 'god', session_id: 's', ts: MON + H, usd: 1 },
    { agent_id: 'god', session_id: 's', ts: MON + 2 * H, usd: 3 },
  ];
  const digest = (torn) => {
    const root = tmp(t);
    const dir = path.join(tmp(t), 'usage');
    fs.writeFileSync(path.join(root, 'log.jsonl'), `${JSON.stringify({ ts: MON + H, kind: 'turn', agentId: 'god', startTs: MON + H, durationMs: 60_000, trigger: 'mail' })}\n`);
    fs.writeFileSync(path.join(root, 'cost-ledger.jsonl'), ledgerText(rows, torn));
    const file = D.writeWeeklyDigest(root, dir, MON + 7 * 86400_000 + 2 * H);
    return fs.readFileSync(file, 'utf8');
  };
  assert.equal(digest(true), digest(false));
});

test('the model canary (canaries.ts) skips a torn line', (t) => {
  const C = loadTs('src/main/canaries.ts');
  const MIN = 60_000;
  const launches = new Map([['rev', { model: 'claude-fable-5-1', ts: 0 }]]);
  const rows = [
    { agent_id: 'rev', ts: 1 * MIN, model: 'claude-fable-5-1' },
    { agent_id: 'rev', ts: 2 * MIN, model: 'claude-opus-4-8' },
    { agent_id: 'rev', ts: 20 * MIN, model: 'claude-opus-4-8' },
  ];
  const check = (torn) => {
    const file = path.join(tmp(t), 'cost-ledger.jsonl');
    fs.writeFileSync(file, ledgerText(rows, torn));
    return C.checkModels(launches, C.tailLines(file));
  };
  assert.deepEqual(check(true), check(false));
  assert.deepEqual(check(true), { checked: 1, mismatched: ['rev'] });
});
