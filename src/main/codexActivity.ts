import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Last-activity time for a Codex worker, read from its own session records.
 *
 * The fleet snapshot normally dates an agent's last activity from its latest
 * OpenTelemetry sample, but only Claude Code is given the telemetry
 * environment, so a Codex worker never has one and read as "no activity yet"
 * for its whole life. Codex does record every turn itself: one rollout per
 * session under `$CODEX_HOME/sessions/YYYY/MM/DD/`, appended on each turn, tool
 * call and token count. Its modification time is the Codex equivalent of the
 * last telemetry sample.
 *
 * The newest FILE wins, not the newest day directory: a resumed session keeps
 * appending to the rollout it was created in, so the live file is routinely
 * filed under an older day.
 */

const ROLLOUT_FILE = /^rollout-.*\.jsonl$/;
/** The session a rollout belongs to: Codex ends every rollout name with its id. */
const ROLLOUT_SESSION = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** Which rollouts count, by session id (lower case): only some sessions', or
 *  all but some sessions'. */
export interface RolloutFilter {
  only?: ReadonlySet<string>;
  exclude?: ReadonlySet<string>;
}

function counts(name: string, filter: RolloutFilter): boolean {
  if (!ROLLOUT_FILE.test(name)) return false;
  const session = ROLLOUT_SESSION.exec(name)?.[1]?.toLowerCase();
  if (filter.only) return session !== undefined && filter.only.has(session);
  return !(session && filter.exclude?.has(session));
}

/** `sessions/YYYY/MM/DD/` — deep enough for Codex's layout, and bounded so an
 *  unexpected tree can never turn a timer tick into an unbounded walk. */
const MAX_DEPTH = 4;

function newestRolloutIn(dir: string, depth: number, filter: RolloutFilter): number | null {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  let newest: number | null = null;
  for (const name of entries) {
    let at: number | null = null;
    try {
      // statSync, not lstatSync: a link inside the tree must read as the
      // directory it points at. (The link the hive places AT `sessions`, into
      // Codex's global scan root, is already followed by readdirSync.)
      const st = statSync(join(dir, name));
      if (st.isDirectory()) at = depth < MAX_DEPTH ? newestRolloutIn(join(dir, name), depth + 1, filter) : null;
      else if (counts(name, filter)) at = st.mtimeMs;
    } catch { /* removed mid-walk — not activity */ }
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** Modification time (ms) of the newest rollout under this Codex home that the
 *  filter admits, or null when there is none. Reads `sessions` unless told to
 *  read `archived_sessions`, the other tree the hive keeps. Never throws. */
export function newestRolloutAt(
  codexHome: string,
  filter: RolloutFilter = {},
  tree: 'sessions' | 'archived_sessions' = 'sessions'
): number | null {
  return newestRolloutIn(join(codexHome, tree), 1, filter);
}

/** When an agent was last active, for the fleet snapshot: its telemetry sample
 *  when it reports one, otherwise — for Codex only — what its own rollouts say.
 *  The disk is only read for Codex. Any other provider without telemetry stays
 *  unknown rather than being guessed at. */
export function fleetLastActiveAt(
  provider: string | undefined,
  usageTs: number | undefined,
  codexActiveAt: () => number | null
): number | null {
  if (typeof usageTs === 'number') return usageTs;
  return provider === 'codex' ? codexActiveAt() : null;
}

/**
 * Where each Codex worker runs, and which sessions are whose.
 *
 * A worker's CODEX_HOME is the one named after it unless a resume pointed it
 * at the home that owns the resumed session; that home is then shared, and its
 * rollouts have to be told apart by session. A worker owns the session it
 * resumed, and every session its hooks report after that — a `/new` in the
 * running process starts one. Ownership is kept rather than replaced, so a
 * worker's earlier sessions are never handed to anyone else.
 *
 * The one place that answers "which home, which rollouts" for a Codex worker.
 */
export class CodexHomes {
  /** agentId → the home its Codex process was spawned with, and whether a
   *  resume put it there. */
  private homes = new Map<string, { home: string; redirected: boolean }>();
  /** session id (lower case) → the agent that owns it. */
  private owners = new Map<string, string>();

  /** Record a worker's home at spawn, once any resume has settled CODEX_HOME.
   *  A resume hands the resumed session to this worker, whoever ran it before. */
  recordSpawn(agentId: string, codexHome: string | undefined, resumedSession?: string): void {
    if (!codexHome) {
      this.homes.delete(agentId);
      return;
    }
    this.homes.set(agentId, { home: codexHome, redirected: !!resumedSession });
    if (resumedSession) this.owners.set(resumedSession.toLowerCase(), agentId);
  }

  /** A session the worker is known to run: its hooks reported it. A session
   *  that already has an owner keeps it, so a stale report cannot take it back. */
  noteSession(agentId: string, sessionId: string | null | undefined): void {
    if (!sessionId) return;
    const id = sessionId.toLowerCase();
    if (!this.owners.has(id)) this.owners.set(id, agentId);
  }

  /** The CODEX_HOME the worker actually runs in, else the one named after it. */
  homeOf(agentId: string, nominalHome: string | null): string | null {
    return this.homes.get(agentId)?.home ?? nominalHome;
  }

  /** Which of its home's rollouts are this worker's. A worker that a resume put
   *  in another agent's home reads only the sessions it owns there; anyone else
   *  reads everything except the sessions other workers own. A session nobody
   *  has reported stays with the home's own worker. */
  filterFor(agentId: string): RolloutFilter {
    const mine = new Set<string>();
    const others = new Set<string>();
    for (const [session, owner] of this.owners) (owner === agentId ? mine : others).add(session);
    return this.homes.get(agentId)?.redirected ? { only: mine } : { exclude: others };
  }
}

/** How many distinct Codex sessions to remember per agent. The fleet snapshot
 *  learns ownership from this list, so it must retain every session reported
 *  between two snapshots. A worker reports nowhere near this many in one 8 s
 *  tick, and CodexHomes keeps ownership once learned, so a bound this size can
 *  never lose a transition. */
export const SESSION_HISTORY_CAP = 50;

/** Append a newly reported session id to an agent's durable session list —
 *  most-recent last, no duplicates, capped to the last SESSION_HISTORY_CAP.
 *  Recording EVERY reported session (not just the latest) is what lets the fleet
 *  snapshot attribute a session that changed twice between two ticks: sampling
 *  only the latest id at snapshot time credited the missed intermediate session
 *  to the home owner instead of the worker that ran it. */
export function appendSession(
  list: readonly string[] | undefined,
  sessionId: string,
  cap = SESSION_HISTORY_CAP
): string[] {
  const next = (list ?? []).filter((s) => s !== sessionId);
  next.push(sessionId);
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * A Codex worker's last activity, from the rollouts that are its own (see
 * CodexHomes). With no live rollout, archived history is the last activity. A
 * future mtime (a copied or restored file, a skewed clock) reads as now, never
 * as a negative age. With a cache, a history is walked at most once per its ttl.
 */
export function codexAgentActiveAt(
  agentId: string,
  homes: CodexHomes,
  nominalHome: string | null,
  now: number,
  cache?: ReadingCache<number | null>
): number | null {
  const home = homes.homeOf(agentId, nominalHome);
  if (!home) return null;
  const filter = homes.filterFor(agentId);
  const read = (): number | null =>
    newestRolloutAt(home, filter) ?? newestRolloutAt(home, filter, 'archived_sessions');
  const sessions = filter.only
    ? `only:${[...filter.only].sort().join(',')}`
    : `exclude:${[...(filter.exclude ?? [])].sort().join(',')}`;
  const at = cache ? cache.read(`${home}\n${sessions}`, now, read) : read();
  return at === null ? null : Math.min(at, now);
}

/** How long a worker's walked history is reused. Measured: ~60 µs per walk for
 *  a one-rollout home, 23.9 ms for three years of daily
 *  sessions (2,190 rollouts in 1,095 day folders) — synchronous, on the main
 *  process, and the snapshot runs every 8 s. A resumed session's growing file
 *  is still seen: on the first snapshot at or after this long, so about every
 *  32 s at the 8 s cadence, and later if the event loop is busy. */
export const CODEX_ACTIVITY_TTL_MS = 30_000;

/** Remembers each key's reading for ttlMs, so a timer that asks every few
 *  seconds does the expensive read at most once per ttlMs. */
export class ReadingCache<T> {
  private readings = new Map<string, { at: number; value: T }>();

  constructor(private readonly ttlMs: number) {}

  read(key: string, now: number, compute: () => T): T {
    const hit = this.readings.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = compute();
    this.readings.set(key, { at: now, value });
    return value;
  }
}

/** The Codex readings attached to a stalled-wake log line: how long since the
 *  session last recorded anything, how long since Codex last ran its own
 *  catch-up summary turn, and whether that turn fell inside the last watchdog
 *  beat. A reading that could not be taken stays null. */
export function codexStallFacts(
  rolloutAt: number | null,
  catchupAt: number | null,
  now: number,
  beatMs: number
): { rolloutAgeMs: number | null; catchupAgoMs: number | null; catchupInLastBeat: boolean } {
  const catchupAgoMs = catchupAt === null ? null : now - catchupAt;
  return {
    rolloutAgeMs: rolloutAt === null ? null : now - rolloutAt,
    catchupAgoMs,
    catchupInLastBeat: catchupAgoMs !== null && catchupAgoMs >= 0 && catchupAgoMs < beatMs
  };
}

/** Readings for a stalled-wake line. Either may throw, which reads as unknown. */
export interface StallReaders {
  rolloutAt(agentId: string): number | null;
  catchupAt(home: string): number | null;
}

/** How long one beat may spend annotating its stall lines. The readings are
 *  synchronous, on the main process; once this is spent the rest are skipped. */
export const STALL_ENRICH_BUDGET_MS = 20;

/**
 * Attach Codex readings to the stall lines about to be written: how long ago
 * the worker's own sessions last recorded anything, and when Codex last ran its
 * own catch-up summary. Only stall lines (they carry `quietMs`) of workers that
 * `codexHomeOf` finds a home for are read; the end of a stall, or a worker that
 * does not run Codex, is written as it is. Once the budget is spent, remaining
 * lines say the reading was skipped instead of taking it.
 */
export function enrichStallLines<L extends { agentId: string }>(
  lines: readonly L[],
  codexHomeOf: (agentId: string) => string | null,
  read: StallReaders,
  now: number,
  beatMs: number,
  budget: { elapsed(): number; limitMs: number }
): Array<L & { codex?: ReturnType<typeof codexStallFacts> | { skipped: 'budget' } }> {
  const attempt = (fn: () => number | null): number | null => {
    try { return fn(); } catch { return null; }
  };
  const exhausted = (): boolean => budget.elapsed() >= budget.limitMs;
  return lines.map((line) => {
    if (!('quietMs' in line)) return line;
    const home = codexHomeOf(line.agentId);
    if (!home) return line;
    // The budget is checked before EACH reader, not just before the line: one
    // slow reader must not let the next start and run unbounded on top of it.
    if (exhausted()) return { ...line, codex: { skipped: 'budget' as const } };
    const rolloutAt = attempt(() => read.rolloutAt(line.agentId));
    if (exhausted()) return { ...line, codex: { skipped: 'budget' as const } };
    const catchupAt = attempt(() => read.catchupAt(home));
    return { ...line, codex: codexStallFacts(rolloutAt, catchupAt, now, beatMs) };
  });
}
