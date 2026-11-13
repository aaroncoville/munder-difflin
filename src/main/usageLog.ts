/**
 * The local usage log for the owner's side of the app: which screens are open,
 * for how long, and how asks are seen and answered (docs/usage-log.md).
 *
 * Local only, and in the app's own data folder (<userData>/usage), never in the
 * hive: the hive is a git repository agents can read and write, so rows kept
 * there could be read, edited or redirected by an agent and would enter git
 * history. Daily files YYYY-MM-DD.jsonl, folder 0700, files 0600, kept
 * RETENTION_DAYS. There is no network code here, and these events are never
 * handed to the outbound analytics module.
 *
 * Ids, enums and durations only, enforced by an allowlist: an unknown kind is
 * refused, an unknown field is dropped, and every string must be a known enum,
 * a known view, or an agent or card id the app itself holds (the roster,
 * tasks.json), so free text (message, question, answer, typed input) cannot be
 * written even by a buggy caller.
 */
import { appendFileSync, chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOG_TOOLS, PATH_CLASSES, PROVIDERS, SHAPES, START_SOURCES, VIAS } from './writeRoots';

export const RETENTION_DAYS = 90;
const SCHEMA = 1;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DIGEST_FILE = /^digest-(\d{4})-W(\d{2})\.md$/;
/** Written by Delete: the time of the last delete. A weekly digest is never
 *  written for a week that started before it, so a delete stays a delete. */
export const DELETE_MARKER = '.deleted-at';

/** The time of the last Delete in a usage folder, or null when there was none. */
export function deletedAt(dir: string): number | null {
  try {
    const t = Number(readFileSync(join(dir, DELETE_MARKER), 'utf8').trim());
    return Number.isSafeInteger(t) && t > 0 ? t : null;
  } catch { return null; }
}

/** Monday 00:00 UTC of ISO week `week` of `year`. */
function isoWeekStart(year: number, week: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * 86_400_000;
  return week1 + (week - 1) * 7 * 86_400_000;
}

export const VIEWS = [
  ...['terminal', 'floor', 'tasks', 'human', 'triggers', 'trigger-history', 'memory', 'graph', 'activity', 'skills', 'workers']
    .map((tab) => `command-center:${tab}`),
  'agent-detail', 'agent-detail:terminal', 'agent-detail:git', 'agent-detail:messages', 'agent-detail:traces',
  'settings', 'memory', 'task-detail', 'terminal-fullscreen'
];

type FieldType = 'view' | 'id' | 'agent' | 'card' | 'askKey' | 'count' | 'bool' | 'classes' | { oneOf: readonly string[] };

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
  'ask-shown': { askKey: 'askKey', ageMs: 'count', surface: { oneOf: ['ask-me'] } },
  'ask-submitted': {
    askKey: 'askKey', msSinceShown: 'count', answerLen: 'count',
    answerShape: { oneOf: ['done-ack', 'option', 'short', 'sentence', 'long'] },
    surface: { oneOf: ['ask-me'] }
  },
  'app-focus': { state: { oneOf: ['focus', 'blur'] } },
  // The scoped-write-roots dry run (writeRoots.ts): path classes only, never a path.
  'write-roots': {
    agentId: 'agent', provider: { oneOf: PROVIDERS }, role: { oneOf: ['god', 'agent'] },
    source: { oneOf: ['claude-settings-files', 'codex-config', 'none'] }, start: { oneOf: START_SOURCES }, ordinal: 'count', coalesced: 'count',
    effective: 'classes', excess: 'classes', unknownWhy: { oneOf: ['app-hooks-differ'] }
  },
  'write-would-refuse': { agentId: 'agent', tool: { oneOf: LOG_TOOLS }, via: { oneOf: VIAS }, pathClass: { oneOf: PATH_CLASSES } },
  'write-own-settings': { agentId: 'agent', tool: { oneOf: LOG_TOOLS }, via: { oneOf: VIAS } },
  'write-observed': { agentId: 'agent', tool: { oneOf: LOG_TOOLS }, shape: { oneOf: SHAPES }, count: 'count' },
  'write-incomplete': { agentId: 'agent', state: { oneOf: ['incomplete'] }, reason: { oneOf: ['queue', 'cap', 'session-start-flood', 'quit', 'log-refused', 'no-agent'] }, shed: 'count', burst: 'bool' }
};
/** Fields a kind cannot be written without. */
const REQUIRED: Record<string, string[]> = {
  'ui-view': ['view'], 'ui-view-end': ['view', 'dwellMs'], 'ask-shown': ['askKey', 'surface'],
  'ask-submitted': ['askKey', 'surface', 'answerLen', 'answerShape'], 'app-focus': ['state'],
  'write-roots': ['agentId', 'provider', 'role', 'source', 'effective', 'excess'],
  'write-would-refuse': ['agentId', 'tool', 'via', 'pathClass'], 'write-own-settings': ['agentId', 'tool', 'via'],
  'write-observed': ['agentId', 'tool', 'shape', 'count'],
  'write-incomplete': ['agentId', 'state', 'reason', 'shed', 'burst']
};

function valid(type: FieldType, v: unknown, known: KnownIds): boolean {
  if (type === 'view') return typeof v === 'string' && (VIEWS as readonly string[]).includes(v);
  if (type === 'agent') return typeof v === 'string' && known.isAgent(v);
  if (type === 'card') return typeof v === 'string' && known.isCard(v);
  if (type === 'askKey') {
    const m = typeof v === 'string' ? ASK_KEY.exec(v) : null;
    if (!m) return false;
    const t = Date.parse(m[2]);
    return Number.isFinite(t) && new Date(t).toISOString() === m[2] && known.isCard(m[1]);
  }
  if (type === 'id') return typeof v === 'string' && ID.test(v);
  if (type === 'count') return Number.isSafeInteger(v) && (v as number) >= 0;
  if (type === 'bool') return typeof v === 'boolean';
  if (type === 'classes') return Array.isArray(v) && v.length <= PATH_CLASSES.length && v.every((x) => typeof x === 'string' && (PATH_CLASSES as readonly string[]).includes(x));
  return typeof v === 'string' && type.oneOf.includes(v);
}

/** The allowlisted copy of an event, or null when it must not be written. */
export function sanitize(event: Record<string, unknown>, known: KnownIds = NONE): Record<string, unknown> | null {
  const kind = typeof event.kind === 'string' ? event.kind : '';
  if (!Object.hasOwn(EVENTS, kind)) return null;
  const fields = EVENTS[kind];
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
  for (const k of Object.hasOwn(REQUIRED, kind) ? REQUIRED[kind] : []) if (!(k in out)) return null;
  return out;
}

export interface UsageLogDeps {
  /** The usage folder in the app's own data folder (<userData>/usage). */
  dir: () => string | null;
  enabled: () => boolean;
  now?: () => number;
  /** True for an id on the agent roster. */
  isAgent?: (id: string) => boolean;
  /** True for a card id in the current tasks.json. */
  isCard?: (id: string) => boolean;
  /** For the write-roots dry run's rows (kinds starting write-): true for an id the app itself spawned, held in memory.
   *  Those rows never depend on registry.json, which every agent can write. */
  isWriteAgent?: (id: string) => boolean;
}

export class UsageLog {
  constructor(private readonly d: UsageLogDeps) {}

  private now(): number { return (this.d.now ?? Date.now)(); }

  /** The usage folder, created private when asked to; null when unavailable. */
  private dir(create: boolean): string | null {
    const dir = this.d.dir();
    if (!dir) return null;
    if (!create) return dir;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700); return dir; } catch { return null; }
  }

  /** Append one event if the log is on and the event passes the allowlist. */
  record(event: Record<string, unknown>): boolean {
    // Total over any input: bad input is refused, never thrown.
    try { return this.write(event); } catch { return false; }
  }

  private write(event: Record<string, unknown>): boolean {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    if (!this.d.enabled()) return false;
    const writeRow = typeof event.kind === 'string' && event.kind.startsWith('write-') && this.d.isWriteAgent !== undefined;
    const isAgent = writeRow ? (id: string) => this.d.isWriteAgent!(id) : (id: string) => this.d.isAgent?.(id) ?? false;
    const clean = sanitize(event, { isAgent, isCard: (id) => this.d.isCard?.(id) ?? false });
    if (!clean) return false;
    const dir = this.dir(true);
    if (!dir) return false;
    const ts = this.now();
    const file = join(dir, `${new Date(ts).toISOString().slice(0, 10)}.jsonl`);
    try {
      appendFileSync(file, JSON.stringify({ ts, v: SCHEMA, ...clean }) + '\n', { mode: 0o600 });
      return true;
    } catch { return false; }
  }

  /** Remove daily files and digests older than RETENTION_DAYS; returns how many were removed. */
  prune(): number {
    const dir = this.dir(false);
    if (!dir) return 0;
    const cutoff = new Date(this.now() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10);
    let removed = 0;
    let names: string[];
    try { names = readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      const m = DAY_FILE.exec(name);
      const d = DIGEST_FILE.exec(name);
      // A digest goes once its whole week is older than the window.
      const old = (m && m[1] < cutoff) || (d && new Date(isoWeekStart(Number(d[1]), Number(d[2])) + 7 * 86_400_000).toISOString().slice(0, 10) < cutoff);
      if (old) { try { rmSync(join(dir, name)); removed++; } catch { /* keep going */ } }
    }
    return removed;
  }

  /**
   * Delete every daily usage file and weekly digest (the Settings button) and
   * record when, so no digest is rebuilt for a week that started before now.
   * Any other file in the folder is left alone. Returns how many were removed.
   */
  deleteAll(): number {
    const dir = this.dir(true);
    if (!dir) return 0;
    try { writeFileSync(join(dir, DELETE_MARKER), String(this.now()), { mode: 0o600 }); } catch { /* still delete */ }
    let removed = 0;
    let names: string[];
    try { names = readdirSync(dir); } catch { return 0; }
    for (const name of names) {
      if (DAY_FILE.test(name) || DIGEST_FILE.test(name)) { try { rmSync(join(dir, name)); removed++; } catch { /* keep going */ } }
    }
    return removed;
  }
}

/**
 * The renderer's usage:event payload, recorded with the fields only the main
 * process may set (session, window, focus). Any bad payload is refused: this
 * never throws.
 */
export function recordFromRenderer(
  log: UsageLog,
  event: unknown,
  ctx: { session: string; win: number; focused: boolean }
): boolean {
  try {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
    return log.record({ ...(event as Record<string, unknown>), session: ctx.session, win: ctx.win, focused: ctx.focused });
  } catch { return false; }
}
