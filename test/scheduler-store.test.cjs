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

test('Given a new core.db, or one made readable by others, when the store opens it and writes, then the database and its WAL files are readable by the owner only', (t) => {
  const f = floor(t);
  const mode = (p) => fs.statSync(p).mode & 0o777;
  const store = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
  store.putTask({ id: 'a', agentId: 'x', prompt: 'p', schedule: { daily: '07:00' }, model: 'm', maxBudgetUsd: 1, outputFile: '/o', cwd: '/c', roots: [] });
  for (const p of [f.dbPath, `${f.dbPath}-wal`, `${f.dbPath}-shm`]) assert.equal(mode(p), 0o600, p);
  store.close();
  fs.chmodSync(f.dbPath, 0o644);
  S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] }).close();
  assert.equal(mode(f.dbPath), 0o600);
});

/** The scheduler's tables as version 1 created them, before the runner columns: what an earlier build left. */
const V1 = `CREATE TABLE core_schema (module TEXT PRIMARY KEY, version INTEGER NOT NULL);
  INSERT INTO core_schema VALUES ('scheduler', 1);
  CREATE TABLE scheduler_tasks (id TEXT PRIMARY KEY, definition TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE scheduler_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, slot TEXT NOT NULL, slot_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'ran', 'done', 'failed')), snapshot TEXT NOT NULL, claimed_at INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0, started_at INTEGER, ended_at INTEGER, outcome TEXT, failure TEXT, cost_state TEXT, cost_from INTEGER,
    cost_reason TEXT, mail_state TEXT, mail_id TEXT, UNIQUE (task_id, slot));
  CREATE TABLE scheduler_leases (task_id TEXT PRIMARY KEY, pid INTEGER NOT NULL, host TEXT NOT NULL, started TEXT, token TEXT NOT NULL,
    acquired_at INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL, lease_ms INTEGER NOT NULL);
  INSERT INTO scheduler_runs (id, task_id, slot, slot_at, state, snapshot, claimed_at) VALUES ('r1', 'a', '2026-11-21T07:00', 1, 'claimed', '{}', 1);`;

for (const [name, extra] of [['without the runner columns', ''], ['that already carries the runner columns', 'ALTER TABLE scheduler_runs ADD COLUMN runner_pid INTEGER; ALTER TABLE scheduler_runs ADD COLUMN runner_pgid INTEGER; ALTER TABLE scheduler_runs ADD COLUMN runner_host TEXT; ALTER TABLE scheduler_runs ADD COLUMN runner_started TEXT;']]) {
  test(`Given a version-1 core.db ${name}, when the store opens it, then it is brought to version 2 with its runs kept and the runner columns in place`, (t) => {
    const f = floor(t);
    const raw = new DatabaseSync(f.dbPath);
    raw.exec(V1 + extra);
    raw.close();
    const store = S.openSchedulerStore({ path: f.dbPath, hiveRoots: [f.hiveRoot] });
    t.after(() => store.close());
    assert.equal(store.db.prepare('SELECT version FROM core_schema WHERE module = ?').get('scheduler').version, 2);
    const cols = store.db.prepare('PRAGMA table_info(scheduler_runs)').all().map((c) => c.name);
    for (const c of ['runner_pid', 'runner_pgid', 'runner_host', 'runner_started']) assert.ok(cols.includes(c), c);
    assert.equal(store.run('r1').runner, null);
    store.db.prepare('UPDATE scheduler_runs SET runner_pid = 7, runner_host = ? WHERE id = ?').run('h', 'r1');
    assert.equal(store.run('r1').runner.pid, 7);
  });
}
