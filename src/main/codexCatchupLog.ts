import Database from 'better-sqlite3';
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
 */

const CATCHUP_PROMPT = 'Write a brief catch-up for a user returning to this Codex task';

// `ts` is indexed. The window is the day up to `now`: bounded below to keep the
// scan short, and above so a skewed clock cannot report a turn from its future.
const LAST_CATCHUP_SQL =
  "SELECT max(ts) AS ts FROM logs WHERE ts > ? AND ts <= ? AND target = 'codex_core::session::handlers' AND feedback_log_body LIKE ?";

const LOOKBACK_S = 24 * 3600;

/** Millisecond timestamp of the latest catch-up summary, or null if unknown. */
export function lastCatchupAt(codexHome: string, now = Date.now()): number | null {
  let db: Database.Database | null = null;
  try {
    // Read-only, and a short busy timeout: this runs on the main process, which
    // must never wait on a database another process is writing.
    db = new Database(join(codexHome, 'logs_2.sqlite'), { readonly: true, fileMustExist: true, timeout: 50 });
    const nowS = Math.floor(now / 1000);
    const row = db.prepare(LAST_CATCHUP_SQL).get(nowS - LOOKBACK_S, nowS, `%${CATCHUP_PROMPT}%`) as
      { ts: number | null } | undefined;
    return row && typeof row.ts === 'number' ? row.ts * 1000 : null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}
