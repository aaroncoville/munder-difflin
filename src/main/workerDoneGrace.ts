import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** How long a worker that reported done stays reachable before it is released.
 *  The orchestrator often answers a report with a follow-up; a worker released at
 *  once was already archived when that follow-up arrived, so it bounced. */
export const WORKER_DONE_GRACE_MS = 3 * 60_000;

/** Did the orchestrator ask this worker something after its done? Scans the inbox
 *  and inbox/.done, since the worker may already have filed the message. Only a
 *  request or query counts: an inform expects no answer, so no further done would
 *  follow it and the worker would hold its slot until the idle reaper. Dated by
 *  file mtime, which is when the message arrived; `created_at` is whatever the
 *  sender wrote. Filing a message under .done renames it, so the mtime survives. */
export function workerFollowUpAfter(inboxDir: string, orchestratorId: string, doneAt: number): boolean {
  for (const dir of [inboxDir, join(inboxDir, '.done')]) {
    if (!existsSync(dir)) continue;
    let files: string[];
    try { files = readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const fp = join(dir, f);
      try {
        if (statSync(fp).mtimeMs <= doneAt) continue;
        const msg = JSON.parse(readFileSync(fp, 'utf8')) as { from?: string; act?: string };
        if (msg.from === orchestratorId && (msg.act === 'request' || msg.act === 'query')) return true;
      } catch { /* unreadable or half-written: not a follow-up yet */ }
    }
  }
  return false;
}

/** What a worker's newest done means now: `keep` it inside the window, it was
 *  `reengaged` by a follow-up (that done is spent; its next done opens a new
 *  window), or `release` it. A done dated in the future releases: a kept worker
 *  skips the idle reaper, so a clock change must not hold it until time catches up. */
export function afterWorkerDone(inboxDir: string, orchestratorId: string, doneAt: number, now: number): 'keep' | 'reengaged' | 'release' {
  if (workerFollowUpAfter(inboxDir, orchestratorId, doneAt)) return 'reengaged';
  const elapsed = now - doneAt;
  return elapsed >= 0 && elapsed < WORKER_DONE_GRACE_MS ? 'keep' : 'release';
}
