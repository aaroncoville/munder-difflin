import { join } from 'node:path';

/**
 * When Codex last ran its own "catch-up summary" turn for this home.
 *
 * A few minutes after a turn completes, Codex submits a turn of its own on a
 * fresh thread, asking the model to summarise the task for a user returning to
 * it. Nothing about it reaches the session rollout; the only record is Codex's
 * debug log, `$CODEX_HOME/logs_2.sqlite`, where the submission carries the fixed
 * prompt below. Reading it lets a stalled wake be lined up against that turn.
 *
 * This is Codex's internal log, not an interface: its table, its levels and its
 * wording can change in any release. So every failure — no file, a locked or
 * reshaped database, a different prompt — reads as "unknown" (null), never as
 * an error. Only used to annotate a diagnostic line.
 *
 * The database is reached through `open`, which the caller supplies: the real
 * opener is a native module built for Electron, and taking it as a parameter
 * keeps this query and its failure handling testable without it.
 */

/** The part of a SQLite handle this needs. */
export interface CodexLogDb {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

export type OpenCodexLogDb = (file: string) => CodexLogDb;

const CATCHUP_PROMPT = 'Write a brief catch-up for a user returning to this Codex task';

/** How many of the log's newest rows one read may scan. A working agent's
 *  Codex writes a few thousand debug rows a day, so this reaches back about a
 *  day. It is what bounds a read: a time window alone does not, on a busy log. */
export const CATCHUP_ROW_BOUND = 5_000;

// The newest rows by rowid drive the scan. `+ts` keeps SQLite from answering
// max(ts) by walking the timestamp index instead, a walk that covers the whole
// log when nothing matches. The window up to `now` still decides what counts.
const LAST_CATCHUP_SQL =
  'SELECT max(+ts) AS ts FROM logs WHERE rowid > (SELECT max(rowid) FROM logs) - ? '
  + "AND +ts > ? AND +ts <= ? AND target = 'codex_core::session::handlers' AND feedback_log_body LIKE ?";

const LOOKBACK_S = 24 * 3600;

/** Millisecond timestamp of the latest catch-up summary, or null if unknown. */
export function lastCatchupAt(codexHome: string, now: number, open: OpenCodexLogDb): number | null {
  let db: CodexLogDb | null = null;
  try {
    db = open(join(codexHome, 'logs_2.sqlite'));
    const nowS = Math.floor(now / 1000);
    const row = db.prepare(LAST_CATCHUP_SQL).get(CATCHUP_ROW_BOUND, nowS - LOOKBACK_S, nowS, `%${CATCHUP_PROMPT}%`) as
      { ts?: number | null } | undefined;
    return row && typeof row.ts === 'number' ? row.ts * 1000 : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
