'use strict';
// The heartbeat beat in index.ts asks shouldReengage whether to wake god. The
// policy has its own tests; these run the real beat, cut out of index.ts, so
// that a beat which stopped asking (and re-engaged every quiet floor again) is
// caught. index.ts pulls in Electron, so the beat runs in a sandbox with the
// services around it stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const loadTs = require('./load-ts.cjs');

const { shouldReengage } = loadTs('src/main/heartbeatPolicy.ts');
const REPO = path.resolve(__dirname, '..');

function armHeartbeatSource() {
  const src = fs.readFileSync(path.join(REPO, 'src/main/index.ts'), 'utf8');
  const start = src.indexOf('function armHeartbeat(m: ScheduledMission): void {');
  const end = src.indexOf('/** The live renderer webContents', start);
  assert.ok(start >= 0 && end > start, 'armHeartbeat located in index.ts');
  return ts.transpileModule(src.slice(start, end), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText;
}

/** Run one beat on a floor described by `floor`, and say what it did. */
function beatOn({ actionable = 0, quiet = true, doing = 0, suppressWhenIdle } = {}) {
  const reengaged = [];
  const logged = [];
  let beat = null;
  const ctx = vm.createContext({
    Date, Math, console: { error() {} },
    setTimeout: (fn) => { beat = beat ?? fn; return 0; },
    missionTimers: new Map(),
    godActionableInboxCount: () => actionable,
    isFloorQuiet: () => quiet,
    doingTaskCount: () => doing,
    shouldReengage,
    reengageGod: (digest) => { reengaged.push(digest); },
    buildHeartbeatDigest: () => 'digest',
    looksStuck: () => false,
    hive: { root: () => '/hive', appendLog: (e) => { logged.push(e); } },
    readConfig: () => ({ missions: [] }),
    writeConfig: () => {},
    liveWebContents: () => null
  });
  vm.runInContext(armHeartbeatSource(), ctx);
  ctx.armHeartbeat({ id: 'hb', intervalMs: 120_000, lastFiredAt: 0, ...(suppressWhenIdle === undefined ? {} : { suppressWhenIdle }) });
  assert.ok(beat, 'armHeartbeat scheduled its beat');
  beat();
  return { reengaged: reengaged.length, suppressed: logged.filter((e) => e.kind === 'heartbeat-suppressed').length };
}

test('a quiet floor with nothing doing is not re-engaged', () => {
  assert.deepEqual(beatOn({ quiet: true, doing: 0 }), { reengaged: 0, suppressed: 1 });
});

test('a quiet floor with a card doing is re-engaged', () => {
  assert.deepEqual(beatOn({ quiet: true, doing: 1 }), { reengaged: 1, suppressed: 0 });
});

test('mail for god re-engages however busy the floor is', () => {
  assert.deepEqual(beatOn({ actionable: 1, quiet: false }), { reengaged: 1, suppressed: 0 });
});

test('turning suppression off restores the old wake on every quiet floor', () => {
  assert.deepEqual(beatOn({ quiet: true, doing: 0, suppressWhenIdle: false }), { reengaged: 1, suppressed: 0 });
});
