'use strict';

/**
 * A worker that launched a long job (a test suite in the background) and is
 * waiting on it produces no terminal output, yet is not idle. The idle reaper
 * must leave it alone while such a job is alive, and its idle clock restarts
 * when the job exits.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

const { parseProcessTable, hasLaunchedJob, shouldReapIdle } = loadTs('src/main/workerIdleJobs.ts');

const MIN = 60_000;
const LIMIT = 20 * MIN;

// Worker CLI (pid 100, session leader, pgid 100) with an MCP server in its own
// group and a tool shell that put itself in a new group running a test suite.
const PS_WITH_JOB = [
  '    1     0     1',
  '  100     1   100',
  '  101   100   100', // MCP server: shares the worker's group
  '  102   101   102', // a helper the MCP server started in a session of its own
  '  200   100   200', // tool shell: its own group
  '  201   200   200', // the test suite it launched
  '  900     1   900'  // unrelated process elsewhere on the machine
].join('\n');
const PS_NO_JOB = PS_WITH_JOB.split('\n').filter((l) => !/^\s*20[01]\s/.test(l)).join('\n');

test('a descendant in its own process group is a launched job', () => {
  assert.equal(hasLaunchedJob(100, parseProcessTable(PS_WITH_JOB)), true);
});

test('descendants sharing the worker group (MCP servers) are not jobs', () => {
  assert.equal(hasLaunchedJob(100, parseProcessTable(PS_NO_JOB)), false);
});

test('a helper in its own group below an MCP server is not a job', () => {
  // Some MCP servers start a child that calls setsid (a browser, a node
  // worker). It is the server's, not something the worker launched.
  const rows = parseProcessTable('  100 1 100\n  101 100 100\n  102 101 102\n  103 102 102');
  assert.equal(hasLaunchedJob(100, rows), false);
});

test('a process in another group that is not a descendant is ignored', () => {
  assert.equal(hasLaunchedJob(100, parseProcessTable('  100 1 100\n  900 1 900\n  901 900 901')), false);
});

test('a worker with a live job is not reaped at the limit', () => {
  const rec = {};
  const reap = shouldReapIdle(rec, { ptyIdleMs: LIMIT + 1, limitMs: LIMIT, now: 50 * MIN, hasLiveJob: () => true });
  assert.equal(reap, false);
});

test('the same worker with no job is reaped at the limit', () => {
  const rec = {};
  const reap = shouldReapIdle(rec, { ptyIdleMs: LIMIT + 1, limitMs: LIMIT, now: 50 * MIN, hasLiveJob: () => false });
  assert.equal(reap, true);
});

test('the idle clock restarts when the job exits', () => {
  const rec = {};
  // Job seen alive at minute 30; the terminal has been silent since minute 0.
  assert.equal(shouldReapIdle(rec, { ptyIdleMs: 30 * MIN, limitMs: LIMIT, now: 30 * MIN, hasLiveJob: () => true }), false);
  // The job has exited. Fifteen minutes after it was last seen: not yet idle.
  assert.equal(shouldReapIdle(rec, { ptyIdleMs: 45 * MIN, limitMs: LIMIT, now: 45 * MIN, hasLiveJob: () => false }), false);
  // Past the limit measured from the job's exit: reaped.
  assert.equal(shouldReapIdle(rec, { ptyIdleMs: 51 * MIN, limitMs: LIMIT, now: 51 * MIN, hasLiveJob: () => false }), true);
});

test('the process table is only consulted once the terminal is past the limit', () => {
  let probed = 0;
  const reap = shouldReapIdle({}, { ptyIdleMs: 5 * MIN, limitMs: LIMIT, now: 5 * MIN, hasLiveJob: () => { probed++; return true; } });
  assert.equal(reap, false);
  assert.equal(probed, 0);
});

test('a worker silent past the ceiling is reaped even with a live job', () => {
  const rec = {};
  const o = { limitMs: LIMIT, ceilingMs: 3 * LIMIT, hasLiveJob: () => true };
  // Under the ceiling the job keeps it alive...
  assert.equal(shouldReapIdle(rec, { ...o, ptyIdleMs: 3 * LIMIT, now: 3 * LIMIT }), false);
  // ...past it, terminal silence alone decides, however fresh the job is.
  assert.equal(shouldReapIdle(rec, { ...o, ptyIdleMs: 3 * LIMIT + 1, now: 3 * LIMIT + 1 }), true);
});

test('a zombie tool shell is not a live job', () => {
  // A shell that exited but has not been waited for yet keeps its group id.
  const out = '  100     1   100 Ss\n  101   100   100 S\n  200   100   200 Z';
  assert.equal(hasLaunchedJob(100, parseProcessTable(out)), false);
  assert.equal(hasLaunchedJob(100, parseProcessTable(out.replace(/ Z$/, ' S+'))), true);
});
