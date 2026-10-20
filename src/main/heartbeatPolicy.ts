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
  /** Count of tasks.json cards with status 'doing' that are not stale. Only
   *  meaningful when `quiet` is true and `actionable` is 0 — see doingTaskTally
   *  below, whose read failures are deliberately biased so this is never a
   *  false zero. */
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

/** A 'doing' card whose last update (updatedAt, else createdAt) is older than
 *  this no longer counts as work in flight. A card left in 'doing' after its
 *  worker went away would otherwise keep a quiet floor re-engaging god on
 *  every beat, all night. */
export const STALE_DOING_MS = 12 * 60 * 60 * 1000;

/** 'doing' cards split by age: `fresh` were updated within STALE_DOING_MS,
 *  `stale` were not. */
export interface DoingTally {
  fresh: number;
  stale: number;
}

/** Tally of tasks.json cards with status 'doing', read directly from
 *  `<root>/tasks.json`. A missing root, a missing file, unparsable JSON, or a
 *  `tasks` field that is not an array are all treated as "one fresh doing
 *  card" rather than none — the read is only ever used to decide whether a
 *  quiet floor is safe to leave alone, so a ledger we cannot trust must fail
 *  toward waking god, never toward silence. For the same reason a card whose
 *  timestamps are missing or unparsable counts as fresh. An empty-but-valid
 *  tasks array is a genuine, trustworthy zero. */
export function doingTaskTally(root: string | null, now: number = Date.now()): DoingTally {
  const untrusted = { fresh: 1, stale: 0 };
  if (!root) return untrusted;
  try {
    const raw = readFileSync(join(root, 'tasks.json'), 'utf8');
    const parsed = JSON.parse(raw) as { tasks?: unknown };
    if (!Array.isArray(parsed?.tasks)) return untrusted;
    const tally = { fresh: 0, stale: 0 };
    for (const t of parsed.tasks as Array<{ status?: unknown; updatedAt?: unknown; createdAt?: unknown }>) {
      if (!t || t.status !== 'doing') continue;
      const at = Date.parse(String(t.updatedAt ?? t.createdAt ?? ''));
      if (Number.isFinite(at) && now - at > STALE_DOING_MS) tally.stale++;
      else tally.fresh++;
    }
    return tally;
  } catch {
    return untrusted;
  }
}

/** Count of 'doing' cards that still count as work in flight (see
 *  doingTaskTally). */
export function doingTaskCount(root: string | null, now: number = Date.now()): number {
  return doingTaskTally(root, now).fresh;
}

/** Log reason for a quiet beat that did not re-engage. Stale 'doing' cards get
 *  their own reason so quiet-no-doing-cards keeps meaning nothing was doing. */
export function suppressionReason(tally: DoingTally): string {
  return tally.stale > 0 ? 'quiet-stale-doing-cards' : 'quiet-no-doing-cards';
}
