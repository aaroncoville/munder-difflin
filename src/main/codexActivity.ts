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

/** `sessions/YYYY/MM/DD/` — deep enough for Codex's layout, and bounded so an
 *  unexpected tree can never turn a timer tick into an unbounded walk. */
const MAX_DEPTH = 4;

function newestRolloutIn(dir: string, depth: number): number | null {
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
      if (st.isDirectory()) at = depth < MAX_DEPTH ? newestRolloutIn(join(dir, name), depth + 1) : null;
      else if (ROLLOUT_FILE.test(name)) at = st.mtimeMs;
    } catch { /* removed mid-walk — not activity */ }
    if (at !== null && (newest === null || at > newest)) newest = at;
  }
  return newest;
}

/** Modification time (ms) of the newest rollout under this Codex home, or null
 *  when it has none. Never throws. */
export function newestRolloutAt(codexHome: string): number | null {
  return newestRolloutIn(join(codexHome, 'sessions'), 1);
}

/** When an agent was last active, for the fleet snapshot: its telemetry sample
 *  when it reports one, otherwise — for Codex only — its newest rollout. Any
 *  other provider without telemetry stays unknown rather than being guessed at. */
export function fleetLastActiveAt(
  provider: string | undefined,
  usageTs: number | undefined,
  codexHome: string | null
): number | null {
  if (typeof usageTs === 'number') return usageTs;
  if (provider !== 'codex' || !codexHome) return null;
  return newestRolloutAt(codexHome);
}
