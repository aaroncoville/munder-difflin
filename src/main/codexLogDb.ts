import Database from 'better-sqlite3';
import type { OpenCodexLogDb } from './codexCatchupLog';

/** Opens a Codex debug log for lastCatchupAt: read-only, and with a short busy
 *  timeout, because the log belongs to another process and the main process
 *  must never wait on its locks. Kept apart from the query so that module still
 *  loads where this native module cannot. */
export const openCodexLogDb: OpenCodexLogDb = (file) =>
  new Database(file, { readonly: true, fileMustExist: true, timeout: 50 });
