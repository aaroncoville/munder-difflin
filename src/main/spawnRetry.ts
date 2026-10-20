/**
 * One retry for an agent PTY that dies before it gets going, kept apart from
 * index.ts so the decision AND the timer/owner/teardown path are unit-tested.
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
import type { SpawnOptions } from './pty';

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

/** Exit codes that mean a person ended the process: 130 (SIGINT, Ctrl-C),
 *  143 (SIGTERM) and 2 (the CLI's own "interrupted" exit). */
const USER_EXIT_CODES = new Set([2, 130, 143]);

export type SpawnRetryReason = 'exec-failed' | 'early-exit';

export interface SpawnExitInput {
  exitCode?: number;
  signal?: number;
  /** ms between the spawn and the exit. */
  uptimeMs?: number;
  /** The last bytes the process printed before dying. */
  tail?: string;
  /** True when anything was written to the PTY before it exited: a person
   *  (or the harness) was already talking to it, so its death is not a
   *  launch that never got going. */
  hadInput?: boolean;
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
  // A person ended it (Ctrl-C and friends), or had already typed into it.
  if (USER_EXIT_CODES.has(x.exitCode)) return null;
  if (x.hadInput) return null;
  if (typeof x.tail === 'string' && EXEC_FAILURE_RE.test(x.tail)) return 'exec-failed';
  if (typeof x.uptimeMs === 'number' && x.uptimeMs >= 0 && x.uptimeMs < SPAWN_RETRY_WINDOW_MS) return 'early-exit';
  return null;
}

/** The slice of Electron's WebContents the retry needs. */
export interface RetryWebContents {
  isDestroyed(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

export interface SpawnRetryDeps {
  /** The PTY manager's spawn, verbatim. */
  spawn(opts: SpawnOptions, owner: RetryWebContents | null): { ok: boolean; error?: string };
  /** Is a PTY with this id alive right now? */
  isLive(id: string): boolean;
  /** The sink the PTY manager routes an owner-less session's output to (its
   *  attached webContents): the same object decides whether such a session
   *  still has a window and receives its relaunch notification. */
  attachedWebContents(): RetryWebContents | null;
  /** The normal post-exit teardown (archive, worktree, maps). */
  teardown(id: string): void;
  /** Hive log sink. */
  log(event: Record<string, unknown>): void;
  /** Runs after a successful retry spawn (keep-awake and the like). */
  afterSpawn(): void;
  warn?(message: string): void;
}

interface Launch {
  opts: SpawnOptions;
  owner: RetryWebContents | null;
  retried: boolean;
}

export class SpawnRetrier {
  /** The exact PTY spawn each live id was last launched with. Replaced by every
   *  fresh spawn, dropped by teardown. */
  private launches = new Map<string, Launch>();

  constructor(private deps: SpawnRetryDeps) {}

  /** A PTY was just spawned with these exact options. */
  spawned(id: string, opts: SpawnOptions, owner: RetryWebContents | null): void {
    this.launches.set(id, { opts, owner, retried: false });
  }

  /** The id was torn down: nothing left to retry, and a pending retry must not fire. */
  forget(id: string): void {
    this.launches.delete(id);
  }

  /**
   * Called from the PTY exit handler for a natural exit. Returns true when the
   * retrier took the exit (a retry is scheduled and the caller must NOT tear
   * down), false when the caller should run the normal teardown.
   */
  onExit(id: string, agentId: string, exit: Omit<SpawnExitInput, 'alreadyRetried'>): boolean {
    const launch = this.launches.get(id);
    if (!launch) return false;
    const reason = spawnRetryReason({ ...exit, alreadyRetried: launch.retried });
    if (!reason) return false;
    launch.retried = true;
    this.deps.warn?.(
      `[pty] ${agentId} exited (code ${exit.exitCode}) ${exit.uptimeMs ?? '?'} ms after launch (${reason}); ` +
      `retrying the spawn once in ${SPAWN_RETRY_DELAY_MS} ms`
    );
    this.deps.log({
      kind: SPAWN_RETRY_LOG_KIND, agentId, reason, exitCode: exit.exitCode,
      uptimeMs: exit.uptimeMs, delayMs: SPAWN_RETRY_DELAY_MS
    });
    setTimeout(() => this.fire(id, agentId, launch, exit), SPAWN_RETRY_DELAY_MS);
    return true;
  }

  private fire(id: string, agentId: string, launch: Launch, exit: Omit<SpawnExitInput, 'alreadyRetried'>): void {
    // Torn down meanwhile (tab closed, archived, quit) or already replaced by a
    // fresh spawn under the same id: nothing left to retry.
    if (this.launches.get(id) !== launch) return;
    if (this.deps.isLive(id)) return;
    // The window the PTY reports to is gone (floor closed during the wait):
    // there is nowhere for the relaunched session to paint, and spawning it
    // into some other window would be a surprise. Archive as a plain death.
    // An owner-less PTY reports to the manager's attached sink, so that is the
    // object checked and notified here — the same one its output goes to.
    const wc = launch.owner ?? this.deps.attachedWebContents();
    if (!wc || wc.isDestroyed()) {
      this.deps.warn?.(`[pty] retry for ${agentId} cancelled: its window is gone`);
      this.deps.log({ kind: SPAWN_RETRY_LOG_KIND, agentId, outcome: 'cancelled', reason: 'window-gone' });
      this.deps.teardown(id);
      return;
    }
    let res: { ok: boolean; error?: string };
    try {
      res = this.deps.spawn(launch.opts, launch.owner);
    } catch (e) {
      res = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (res.ok) {
      // Only now re-arm the renderer's terminal (clear the latched "process
      // exited" line, re-enable input): a relaunch message before a spawn that
      // then fails would leave a typeable dead terminal on screen. The
      // relaunch is queued ahead of any output the new process produces, so
      // the reset cannot wipe its first bytes.
      try { wc.send(`pty:relaunch:${id}`); } catch { /* window gone */ }
      this.deps.afterSpawn();
      return;
    }
    this.deps.warn?.(`[pty] retry spawn for ${agentId} failed: ${res.error}`);
    this.deps.log({ kind: SPAWN_RETRY_LOG_KIND, agentId, outcome: 'failed', error: res.error });
    // The renderer already shows the original exit; say so again explicitly so
    // its state is the normal dead terminal, then the normal teardown.
    try { wc.send(`pty:exit:${id}`, { exitCode: exit.exitCode ?? 1, signal: exit.signal ?? 0 }); } catch { /* window gone */ }
    this.deps.teardown(id);
  }
}
