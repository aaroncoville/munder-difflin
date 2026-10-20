/**
 * Whether a PTY that just died should be launched once more before its agent
 * is archived, as a pure decision so it can be unit-tested off-process.
 *
 * On 2026-10-20 the god agent's `claude` died 444 ms after the app-start
 * spawn with node-pty's own "execvp(3) failed.: Permission denied" as the
 * entire output: the CLI binary was not executable at that instant (its npm
 * package was mid-reinstall), the command resolver had fallen back to the
 * bare name, and the exec failed. The exit handler archived god, which takes
 * the whole floor down with it; the next app start, minutes later, spawned
 * fine. A process that is gone this soon after launch never ran a turn, so
 * one retry after a short delay costs nothing and saves the floor whenever
 * the cause was transient.
 */

export const SPAWN_RETRY_LOG_KIND = 'spawn-retry';

/** A process gone this soon after launch never got as far as its first turn. */
export const SPAWN_RETRY_WINDOW_MS = 2_000;

/** How long the retry waits. Long enough for a chmod or a file rename to land,
 *  short enough that a floor is not left headless for a noticeable time. */
export const SPAWN_RETRY_DELAY_MS = 5_000;

/** node-pty's own messages for an exec that never started the target: the
 *  unix fork path (`execvp(3) failed.`) and the macOS spawn-helper path
 *  (`posix_spawnp failed.`). Either means the CLI itself never ran, however
 *  long the PTY lived. */
const EXEC_FAILURE_RE = /execvp\(3\) failed|posix_spawnp? failed/i;

export type SpawnRetryReason = 'exec-failed' | 'early-exit';

export interface SpawnExitInput {
  exitCode?: number;
  signal?: number;
  /** ms between the spawn and the exit. */
  uptimeMs?: number;
  /** The last bytes the process printed before dying. */
  tail?: string;
  /** True once this launch has already had its one retry. */
  alreadyRetried: boolean;
}

/** The reason to retry, or null to let the normal teardown run. */
export function spawnRetryReason(x: SpawnExitInput): SpawnRetryReason | null {
  // One retry per launch, never a loop.
  if (x.alreadyRetried) return null;
  // A signal means somebody (or the kernel) chose this death; not ours to undo.
  if (typeof x.signal === 'number' && x.signal !== 0) return null;
  // A clean finish, or one we know nothing about, is not a failed launch.
  if (typeof x.exitCode !== 'number' || x.exitCode === 0) return null;
  if (typeof x.tail === 'string' && EXEC_FAILURE_RE.test(x.tail)) return 'exec-failed';
  if (typeof x.uptimeMs === 'number' && x.uptimeMs >= 0 && x.uptimeMs < SPAWN_RETRY_WINDOW_MS) return 'early-exit';
  return null;
}
