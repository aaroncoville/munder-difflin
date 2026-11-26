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

/** Pauses between attempts at a busy ledger: about 1.5 s in all, plus each attempt's own short wait. */
export const TASK_WRITE_RETRY_DELAYS_MS: readonly number[] = [50, 100, 200, 400, 800];

export interface TaskWriteRetryOptions {
  /** The pause before each further attempt; one attempt is made per pause, after the first. */
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

/**
 * taskWriteResult for an async IPC handler, trying a busy ledger again.
 *
 * The app waits for tasks.json.lock only briefly, because that wait blocks the main thread. A holder that
 * keeps the lock a little longer (the hive command, a slow disk) would otherwise fail the user's edit. So
 * when an attempt finds the ledger busy, this pauses without blocking and tries again, up to the given
 * pauses, then answers with the busy error. A busy attempt wrote nothing, so trying again is safe. Any
 * other failure (an unreadable ledger, a lock taken away mid-update, a disk error) is answered at once.
 */
export async function taskWriteResultWithRetry(
  what: string,
  write: () => boolean,
  {
    delaysMs = TASK_WRITE_RETRY_DELAYS_MS,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log
  }: TaskWriteRetryOptions = {}
): Promise<TaskWriteResult> {
  for (const delay of delaysMs) {
    let ok: boolean;
    try {
      ok = write();
    } catch (e) {
      if (!(e instanceof TaskLedgerLockTimeout)) return taskWriteResult(what, () => { throw e; }, log);
      await sleep(delay);
      continue;
    }
    return { ok };
  }
  return taskWriteResult(what, write, log);
}

/** The most task-ledger writes from the window held at once, the one being written included. */
export const TASK_WRITE_QUEUE_LIMIT = 50;

/**
 * A queue for task-ledger writes from the window: each write, its retries included, finishes before the
 * next one starts.
 *
 * A write that finds the ledger busy pauses before trying again, and does not hold its place while it
 * pauses. Two edits of one card made in quick succession (a status move to "doing", then to "done") could
 * otherwise land in the wrong order: the first pauses, the second finds the ledger free and writes, then
 * the first writes over it, and both answer `{ ok: true }`. The IPC handlers share one queue so that the
 * ledger keeps the last edit the user made.
 *
 * Against a holder that keeps the lock, the queue must neither grow without bound nor spend a few seconds
 * of retries on every edit in turn, half of them blocking the main thread. So once a write gives up on a
 * busy ledger, the writes already queued behind it are answered with the same busy error without being
 * tried; writes made after that are tried as usual. And at most TASK_WRITE_QUEUE_LIMIT writes are held at
 * once: past that a write is answered busy at once and never runs.
 */
export function serialTaskWrites(): (what: string, write: () => boolean, options?: TaskWriteRetryOptions) => Promise<TaskWriteResult> {
  let tail: Promise<unknown> = Promise.resolve();
  let queued = 0;
  let held = 0;
  // The last write that gave up on a busy ledger: its answer, and how many writes had been queued by then.
  let gaveUp: { upTo: number; answer: TaskWriteResult } | null = null;
  return (what, write, options = {}) => {
    const log = options.log ?? ((line: string) => console.warn(line));
    if (held >= TASK_WRITE_QUEUE_LIMIT) {
      log(`[hive] ${what}: not tried, ${held} task edits are already waiting for the task ledger`);
      return Promise.resolve({ ok: false, error: `The task list is busy; try again in a moment. (${held} task edits are already waiting.)` });
    }
    held++;
    const position = ++queued;
    const run = async (): Promise<TaskWriteResult> => {
      if (gaveUp && position <= gaveUp.upTo) {
        log(`[hive] ${what}: not tried, the task ledger stayed busy for the edit before it`);
        return gaveUp.answer;
      }
      let busy = false;
      const answer = await taskWriteResultWithRetry(what, () => {
        try {
          const ok = write();
          busy = false;
          return ok;
        } catch (e) {
          busy = e instanceof TaskLedgerLockTimeout;
          throw e;
        }
      }, options);
      if (!answer.ok && busy) gaveUp = { upTo: queued, answer };
      return answer;
    };
    const result = tail.then(run).finally(() => { held--; });
    tail = result.catch(() => undefined);
    return result;
  };
}
