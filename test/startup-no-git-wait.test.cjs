'use strict';
// #109: every first launch's window never loaded. bootstrapHiveServices runs on the main thread after app ready and
// before createWindow, and its orphan sweep made one synchronous hive commit per agent the last quit left
// archived:false (12 of them; 2 s to 20 s each on a 6 GB hive). Shown with Electron 43.8.4: a main thread busy past
// ~12-16 s at that point stops the network service from starting ("Network service crashed or was terminated,
// restarting service") and the window never loads. #106 made hive commits queue-only.
//
// This runs the hive work bootstrap does before createWindow (ensureHive, refreshGeneratedDocs, the orphan sweep) with
// a git on PATH that takes 2 s per call, and requires it to finish in less than one git call. Before #106 it took
// about 50 s. For the Electron side of the limit, see test/manual/startup-block-probe.cjs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const loadTs = require('./load-ts.cjs');
const { HiveManager } = loadTs('src/main/hive.ts');
const { archiveOrphanedAgents } = loadTs('src/main/orphanSweep.ts');

const GIT_DELAY_S = 2;
const BUDGET_MS = 1_800;   // under one slow git call (2 s), with room for a loaded machine; far under Electron's ~12 s

test('the hive half of startup (ensureHive, generated docs, sweeping 12 orphans) never waits on git', { timeout: 300_000 }, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-startup-git-'));
  const hive = new HiveManager(() => home);
  hive.ensureHive();
  await hive.ensureAgent({ id: 'god-1', name: 'Boss', provider: 'claude', cwd: home, isGod: true });
  const ids = Array.from({ length: 12 }, (_, i) => `worker-${i + 1}`);
  for (const id of ids) await hive.ensureAgent({ id, name: id, provider: 'claude', cwd: home });
  if (typeof hive.commitsSettled === 'function') await hive.commitsSettled();
  assert.ok(fs.existsSync(path.join(hive.root(), '.git')), 'the hive is a git repository, as in the field');

  // From here on every git call takes GIT_DELAY_S, as the owner's did.
  const realGit = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(home, 'slow-bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nsleep ${GIT_DELAY_S}\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${PATH}`;
  t.after(async () => {
    process.env.PATH = PATH;
    if (typeof hive.stopCommits === 'function') await hive.stopCommits(0, 500);
    fs.rmSync(home, { recursive: true, force: true });
  });

  const t0 = Date.now();
  hive.ensureHive();
  hive.refreshGeneratedDocs();
  const archived = archiveOrphanedAgents(hive, () => false);
  const ms = Date.now() - t0;

  assert.deepEqual(archived.sort(), [...ids].sort(), 'all 12 orphans archived, god kept');
  const reg = JSON.parse(fs.readFileSync(path.join(hive.root(), 'registry.json'), 'utf8'));
  for (const id of ids) assert.equal(reg.agents[id].archived, true);
  assert.ok(ms < BUDGET_MS, `startup's hive work waited on git: ${ms} ms (budget ${BUDGET_MS} ms)`);
});

test('each orphan is reported as it is archived, so an error later in the sweep loses none', () => {
  const reg = { godId: 'god-1', agents: { 'god-1': {}, 'worker-1': {}, 'worker-2': {}, 'worker-3': {} } };
  const seen = [];
  const hive = {
    enabled: () => true,
    registry: () => reg,
    setArchived: (id) => { if (id === 'worker-3') throw new Error('registry write failed'); }
  };
  assert.throws(() => archiveOrphanedAgents(hive, () => false, (id) => seen.push(id)), /registry write failed/);
  assert.deepEqual(seen, ['worker-1', 'worker-2']);
});
