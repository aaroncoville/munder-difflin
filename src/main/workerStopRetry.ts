/** When a worker's kill keeps failing, how often to try again and when to say so.
 *
 *  Retries back off but never stop: the worker's record is the only thing that can
 *  still stop a process that may be alive, and it has to outlast any retry limit. */

export const STOP_RETRY_FIRST_MS = 3_000;
export const STOP_RETRY_MAX_MS = 5 * 60_000;
/** Also how long a kill must keep failing before the first notice, so a failure
 *  that clears on a retry does not raise an alarm. The period restarts only when a
 *  notice is delivered: the registry being unreadable, which can be why the worker
 *  is being stopped at all, must not use one up. */
export const STUCK_NOTICE_EVERY_MS = 15 * 60_000;

export interface StopRetry {
  failures: number;
  firstFailedAt: number;
  nextAttemptAt: number;
  lastNoticeAt: number;
}

export function stopFailedAgain(previous: StopRetry | undefined, now: number): { retry: StopRetry; notify: boolean } {
  const failures = (previous?.failures ?? 0) + 1;
  const firstFailedAt = previous?.firstFailedAt ?? now;
  const lastNoticeAt = previous?.lastNoticeAt ?? firstFailedAt;
  const notify = now - lastNoticeAt >= STUCK_NOTICE_EVERY_MS;
  const delay = Math.min(STOP_RETRY_FIRST_MS * 2 ** (failures - 1), STOP_RETRY_MAX_MS);
  return {
    retry: { failures, firstFailedAt, nextAttemptAt: now + delay, lastNoticeAt },
    notify
  };
}

export function noticeDelivered(retry: StopRetry, now: number): StopRetry {
  return { ...retry, lastNoticeAt: now };
}

export function stopRetryDue(retry: StopRetry | undefined, now: number): boolean {
  return !retry || now >= retry.nextAttemptAt;
}

export function stuckWorkerNotice(workerId: string, pid: number | undefined, retry: StopRetry, now: number): { subject: string; body: string } {
  const minutes = Math.round((now - retry.firstFailedAt) / 60_000);
  return {
    subject: `[worker stuck] ${workerId} could not be stopped`,
    body: `Killing worker ${workerId} (pid ${pid ?? 'unknown'}) has failed ${retry.failures} times over ${minutes} minutes. `
      + 'It still holds a worker slot. Retries continue, and it is cleaned up as soon as a kill works or its process exits. '
      + 'If this does not clear, the process needs stopping by hand.'
  };
}
