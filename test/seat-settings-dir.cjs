'use strict';
/**
 * A seat settings folder for a test's HiveManager.
 *
 * A Claude spawn is refused while no seat settings folder is set (the generated --settings file is never written into
 * the hive), so a test that spawns Claude agents gives its HiveManager one, as the app does at start. The folder is
 * made outside the hive, /tmp and $TMPDIR (which agents' sandboxes may write, see codex-test-home.cjs), and removed
 * when the test process exits.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const made = [];
/** Every HiveManager given a folder here, with its folder. */
const given = [];
process.once('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });

/** Give `hive` a fresh seat settings folder of its own; returns the HiveManager. */
function withSeatSettings(hive) {
  const base = process.platform !== 'win32' && fs.existsSync('/var/tmp') ? '/var/tmp' : os.tmpdir();
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(base, 'md-seat-')));
  made.push(dir);
  hive.setSeatSettingsDir(path.join(dir, 'seat-settings'));
  given.push({ hive, dir: path.join(dir, 'seat-settings') });
  return hive;
}

/** The generated settings file of the agent whose folder is `agentDir` (<hive>/agents/<id>), for a HiveManager given a
 *  folder by withSeatSettings: <folder>/<sha256 of the hive root's real path, NUL, the id>.json, computed here. */
function seatFile(agentDir) {
  const root = path.dirname(path.dirname(agentDir));
  const g = [...given].reverse().find((x) => { const r = x.hive.root(); return r && path.resolve(r) === path.resolve(root); });
  if (!g) throw new Error(`no seat settings folder was given to the hive at ${root}`);
  // The name needs the hive folder's real path, so the folder must exist, as it does once a spawn starts.
  if (!fs.existsSync(root)) g.hive.ensureHive();
  const digest = crypto.createHash('sha256').update(`${fs.realpathSync(root)}\0${path.basename(agentDir)}`).digest('hex');
  return path.join(g.dir, `${digest}.json`);
}

module.exports = { withSeatSettings, seatFile };
