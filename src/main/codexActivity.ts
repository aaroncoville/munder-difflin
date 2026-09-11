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

/** Which rollouts count: one session's only, or all but some sessions'. */
export interface RolloutFilter {
  only?: string;
  exclude?: ReadonlySet<string>;
}

function counts(name: string, filter: RolloutFilter): boolean {
  if (!ROLLOUT_FILE.test(name)) return false;
  const session = ROLLOUT_SESSION.exec(name)?.[1]?.toLowerCase();
  if (filter.only) return session === filter.only.toLowerCase();
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

/** Where a Codex worker actually runs: the CODEX_HOME it was spawned with and,
 *  when it resumed a session that another agent's home owns, that session. */
export interface CodexSessionRecord {
  home: string;
  session?: string;
}

/**
 * A Codex worker's last activity, from the rollouts that are its own.
 *
 * Resuming a session that another agent's home owns points the worker's
 * CODEX_HOME at that home, so its rollouts are not under the home named after
 * it. And a home can then be shared: the worker that was redirected into it
 * reads only the session it resumed there, while everyone else using the home
 * reads everything except the sessions others were redirected into.
 *
 * With no live rollout, archived history is the last activity. A future mtime
 * (a copied or restored file, a skewed clock) reads as now, never as a negative
 * age. With a cache, a history is walked at most once per its ttl.
 */
export function codexAgentActiveAt(
  agentId: string,
  records: ReadonlyMap<string, CodexSessionRecord>,
  nominalHome: string | null,
  now: number,
  cache?: ReadingCache<number | null>
): number | null {
  const own = records.get(agentId);
  const home = own?.home ?? nominalHome;
  if (!home) return null;
  const filter: RolloutFilter = own?.session
    ? { only: own.session }
    : {
      exclude: new Set(
        [...records]
          .filter(([id, r]) => id !== agentId && r.home === home && r.session)
          .map(([, r]) => (r.session as string).toLowerCase())
      )
    };
  const read = (): number | null =>
    newestRolloutAt(home, filter) ?? newestRolloutAt(home, filter, 'archived_sessions');
  const key = [home, filter.only ?? '', [...(filter.exclude ?? [])].sort().join(',')].join('\n');
  const at = cache ? cache.read(key, now, read) : read();
  return at === null ? null : Math.min(at, now);
}

/** How long a worker's walked history is reused. Measured: ~60 µs per walk for
 *  a one-rollout home, 23.9 ms for three years of daily
 *  sessions (2,190 rollouts in 1,095 day folders) — synchronous, on the main
 *  process, and the snapshot runs every 8 s. A resumed session's growing file
 *  is still seen, at most this late. */
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
