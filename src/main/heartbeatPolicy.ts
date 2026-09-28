import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Pure re-engage decision for one heartbeat beat, extracted out of index.ts's
 * beat() so it can be tested directly (index.ts pulls in Electron and cannot
 * be evaluated outside the main process). Node builtins only, no Electron.
 */

export interface ReengageInputs {
  /** Unread, non-scheduler messages in god's inbox (see godActionableInboxCount
   *  in index.ts). Always wins: a worker's reply must never sit unread. */
  actionable: number;
  /** Whether the floor has gone quiet for at least the mission's
   *  quietThresholdMs (see isFloorQuiet in index.ts). */
  quiet: boolean;
  /** Count of tasks.json cards with status 'doing'. Only meaningful when
   *  `quiet` is true and `actionable` is 0 — see doingTaskCount below, whose
   *  read failures are deliberately biased so this is never a false zero. */
  doingCount: number;
  /** Heartbeat mission config knob (ScheduledMission.suppressWhenIdle,
   *  default true). true: a quiet floor with nothing 'doing' has nothing for
   *  god to review, so the beat does not re-engage. false: restores the
   *  original behaviour, where any quiet floor re-engages. */
  suppressWhenIdle: boolean;
}

/** Should this beat re-engage god? Real inbox mail always does. Otherwise: an
 *  active (non-quiet) floor never does. A quiet floor re-engages unless
 *  suppressWhenIdle is on AND nothing is 'doing' — a quiet floor with work in
 *  flight may be a stall worth waking god for; a quiet floor with nothing
 *  doing has nothing for god to do. */
export function shouldReengage(inputs: ReengageInputs): boolean {
  if (inputs.actionable > 0) return true;
  if (!inputs.quiet) return false;
  if (!inputs.suppressWhenIdle) return true;
  return inputs.doingCount > 0;
}

/** Count of tasks.json cards with status 'doing', read directly from
 *  `<root>/tasks.json`. A missing root, a missing file, unparsable JSON, or a
 *  `tasks` field that is not an array are all treated as "at least one doing
 *  card" (returns 1) rather than 0 — the read is only ever used to decide
 *  whether a quiet floor is safe to leave alone, so a ledger we cannot trust
 *  must fail toward waking god, never toward silence. An empty-but-valid
 *  tasks array is a genuine, trustworthy zero. */
export function doingTaskCount(root: string | null): number {
  if (!root) return 1;
  try {
    const raw = readFileSync(join(root, 'tasks.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!Array.isArray(parsed?.tasks)) return 1;
    return parsed.tasks.filter((t: { status?: unknown }) => t && t.status === 'doing').length;
  } catch {
    return 1;
  }
}
