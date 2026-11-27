/**
 * The scheduler's store: its tables in core.db, the one SQLite database a core process keeps beside the hive.
 *
 * core.db is app-owned state. It lives in the app's own data folder (the folder Electron calls userData, which the app
 * registers as private: see privateDirs.ts), never in a hive: the hive folder is a git tree that agents read and
 * write, and a database there would be committed, merged and editable by any seat. So a path inside a hive root is
 * refused, compared with links resolved, before any file is made. coreDbPath gives the default path, or an explicit
 * override (tests, a second install).
 *
 * The scheduler module owns the tables named in SCHEDULER_MODULE and writes no other. core_schema records each module's
 * schema version; a database whose version for this module is newer than this code knows is refused, never written:
 * an older build that migrated it down, or wrote rows in the old shape, would lose what the newer one recorded.
 *
 * The binding is node:sqlite (Node's built-in SQLite): no native module to rebuild for Electron, and the core may use
 * Node builtins without widening the list of packages it is allowed (test/core-boundary.test.cjs).
 */
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { holds } from '../hookRuntime';
import type { ScheduledTask } from './task';

export const CORE_DB_FILE = 'core.db';

/** The folder name of the app's data folder, as Electron derives userData from the package name. */
const APP_DATA_NAME = 'munder-difflin';

/** The schema version of the scheduler's tables this code writes. */
export const SCHEDULER_SCHEMA_VERSION = 2;

/** What a core module declares about its part of core.db and of the hive. */
export interface CoreModuleDeclaration {
  /** Stable id; prefixes the module's tables. */
  name: string;
  /** The tables in core.db the module owns. It writes no other. */
  tables: readonly string[];
  /** The schema version of those tables this code writes. */
  schemaVersion: number;
  /** What the module writes in the hive. It never commits. */
  hiveWrites: readonly string[];
}

export const SCHEDULER_MODULE: CoreModuleDeclaration = {
  name: 'scheduler',
  tables: ['scheduler_leases', 'scheduler_runs', 'scheduler_tasks'],
  schemaVersion: SCHEDULER_SCHEMA_VERSION,
  hiveWrites: [
    'cost-ledger.jsonl: one appended row per finished run that reported a cost, carrying the run id',
    'agents/<agentId>/outbox: one done message per run whose output is in place, its id derived from the run id',
  ],
};

/** Columns added to scheduler_runs at version 2: the process the current attempt's runner started. */
const RUNNER_COLUMNS: ReadonlyArray<[string, string]> = [
  ['runner_pid', 'INTEGER'], ['runner_pgid', 'INTEGER'], ['runner_host', 'TEXT'], ['runner_started', 'TEXT'],
];

/** Adds each of `columns` that `table` lacks. A database written by an earlier build of version 1 may already carry
 *  some of them, added there before they had a version of their own. */
function addMissingColumns(db: DatabaseSync, table: string, columns: ReadonlyArray<[string, string]>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Row[]).map((c) => String(c.name)));
  for (const [name, type] of columns) if (!have.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
}

/** Each migration takes the scheduler's tables from version (index) to version (index + 1). */
const MIGRATIONS: ReadonlyArray<string | ((db: DatabaseSync) => void)> = [
  `CREATE TABLE scheduler_tasks (
     id TEXT PRIMARY KEY,
     definition TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   );
   CREATE TABLE scheduler_runs (
     id TEXT PRIMARY KEY,
     task_id TEXT NOT NULL,
     slot TEXT NOT NULL,
     slot_at INTEGER NOT NULL,
     state TEXT NOT NULL CHECK (state IN ('claimed', 'running', 'ran', 'done', 'failed')),
     snapshot TEXT NOT NULL,
     claimed_at INTEGER NOT NULL,
     attempt INTEGER NOT NULL DEFAULT 0,
     started_at INTEGER,
     ended_at INTEGER,
     outcome TEXT,
     failure TEXT,
     cost_state TEXT,
     cost_from INTEGER,
     cost_reason TEXT,
     mail_state TEXT,
     mail_id TEXT,
     UNIQUE (task_id, slot)
   );
   CREATE TABLE scheduler_leases (
     task_id TEXT PRIMARY KEY,
     pid INTEGER NOT NULL,
     host TEXT NOT NULL,
     started TEXT,
     token TEXT NOT NULL,
     acquired_at INTEGER NOT NULL,
     heartbeat_at INTEGER NOT NULL,
     lease_ms INTEGER NOT NULL
   );`,
  (db) => addMissingColumns(db, 'scheduler_runs', RUNNER_COLUMNS),
];

/** A core.db path that may not be used, or a database that may not be opened. */
export class CoreDbRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoreDbRefused';
  }
}

/** The app's data folder for the platform, as Electron computes userData for this app. */
function appDataDir(platform: NodeJS.Platform, env: Record<string, string | undefined>, home: string): string {
  if (platform === 'darwin') return posix.join(home, 'Library', 'Application Support', APP_DATA_NAME);
  if (platform === 'win32') return win32.join(env.APPDATA || win32.join(home, 'AppData', 'Roaming'), APP_DATA_NAME);
  return posix.join(env.XDG_CONFIG_HOME || posix.join(home, '.config'), APP_DATA_NAME);
}

/** Why `path` may not hold core.db, or null. */
function refusal(path: string, hiveRoots: readonly string[]): string | null {
  if (!isAbsolute(path)) return `the core.db path ${path} is not absolute`;
  const root = hiveRoots.find((r) => holds(r, path));
  return root ? `the core.db path ${path} is inside the hive at ${root}; core.db is app state and must live outside every hive` : null;
}

export interface CoreDbPathOptions {
  /** Every hive root core.db must stay out of. */
  hiveRoots: readonly string[];
  /** Use this path instead of the default. */
  override?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
}

/** Where core.db lives: `override`, or `<app data folder>/core/core.db`. Throws CoreDbRefused for a path inside a hive
 *  root. Makes nothing. */
export function coreDbPath(o: CoreDbPathOptions): string {
  const path = o.override ?? (() => {
    const platform = o.platform ?? process.platform;
    const dir = appDataDir(platform, o.env ?? process.env, o.home ?? homedir());
    return (platform === 'win32' ? win32 : posix).join(dir, 'core', CORE_DB_FILE);
  })();
  const why = refusal(path, o.hiveRoots);
  if (why) throw new CoreDbRefused(why);
  return path;
}

/** One run as stored. */
export interface StoredRun {
  id: string;
  taskId: string;
  /** The slot's key, named by the schedule (see task.ts). */
  slot: string;
  /** When the slot fell (epoch ms). */
  slotAt: number;
  state: 'claimed' | 'running' | 'ran' | 'done' | 'failed';
  /** The task definition frozen when the run was claimed. */
  snapshot: ScheduledTask;
  claimedAt: number;
  /** How many times its runner has been started. */
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** What the runner returned, once it has. */
  outcome: unknown;
  /** Why the run failed. */
  failure: string | null;
  /** The cost row: null (not yet), 'pending' (being appended, from byte costFrom), 'recorded', or 'none' (costReason). */
  costState: string | null;
  costFrom: number | null;
  costReason: string | null;
  /** The done mail: null (not yet), 'pending' (being written, as mailId), 'sent', or 'none' (the run is not done). */
  mailState: string | null;
  mailId: string | null;
  /** The process the current attempt's runner started (the headless CLI), as recorded when it started: its pid, the
   *  process group it leads, the host, and its start time once read. Null when the runner reported none. */
  runner: RunnerProcess | null;
}

/** A runner's process, recorded so that a later scheduler can tell whether it is still running. */
export interface RunnerProcess { pid: number; pgid: number | null; host: string; started: string | null }

type Row = Record<string, unknown>;

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function toRun(r: Row): StoredRun {
  return {
    id: String(r.id), taskId: String(r.task_id), slot: String(r.slot), slotAt: Number(r.slot_at), state: r.state as StoredRun['state'],
    snapshot: JSON.parse(String(r.snapshot)) as ScheduledTask, claimedAt: Number(r.claimed_at), attempt: Number(r.attempt),
    startedAt: num(r.started_at), endedAt: num(r.ended_at), outcome: r.outcome === null ? null : JSON.parse(String(r.outcome)),
    failure: (r.failure as string | null) ?? null, costState: (r.cost_state as string | null) ?? null, costFrom: num(r.cost_from),
    costReason: (r.cost_reason as string | null) ?? null, mailState: (r.mail_state as string | null) ?? null, mailId: (r.mail_id as string | null) ?? null,
    runner: r.runner_pid === null || r.runner_pid === undefined ? null
      : { pid: Number(r.runner_pid), pgid: num(r.runner_pgid), host: String(r.runner_host), started: (r.runner_started as string | null) ?? null },
  };
}

export class SchedulerStore {
  constructor(readonly db: DatabaseSync, readonly path: string) {}

  close(): void {
    if (this.db.isOpen) this.db.close();
  }

  /** Runs `fn` in one write transaction, taken before it reads, so two processes cannot both act on one reading. */
  write<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Stores a task definition (already checked by importTaskDefinition), replacing an earlier one with its id. When
   *  the task was first stored is kept: no slot before it is ever run. */
  putTask(def: ScheduledTask, now = Date.now()): void {
    this.db.prepare(`INSERT INTO scheduler_tasks (id, definition, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET definition = excluded.definition, updated_at = excluded.updated_at`).run(def.id, JSON.stringify(def), now, now);
  }

  getTask(id: string): ScheduledTask | null {
    const r = this.db.prepare('SELECT definition FROM scheduler_tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? (JSON.parse(String(r.definition)) as ScheduledTask) : null;
  }

  /** Every task, with when it was first stored. */
  tasks(): Array<{ def: ScheduledTask; createdAt: number }> {
    return (this.db.prepare('SELECT definition, created_at FROM scheduler_tasks ORDER BY id').all() as Row[])
      .map((r) => ({ def: JSON.parse(String(r.definition)) as ScheduledTask, createdAt: Number(r.created_at) }));
  }

  /** Every run, or one task's, oldest slot first. */
  runs(taskId?: string): StoredRun[] {
    const rows = taskId === undefined
      ? this.db.prepare('SELECT * FROM scheduler_runs ORDER BY slot_at, task_id').all()
      : this.db.prepare('SELECT * FROM scheduler_runs WHERE task_id = ? ORDER BY slot_at').all(taskId);
    return (rows as Row[]).map(toRun);
  }

  run(id: string): StoredRun | null {
    const r = this.db.prepare('SELECT * FROM scheduler_runs WHERE id = ?').get(id) as Row | undefined;
    return r ? toRun(r) : null;
  }
}

export interface OpenStoreOptions {
  path: string;
  /** Every hive root core.db must stay out of. */
  hiveRoots: readonly string[];
  /** How long a write waits for another connection's (default 5000 ms). */
  busyTimeoutMs?: number;
}

/** Opens (creating it and its folder when needed, the file readable by its owner only) core.db at `path`, and brings the scheduler's tables to
 *  SCHEDULER_SCHEMA_VERSION. Throws CoreDbRefused for a path inside a hive root, before anything is made, and for a
 *  database whose scheduler tables are newer than this code. */
export function openSchedulerStore(o: OpenStoreOptions): SchedulerStore {
  const why = refusal(o.path, o.hiveRoots);
  if (why) throw new CoreDbRefused(why);
  mkdirSync(join(o.path, '..'), { recursive: true, mode: 0o700 });
  // core.db holds task prompts and paths: readable by its owner only. SQLite gives its -wal and -shm files the mode
  // of the database file, so they follow. An existing file made with a wider mode is narrowed.
  closeSync(openSync(o.path, 'a', 0o600));
  chmodSync(o.path, 0o600);
  const db = new DatabaseSync(o.path, { timeout: o.busyTimeoutMs ?? 5000 });
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('CREATE TABLE IF NOT EXISTS core_schema (module TEXT PRIMARY KEY, version INTEGER NOT NULL)');
    const store = new SchedulerStore(db, o.path);
    store.write(() => {
      const r = db.prepare('SELECT version FROM core_schema WHERE module = ?').get(SCHEDULER_MODULE.name) as Row | undefined;
      const have = r ? Number(r.version) : 0;
      if (have > SCHEDULER_SCHEMA_VERSION) {
        throw new CoreDbRefused(`${o.path}: its ${SCHEDULER_MODULE.name} tables are at schema version ${have}, newer than version ${SCHEDULER_SCHEMA_VERSION} that this build knows; refusing to open it rather than write it in an older shape`);
      }
      for (let v = have; v < SCHEDULER_SCHEMA_VERSION; v++) {
        const step = MIGRATIONS[v];
        if (typeof step === 'string') db.exec(step); else step(db);
      }
      if (have < SCHEDULER_SCHEMA_VERSION) {
        db.prepare('INSERT INTO core_schema (module, version) VALUES (?, ?) ON CONFLICT (module) DO UPDATE SET version = excluded.version')
          .run(SCHEDULER_MODULE.name, SCHEDULER_SCHEMA_VERSION);
      }
    });
    return store;
  } catch (e) {
    db.close();
    throw e;
  }
}
