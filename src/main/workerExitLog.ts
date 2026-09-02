/**
 * The line an ephemeral worker leaves behind when its process quits without
 * being asked to.
 *
 * A worker that finishes and a worker that dies on its first instruction both
 * end at the same `kind: "archive"` line, so from the log alone they are the
 * same event. They are not: the second one usually means the worker was handed
 * a command line its CLI rejected, and the command line is the one thing no
 * other line in the log records.
 */
export const WORKER_EXIT_LOG_KIND = 'worker-exit';

/** The parts of a live-worker record this decision needs. */
export interface WorkerExitInput {
  workerId: string;
  /** Effective command LINE the worker was launched with, when known. */
  command?: string;
  spawnedAt: number;
  /** Set by every deliberate release — done-signal, idle reap, token cap. */
  releasing?: boolean;
}

export type WorkerExitEvent = {
  kind: typeof WORKER_EXIT_LOG_KIND;
  agentId: string;
  command?: string;
  uptimeMs: number;
  releasedOnPurpose: false;
};

/** The event to append, or null when this teardown was asked for and so is not
 *  news. Deliberate releases already have their own lines and their own reasons;
 *  duplicating them here would bury the exits nobody chose. */
export function workerExitEvent(rec: WorkerExitInput, now: number): WorkerExitEvent | null {
  if (rec.releasing) return null;
  return {
    kind: WORKER_EXIT_LOG_KIND,
    agentId: rec.workerId,
    command: rec.command,
    // Clamped: a machine that slept or had its clock stepped must not produce a
    // negative lifetime that reads as a corrupt record.
    uptimeMs: Math.max(0, now - rec.spawnedAt),
    releasedOnPurpose: false
  };
}
