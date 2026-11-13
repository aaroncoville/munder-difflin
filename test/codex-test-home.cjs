'use strict';
/**
 * A scratch folder for tests that start Codex agents with HOME jailed inside it.
 *
 * Codex's workspace-write sandbox lets every agent write /tmp and $TMPDIR, so the
 * app refuses to start any agent while the Codex agents' homes (~/.mdc) sit under
 * one of them. A HOME made with mkdtemp under /tmp or os.tmpdir() is therefore
 * refused. /var/tmp is neither, and short enough for the hive's hooks.sock.
 * Where there is no /var/tmp, the folder is made under os.tmpdir() and TMPDIR
 * (with TMP and TEMP) is pointed at a separate fresh folder for the test.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

// A hive commit can still be running after the call that asked for it returns, and removing the folder under it
// fails with ENOTEMPTY, so every cleanup here waits for commits to finish first.
const { allCommitsIdle } = loadTs('src/main/hiveCommit.ts');

/**
 * Remove a test's folder from a cleanup, without ever throwing.
 *
 * Cleanups run in the order they were registered, and one that throws skips every cleanup after it. A removal that
 * failed used to skip the HOME or TMPDIR restore registered after it, so every later test in the file ran with the
 * wrong environment. A failure here is reported, and fails the file through its exit code, after every other cleanup
 * has run.
 */
async function removeDir(dir, { waitForCommits = true } = {}) {
  // waitForCommits: false is for a cleanup that has already waited in its own bounded way.
  if (waitForCommits) await allCommitsIdle();
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`could not remove ${dir}: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
  }
}

function codexTestBase(t, prefix = 'md-') {
  if (process.platform !== 'win32' && fs.existsSync('/var/tmp')) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', prefix)));
    t.after(() => removeDir(base));
    return base;
  }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}tmp-`)));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  for (const k of Object.keys(saved)) process.env[k] = tmp;
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await removeDir(base);
    await removeDir(tmp);
  });
  return base;
}

/** Point HOME at `home` for the rest of the test. */
function jailHome(t, home) {
  const real = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { if (real === undefined) delete process.env.HOME; else process.env.HOME = real; });
}

/** A HOME of its own for every test in the calling file, with no Codex agents'
 *  homes in it. Agents of providers the app does not sandbox cannot start while
 *  any Codex home exists, so a test that never jails HOME would otherwise depend
 *  on the machine it runs on (and read the real ~/.mdc). */
function isolateHomeForFile(prefix = 'md-') {
  const { after } = require('node:test');
  const root = process.platform !== 'win32' && fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const home = fs.realpathSync(fs.mkdtempSync(path.join(root, prefix)));
  const real = process.env.HOME;
  process.env.HOME = home;
  after(async () => {
    if (real === undefined) delete process.env.HOME; else process.env.HOME = real;
    await removeDir(home);
  });
  return home;
}

module.exports = { codexTestBase, jailHome, isolateHomeForFile, removeDir };
