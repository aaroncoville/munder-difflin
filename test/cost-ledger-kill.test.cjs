'use strict';

// What a process killed part-way through a cost-ledger append leaves, and what the next append makes of it. The
// contract: each row is appended at most once, never twice; a kill may lose rows and may leave one torn fragment;
// the next locked append puts its rows on lines of their own, so the fragment stands alone on its line and no later
// row is damaged; every reader skips a line that does not parse. An append is all or none only for a write error,
// which it undoes; a kill runs no undo.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { appendCostLedgerRows } = loadTs('src/core/costLedgerFile.ts');

const row = (n) => ({ agent_id: `a${n}`, session_id: `s${n}`, ts: n, usd: n });

test('a writer killed after a short write leaves one torn fragment, which the next append leaves alone on its line', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'md-cost-kill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = path.join(root, 'cost-ledger.jsonl');
  fs.writeFileSync(ledger, `${JSON.stringify(row(0))}\n`);
  // The child appends rows 1-3 in one batch; its first write takes 60% of the bytes (a legal short write), and
  // the process is killed before that write returns.
  const child = spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const { appendCostLedgerRows } = require('./test/load-ts.cjs')('src/core/costLedgerFile.ts');
    const row = (n) => ({ agent_id: 'a' + n, session_id: 's' + n, ts: n, usd: n });
    const writeSync = (fd, buf, off, len) => {
      fs.writeSync(fd, buf, off, Math.floor(len * 0.6));
      process.kill(process.pid, 'SIGKILL');
    };
    appendCostLedgerRows(process.argv[1], [row(1), row(2), row(3)], 'test rows', { writeSync });`, root], { cwd: path.join(__dirname, '..') });
  assert.equal(child.signal, 'SIGKILL', String(child.stderr));
  assert.ok(fs.existsSync(`${ledger}.lock`), 'the killed writer left its lock behind');

  // The next writer: the killed holder's lock is broken (its process is gone), and its rows go on fresh lines.
  appendCostLedgerRows(root, [row(4), row(5)], 'test rows');
  const lines = fs.readFileSync(ledger, 'utf8').split('\n');
  assert.equal(lines.pop(), '', 'the ledger ends with a newline');
  const parsed = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  const torn = parsed.filter((r) => r === null);
  assert.equal(torn.length, 1, `one torn fragment: ${JSON.stringify(lines)}`);
  const ids = parsed.filter(Boolean).map((r) => r.agent_id);
  assert.equal(new Set(ids).size, ids.length, `no row appears twice: ${ids}`);
  assert.deepEqual(ids.slice(0, 1), ['a0'], 'the row before is intact');
  assert.deepEqual(ids.slice(-2), ['a4', 'a5'], 'the rows after are intact, each on its own line');
  const fragment = lines[parsed.indexOf(null)];
  assert.ok(!fragment.includes('"a4"') && !fragment.includes('"a5"'), 'no later row was joined to the fragment');
});
