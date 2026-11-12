/**
 * The local usage log for the owner's side of the app: which screens are open,
 * for how long, and how asks are seen and answered (docs/usage-log.md).
 *
 * Local only: daily files at <hive>/usage/YYYY-MM-DD.jsonl, folder 0700, files
 * 0600, kept RETENTION_DAYS. There is no network code here, and these events
 * are never handed to the outbound analytics module.
 *
 * Ids, enums and durations only, enforced by an allowlist: an unknown kind is
 * refused, an unknown field is dropped, and every string must be a known enum,
 * a known view, or an agent or card id the app itself holds (the roster,
 * tasks.json), so free text (message, question, answer, typed input) cannot be
 * written even by a buggy caller.
 */
import { appendFileSync, chmodSync, closeSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const RETENTION_DAYS = 90;
const SCHEMA = 1;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export const VIEWS = [
  ...['terminal', 'floor', 'tasks', 'human', 'triggers', 'trigger-history', 'memory', 'graph', 'activity', 'skills', 'workers']
    .map((tab) => `command-center:${tab}`),
  'agent-detail', 'agent-detail:terminal', 'agent-detail:git', 'agent-detail:messages', 'agent-detail:traces',
  'settings', 'memory', 'task-detail', 'terminal-fullscreen'
];

type FieldType = 'view' | 'id' | 'agent' | 'card' | 'askKey' | 'count' | 'bool' | { oneOf: readonly string[] };

/** The harness's own sets: a renderer-supplied agent or card id is written only
 *  when one of these holds it. */
export interface KnownIds { isAgent(id: string): boolean; isCard(id: string): boolean }
const NONE: KnownIds = { isAgent: () => false, isCard: () => false };
/** `<cardId>@<ISO time>`, as askKeyOf() builds it. */
const ASK_KEY = /^(.+)@(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)$/;

const ID = /^[\w.:@-]{1,120}$/;
// session is minted by the main process (a UUID), never by the renderer.
const COMMON: Record<string, FieldType> = { session: 'id', win: 'count', focused: 'bool' };
const EVENTS: Record<string, Record<string, FieldType>> = {
  'ui-view': { view: 'view', agentId: 'agent', cardId: 'card' },
  'ui-view-end': { view: 'view', dwellMs: 'count' },
  'ask-shown': { askKey: 'askKey', ageMs: 'count', surface: { oneOf: ['ask-me', 'card-overlay'] } },
  'ask-submitted': {
    askKey: 'askKey', msSinceShown: 'count', answerLen: 'count',
    answerShape: { oneOf: ['done-ack', 'option', 'short', 'sentence', 'long'] },
    surface: { oneOf: ['ask-me', 'card-overlay'] }
  },
  'app-focus': { state: { oneOf: ['focus', 'blur', 'hidden', 'shown'] } }
};
/** Fields a kind cannot be written without. */
const REQUIRED: Record<string, string[]> = {
  'ui-view': ['view'], 'ui-view-end': ['view', 'dwellMs'], 'ask-shown': ['askKey'], 'ask-submitted': ['askKey'], 'app-focus': ['state']
};

function valid(type: FieldType, v: unknown, known: KnownIds): boolean {
  if (type === 'view') return typeof v === 'string' && (VIEWS as readonly string[]).includes(v);
  if (type === 'agent') return typeof v === 'string' && known.isAgent(v);
  if (type === 'card') return typeof v === 'string' && known.isCard(v);
  if (type === 'askKey') {
    const m = typeof v === 'string' ? ASK_KEY.exec(v) : null;
    return !!m && known.isCard(m[1]) && new Date(m[2]).toISOString() === m[2];
  }
  if (type === 'id') return typeof v === 'string' && ID.test(v);
  if (type === 'count') return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  if (type === 'bool') return typeof v === 'boolean';
  return typeof v === 'string' && type.oneOf.includes(v);
}

/** The allowlisted copy of an event, or null when it must not be written. */
export function sanitize(event: Record<string, unknown>, known: KnownIds = NONE): Record<string, unknown> | null {
  const kind = typeof event.kind === 'string' ? event.kind : '';
  const fields = EVENTS[kind];
  if (!fields) return null;
  const out: Record<string, unknown> = { kind };
  for (const [k, type] of Object.entries({ ...COMMON, ...fields })) {
    if (!(k in event) || event[k] === undefined) continue;
    if (!valid(type, event[k], known)) {
      // An agent or card the app does not hold is left out; the view still counts.
      if ((type === 'agent' || type === 'card') && typeof event[k] === 'string') continue;
      return null;
    }
    out[k] = event[k];
  }
  for (const k of REQUIRED[kind] ?? []) if (!(k in out)) return null;
  return out;
}

export interface UsageLogDeps {
  root: () => string | null;
  enabled: () => boolean;
  now?: () => number;
  /** True for an id on the agent roster. */
  isAgent?: (id: string) => boolean;
  /** True for a card id in the current tasks.json. */
  isCard?: (id: string) => boolean;
}

export class UsageLog {
  constructor(private readonly d: UsageLogDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** The usage folder, created private; null when there is no root or the path is not a real folder. */
  private dir(create: boolean): string | null {
    const root = this.d.root();
    if (!root) return null;
    const dir = join(root, 'usage');
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) return null;
      return dir;
    } catch {
      if (!create) return null;
      try { mkdirSync(dir, { mode: 0o700 }); chmodSync(dir, 0o700); return dir; } catch { return null; }
    }
  }

  /** Append one event if the log is on and the event passes the allowlist. */
  record(event: Record<string, unknown>): boolean {
    if (!this.d.enabled()) return false;
    const clean = sanitize(event, { isAgent: (id) => this.d.isAgent?.(id) ?? false, isCard: (id) => this.d.isCard?.(id) ?? false });
    if (!clean) return false;
    const dir = this.dir(true);
    if (!dir) return false;
    const ts = this.now();
    const file = join(dir, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`);
    try {
      try { if (lstatSync(file).isSymbolicLink()) return false; } catch { closeSync(openSync(file, 'a', 0o600)); }
      appendFileSync(file, JSON.stringify({ ts, v: SCHEMA, ...clean }) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  /** Remove daily files older than RETENTION_DAYS; returns how many were removed. */
  prune(): number {
    const dir = this.dir(false);
    if (!dir) return 0;
    const cutoff = new Date(this.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    for (const name of readdirSync(dir)) {
      const m = DAY_FILE.exec(name);
      if (m && m[1] < cutoff) { try { rmSync(join(dir, name)); removed++; } catch { /* keep going */ } }
    }
    return removed;
  }

  /** Delete every daily usage file (the Settings button); returns how many. */
  deleteAll(): number {
    const dir = this.dir(false);
    if (!dir) return 0;
    let removed = 0;
    for (const name of readdirSync(dir)) {
      if (DAY_FILE.test(name)) { try { rmSync(join(dir, name)); removed++; } catch { /* keep going */ } }
    }
    return removed;
  }
}
