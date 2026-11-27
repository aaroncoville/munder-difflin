'use strict';

// The process table read with each process's group (pid, parent pid, group id, command line), for the headless
// sweep to tell whether a run's process group is still the run's.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parsePsGroupOutput, probeProcessGroups } = loadTs('src/core/processGroups.ts');

test('the reader takes pid, parent pid, group id and the full command line, and skips what it cannot read', () => {
  assert.deepEqual(parsePsGroupOutput('  10     1    10 /bin/zsh -c npm test\n 11 10 10 npm test \n 12 10 garbage\n\n'), [
    { pid: 10, parentPid: 1, pgid: 10, commandLine: '/bin/zsh -c npm test' },
    { pid: 11, parentPid: 10, pgid: 10, commandLine: 'npm test' },
  ]);
});

test('the real table (needs ps) shows this process in its own group', async (t) => {
  let rows;
  try { rows = await probeProcessGroups(); } catch (e) { t.skip(`ps cannot run here: ${e.message}`); return; }
  const me = rows.find((r) => r.pid === process.pid);
  assert.ok(me, 'this process is listed');
  assert.ok(Number.isInteger(me.pgid) && me.pgid > 0, JSON.stringify(me));
});
