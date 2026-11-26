import { TaskLedgerLockTimeout } from '../core/taskLedgerFile';

/** What the renderer's task IPC answers. */
export interface TaskWriteResult { ok: boolean; error?: string }

/**
 * Runs one task-ledger write for an IPC caller and answers `{ ok, error? }` whatever happens.
 *
 * The write can throw: another process holds tasks.json.lock past the app's short wait, the lock was
 * taken away mid-update, or tasks.json is unreadable and was left alone. Thrown through ipcMain.handle,
 * that reaches the renderer as a rejected invoke instead of the `{ ok: false, error }` the channel
 * promises. Each failure is logged once, naming the holder when the ledger was busy.
 */
export function taskWriteResult(
  what: string,
  write: () => boolean,
  log: (line: string) => void = (line) => console.warn(line)
): TaskWriteResult {
  try {
    return { ok: write() };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (e instanceof TaskLedgerLockTimeout) {
      log(`[hive] ${what}: the task ledger is busy: ${message}`);
      return { ok: false, error: `The task list is busy; try again in a moment. (${message})` };
    }
    log(`[hive] ${what} failed: ${message}`);
    return { ok: false, error: message };
  }
}
