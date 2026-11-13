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

function codexTestBase(t, prefix = 'md-') {
  if (process.platform !== 'win32' && fs.existsSync('/var/tmp')) {
    const base = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', prefix)));
    t.after(async () => { await allCommitsIdle(); fs.rmSync(base, { recursive: true, force: true }); });
    return base;
  }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}tmp-`)));
  const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  for (const k of Object.keys(saved)) process.env[k] = tmp;
  t.after(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await allCommitsIdle();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(tmp, { recursive: true, force: true });
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
    await allCommitsIdle();
    fs.rmSync(home, { recursive: true, force: true });
  });
  return home;
}

module.exports = { codexTestBase, jailHome, isolateHomeForFile };
