import { randomBytes } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { codexShortHomePath, codexShortHomeRoot } from '../shared/codexRemote';
import { overlaps, realish, type WriteRoot } from './hookRuntime';

/**
 * Where a Codex agent's CODEX_HOME lives, and why it is not in the agent folder.
 *
 * Codex reads lifecycle hooks from its home: `[hooks]` tables in config.toml,
 * a bare `hooks.json`, enabled plugins, and the `hooks.state` table that records
 * which hook hashes are trusted. Hooks run outside the agent's sandbox. Every
 * sandboxed agent may write the whole hive folder (its writable roots include
 * it), so a home inside `<hive>/agents/<id>/` could be written by any OTHER
 * agent: a `hooks.json` planted there ran, unsandboxed, the next time the owner
 * started. Codex only write-protects `.codex` at the top of a writable root,
 * which covers an agent's own home but not its neighbours'.
 *
 * So the home is computed here, from the agent folder's path and the agent id,
 * and placed under the short-home base outside the hive. Nothing found under the
 * agent folder decides it: an in-tree `.codex` that another agent replaced (with
 * a folder, or a link pointing somewhere else) changes nothing.
 *
 * The base is the short-home root, kept short on purpose: macOS caps the control
 * socket Codex binds inside its home at 104 bytes (codexShortHomeRoot). The digest is
 * the one the short home always used, so an agent that already had a short home
 * keeps its sessions, history and thread index.
 */
export function codexSeatHome(agentDir: string, agentId: string, base?: string): string {
  return codexShortHomePath(join(agentDir, '.codex'), agentId, base);
}

/** A Codex agent that must not start: its home could be written by its own
 *  sandbox, or hooks in it would run that the app did not write and trust. */
export class CodexHomeRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexHomeRefused';
  }
}

/** Folders Codex's workspace-write sandbox lets every agent write without being
 *  told: /tmp and $TMPDIR. */
export function codexTempRoots(): WriteRoot[] {
  const out: WriteRoot[] = [{ path: tmpdir(), from: 'the temp folder ($TMPDIR), which Codex lets every agent write' }];
  if (process.platform !== 'win32') out.push({ path: '/tmp', from: '/tmp, which Codex lets every agent write' });
  return out;
}

/** Why these write roots, or the temp folders every Codex agent may write, reach
 *  the folder that holds every Codex agent's home; null when none does. Compared
 *  on resolved paths, so a link in either spelling does not hide an overlap. */
export function codexHomesReach(roots: WriteRoot[], base: string = codexShortHomeRoot()): string | null {
  for (const r of [...roots, ...codexTempRoots()]) {
    if (r.path === null) return `a write root in ${r.from} could not be read or understood, so it may reach every Codex agent's home (${base})`;
    if (r.path && overlaps(base, r.path)) return `the agent may write ${r.path} (${r.from}), which holds every Codex agent's home (${base}); it could plant hooks there`;
  }
  return null;
}

/** A Codex home the app computed: a real folder directly inside the folder that
 *  holds every Codex agent's home, which no agent's roots may reach (checked when
 *  any agent is provisioned). Throws CodexHomeRefused naming it otherwise. */
export function assertComputedCodexHome(home: string, base: string = codexShortHomeRoot()): void {
  const st = lstatSync(home, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink() || !st.isDirectory()) {
    throw new CodexHomeRefused(`Codex home ${home} is ${!st ? 'missing' : st.isSymbolicLink() ? 'a link' : 'not a folder'}; it must be a real folder the app made`);
  }
  if (realish(dirname(home)) !== realish(base)) {
    throw new CodexHomeRefused(`Codex home ${home} is not one of the app's computed homes under ${base}`);
  }
}

/** Files carried over from an agent's old in-tree home, read as data from a
 *  folder every agent could write until homes moved:
 *  - history.jsonl: the prompt history. Untrusted text the model may read back
 *    (Codex can surface it in later sessions), so it is size-capped and copied
 *    only as a regular file; its content is not vetted.
 *  - hive-thread.json: the app's own record of which hive messages belong to
 *    the worker's current thread, copied only when it is exactly that shape.
 * Nothing that configures Codex is copied: config.toml is regenerated every
 * spawn, and hooks.json, plugins, profiles, AGENTS.md and skills are exactly
 * what another agent could have planted. Codex's state databases
 * (state_N.sqlite, thread_history_N.sqlite) are not copied either: Codex
 * rebuilds them from the rollouts, which stay in the user's Codex sessions
 * folder, and resume by id or --last works without them (codex-cli 0.167);
 * only thread names set with /rename are lost. */
const MIGRATED = /^(history\.jsonl|hive-thread\.json)$/;
/** No single file of these is legitimately larger. */
export const MIGRATE_MAX_BYTES = 1024 * 1024 * 1024;
const MARKER = '.migrated-from-agent-folder.json';
const TEMP = '.migrating-';

export interface SeatMigration { from: string; copied: string[]; skipped: string[] }

/** Why a hive-thread.json is not the app's own thread record ({ fresh, ids }), or null when it is. */
function threadRecordProblem(bytes: Buffer): string | null {
  let v: unknown;
  try { v = JSON.parse(bytes.toString('utf8')); } catch { return 'not a thread record: not JSON'; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not a thread record: not an object';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== 2 || keys[0] !== 'fresh' || keys[1] !== 'ids') return 'not a thread record: unexpected keys';
  if (typeof o.fresh !== 'boolean') return 'not a thread record: fresh is not true or false';
  if (!Array.isArray(o.ids) || o.ids.length > 500 || !o.ids.every((x) => typeof x === 'string' && x.length <= 200)) {
    return 'not a thread record: ids is not a list of message ids';
  }
  return null;
}
const CHECKS: Record<string, (bytes: Buffer) => string | null> = { 'hive-thread.json': threadRecordProblem };

/** Copy one regular file, never following a link at the source, to a temporary
 *  name beside `to`; check its size (and content, where there is a check), then
 *  rename it into place. Returns why it was deliberately skipped, or null when
 *  copied. Any other failure throws, with nothing partial left at `to`. */
function copyRegular(from: string, to: string, cap: number, check?: (bytes: Buffer) => string | null): string | null {
  let fd: number;
  try { fd = openSync(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ELOOP') return 'a link';
    throw e;
  }
  const tmp = join(dirname(to), `${TEMP}${basename(to)}.${process.pid}.${randomBytes(6).toString('hex')}`);
  let placed = false;
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'not a regular file';
    if (st.size > cap) return `larger than ${cap} bytes`;
    const out = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let total = 0;
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        total += n;
        if (total > cap) return `larger than ${cap} bytes`;
        for (let off = 0; off < n;) off += writeSync(out, buf, off, n - off);
      }
    } finally { closeSync(out); }
    if (total !== st.size) return 'changed while it was copied';
    const problem = check ? check(readFileSync(tmp)) : null;
    if (problem) return problem;
    renameSync(tmp, to);
    placed = true;
    return null;
  } finally {
    closeSync(fd);
    if (!placed) rmSync(tmp, { force: true });
  }
}

/**
 * Carry an agent's history from its old in-tree home into the computed one,
 * once. The old home is read as data from an untrusted place: only a real
 * directory is read (a link is never followed), only allowlisted regular files
 * are copied, each size-capped and renamed into place only once complete, and
 * nothing under the agent folder is renamed, moved or deleted. The marker that
 * ends the migration is written last, once every allowlisted file is in place
 * or deliberately skipped; a start interrupted before that finishes it (a file
 * already in place is kept). Returns what happened, or null when there was
 * nothing to do.
 */
export function migrateSeatHome(agentDir: string, home: string, cap = MIGRATE_MAX_BYTES): SeatMigration | null {
  const legacy = join(agentDir, '.codex');
  const st = lstatSync(legacy, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) return null;
  if (existsSync(join(home, MARKER))) return null;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Temporary files an interrupted copy left behind.
  for (const name of readdirSync(home)) if (name.startsWith(TEMP)) rmSync(join(home, name), { force: true });
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const entry of readdirSync(legacy, { withFileTypes: true })) {
    if (!MIGRATED.test(entry.name)) continue;
    if (existsSync(join(home, entry.name))) { skipped.push(`${entry.name} (already present)`); continue; }
    const why = copyRegular(join(legacy, entry.name), join(home, entry.name), cap, CHECKS[entry.name]);
    if (why) skipped.push(`${entry.name} (${why})`); else copied.push(entry.name);
  }
  writeFileSync(join(home, MARKER), JSON.stringify({ from: legacy, copied, skipped }, null, 2), { mode: 0o600 });
  return { from: legacy, copied, skipped };
}
