'use strict';

/**
 * A test's cleanups run in the order they were registered, and one that throws skips every cleanup after it. A folder
 * removal that failed therefore used to skip the HOME or TMPDIR restore registered after it, and every later test in
 * the file then ran with the wrong environment and failed for a reason that had nothing to do with it.
 *
 * removeDir must not throw: a later restore still runs, and the failure still fails the file.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('a removal that fails skips no later cleanup, and still fails the file', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'md-cleanup-')));
  t.after(() => {
    fs.chmodSync(path.join(dir, 'locked'), 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  // A folder inside a read-only one cannot be removed.
  const locked = path.join(dir, 'locked');
  fs.mkdirSync(path.join(locked, 'stuck'), { recursive: true });
  fs.chmodSync(locked, 0o500);
  const helper = path.resolve(__dirname, 'codex-test-home.cjs');
  const fixture = path.join(dir, 'fixture.test.cjs');
  fs.writeFileSync(fixture, `
    const test = require('node:test');
    const { removeDir } = require(${JSON.stringify(helper)});
    test('first', (t) => {
      process.env.MD_CLEANUP_PROBE = 'changed';
      t.after(async () => { await removeDir(${JSON.stringify(path.join(locked, 'stuck'))}); });
      t.after(() => { delete process.env.MD_CLEANUP_PROBE; });
    });
    test('second', () => { console.log('PROBE=' + (process.env.MD_CLEANUP_PROBE ?? 'restored')); });
  `);

  // A run of its own: under the test runner, NODE_TEST_CONTEXT would make the child skip running files.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', fixture], { encoding: 'utf8', cwd: path.resolve(__dirname, '..'), env });
  const out = run.stdout + run.stderr;

  assert.match(out, /PROBE=restored/, `the restore after the failed removal did not run:\n${out}`);
  assert.notEqual(run.status, 0, 'the failed removal did not fail the file');
  assert.match(out, /could not remove/);
});
