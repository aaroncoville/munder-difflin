'use strict';
// The scheduler's store: one core.db (SQLite) holding the scheduler's tasks, runs and leases, plus a schema-version
// table. It lives in the app's own state folder, outside every hive: a path inside a hive root is refused before any
// file is made, links resolved. A database written by a newer schema version is refused, never migrated down or
// written over. The module declares the tables it owns, and owns exactly those.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const loadTs = require('./load-ts.cjs');
const { floor } = require('./scheduler-fixtures.cjs');

const S = loadTs('src/core/scheduler/store.ts');

test('Given a core.db written by a newer schema version, when the store opens it, then it is refused naming both versions and left as it was', (t) => {
  const f = floor(t);
  S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] }).close();
  const raw = new DatabaseSync(f.dbPath);
  raw.prepare('UPDATE core_schema SET version = ? WHERE module = ?').run(S.SCHEDULER_SCHEMA_VERSION + 1, 'scheduler');
  raw.close();
  assert.throws(() => S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] }), (e) => {
    assert.match(e.message, new RegExp(`scheduler.*version ${S.SCHEDULER_SCHEMA_VERSION + 1}.*newer.*${S.SCHEDULER_SCHEMA_VERSION}`));
    return true;
  });
  const again = new DatabaseSync(f.dbPath);
  assert.equal(again.prepare('SELECT version FROM core_schema WHERE module = ?').get('scheduler').version, S.SCHEDULER_SCHEMA_VERSION + 1);
  again.close();
});

test('Given a core.db path inside a hive root, when the path is chosen or the store opened, then it is refused and no file is made', (t) => {
  const f = floor(t);
  const inside = path.join(f.hiveRoot, 'state', 'core.db');
  assert.throws(() => S.coreDbPath({ hiveRoots: [f.hiveRoot], override: inside }), /inside the hive/);
  assert.throws(() => S.openSchedulerStore({ path: inside, hiveRoots: [f.hiveRoot] }), /inside the hive/);
  assert.equal(fs.existsSync(path.join(f.hiveRoot, 'state')), false);
  // The hive root itself as the folder, and a link outside the hive that leads into it.
  assert.throws(() => S.openSchedulerStore({ path: path.join(f.hiveRoot, 'core.db'), hiveRoots: [f.hiveRoot] }), /inside the hive/);
  fs.symlinkSync(f.hiveRoot, path.join(f.base, 'into-hive'));
  assert.throws(() => S.openSchedulerStore({ path: path.join(f.base, 'into-hive', 'core.db'), hiveRoots: [f.hiveRoot] }), /inside the hive/);
  assert.equal(fs.existsSync(path.join(f.hiveRoot, 'core.db')), false);
});

test('Given no override, when the core.db path is chosen, then it is in the app\'s own data folder for the platform', () => {
  const hiveRoots = ['/elsewhere/hive'];
  assert.equal(S.coreDbPath({ hiveRoots, platform: 'darwin', home: '/Users/u', env: {} }), '/Users/u/Library/Application Support/munder-difflin/core/core.db');
  assert.equal(S.coreDbPath({ hiveRoots, platform: 'linux', home: '/home/u', env: {} }), '/home/u/.config/munder-difflin/core/core.db');
  assert.equal(S.coreDbPath({ hiveRoots, platform: 'linux', home: '/home/u', env: { XDG_CONFIG_HOME: '/x' } }), '/x/munder-difflin/core/core.db');
  assert.equal(S.coreDbPath({ hiveRoots, override: '/tmp/a/core.db' }), '/tmp/a/core.db');
});

test('Given a fresh store, when it opens, then the tables it creates are exactly the ones the scheduler module declares, plus the schema table', (t) => {
  const f = floor(t);
  S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] }).close();
  const raw = new DatabaseSync(f.dbPath);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
  raw.close();
  assert.equal(S.SCHEDULER_MODULE.name, 'scheduler');
  assert.ok(S.SCHEDULER_MODULE.tables.length > 0 && S.SCHEDULER_MODULE.tables.every((n) => n.startsWith('scheduler_')));
  assert.deepEqual(tables, ['core_schema', ...S.SCHEDULER_MODULE.tables].sort());
  assert.equal(S.SCHEDULER_MODULE.schemaVersion, S.SCHEDULER_SCHEMA_VERSION);
});

test('Given an open store, when it opens again, then it is not migrated twice and keeps its tasks', (t) => {
  const f = floor(t);
  const a = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  a.putTask({ id: 'x', agentId: 'a', prompt: 'p', schedule: { daily: '07:19' }, model: 'sonnet', maxBudgetUsd: 1, outputFile: '/o/x.md', cwd: '/o', roots: [] }, 1);
  a.close();
  const b = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  assert.equal(b.getTask('x').prompt, 'p');
  b.close();
});
