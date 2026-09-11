/**
 * WorkerWakeWatchdog — main-process inbox-wake watchdog for worker agents (#151).
 *
 * The renderer's idle inbox-wake nudge (useHive.ts effect #3) is the ONLY wake
 * path for a worker that has gone quiet at its prompt: it polls on a setInterval
 * in the renderer, so a throttled/occluded window (Chromium suspends background
 * setInterval timers) can miss the moment mail lands and the worker then sits on
 * an undrained inbox forever — the orchestrator ("god") never has this problem
 * because the main process re-engages it on its own heartbeat cadence.
 *
 * This watchdog is the worker-side counterpart: on a cadence it finds live
 * workers that are genuinely idle, have newly arrived inbox mail, are not
 * paused / not awaiting a human decision, and have not been nudged recently —
 * then types the same guarded nudge the renderer would have, directly into the
 * PTY. Message ids make this edge-triggered: unchanged undrained mail is never
 * re-announced once a minute forever.
 *
 * Safety mirrors the renderer's guarded queue-drain (useHive.ts dispatch):
 *  - only a GENUINELY idle worker is nudged (no PTY output for IDLE_MS — the
 *    same quiescence the renderer's idle fallback uses), never a mid-turn one,
 *  - never inside the boot sequence (BOOT_GRACE_MS from spawn, mirroring the
 *    renderer's bootGraceUntil),
 *  - delivery paused / agent paused / halted → no nudge (ControlRegistry),
 *  - a recent permission/HITL notification re-arms a block (HITL_REARM_MS) so a
 *    prompt the human is deciding on is never typed into,
 *  - a per-worker cooldown (NUDGE_COOLDOWN_MS) so the watchdog and the renderer
 *    nudge don't stack on top of each other.
 *
 * Deliberately the renderer's own nudge text, and the same type pattern the
 * renderer's submitToPty uses (text first, Enter as a separate keystroke).
 *
 * No electron import — unit-testable (mirrors ControlRegistry).
 */

/** The exact nudge the renderer's inbox-wake loop would have typed. */
export const WORKER_WAKE_NUDGE =
  'You have new hive inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.';

/** No PTY output for this long = genuinely idle (renderer QUIESCE_IDLE_MS). */
export const WORKER_WAKE_IDLE_MS = 12_000;
/** Never nudge inside the boot sequence (renderer BOOT_GRACE_MS). */
export const WORKER_WAKE_BOOT_GRACE_MS = 35_000;
/** Minimum gap between two watchdog nudges of the same worker. */
export const WORKER_WAKE_COOLDOWN_MS = 60_000;
/** A permission/HITL notification blocks nudges for this long after it fires. */
export const WORKER_WAKE_HITL_REARM_MS = 5 * 60_000;

/** A hook event message that means "the agent needs the human" — permission /
 *  approve / confirm prompts (mirrors the renderer's needsHuman detection in
 *  useHive.ts). Anything matching the idle-waiting shape is NOT a HITL hold. */
export type HookClass = 'needsHuman' | 'idle' | null;

export function classifyHook(event: string | undefined, message: string | undefined): HookClass {
  if (event === 'Notification') {
    const msg = (message ?? '').toLowerCase();
    const idleWaiting = !msg
      || msg.includes('waiting for your input')
      || msg.includes('is idle')
      || msg.includes('waiting for input');
    const needsHuman = msg.includes('permission')
      || msg.includes('approve')
      || msg.includes('confirm')
      || msg.includes('needs your');
    if (needsHuman && !idleWaiting) return 'needsHuman';
    return 'idle';
  }
  return null;
}

/** One worker's live facts, gathered by the caller each beat. */
export interface WorkerWakeFacts {
  /** Worker agent id (god is never a candidate). */
  agentId: string;
  /** True when this agent is the orchestrator — god is never nudged. */
  isGod?: boolean;
  /** Live PTY id, or undefined when the agent has no terminal. */
  ptyId?: string;
  /** Timestamp of the PTY's last output (0 = never output). */
  lastOutputAt: number;
  /** IDs of undrained inbox messages (empty → nothing to wake for). */
  inboxIds: readonly string[];
  /** ControlRegistry snapshot flags. */
  autoDeliveryPaused: boolean;
  paused: boolean;
  halted: boolean;
}

/** Why a worker with mail was not nudged on this beat. */
export type WakeSkipReason =
  | 'paused'            // delivery paused, agent paused, or halted
  | 'no-output-yet'     // the terminal has never printed: still booting
  | 'not-quiet'         // printed within the idle window: taken to be mid-turn
  | 'boot-grace'        // inside the boot sequence
  | 'hitl'              // a permission/HITL prompt fired recently
  | 'already-announced' // woken for this mail already; nothing new to announce
  | 'cooldown';         // nudged too recently

/** One worker's verdict for one beat. */
export interface WakeVerdict {
  agentId: string;
  nudge: boolean;
  /** Absent when the worker is nudged. */
  reason?: WakeSkipReason;
  /** How long the terminal has been silent, or null if it never printed. */
  quietMs: number | null;
  /** Undrained inbox ids. */
  inboxIds: string[];
  /** The subset no nudge has announced yet — the mail a wake is pending for. */
  newIds: string[];
}

export class WorkerWakeWatchdog {
  /** ptyId → spawn timestamp (boot grace). */
  private spawnedAt = new Map<string, number>();
  /** agentId → last nudge timestamp (cooldown). */
  private lastNudgeAt = new Map<string, number>();
  /** agentId → inbox ids included in the last nudge. This turns the watchdog
   *  into an edge trigger: a worker is nudged again only when a new id appears. */
  private announcedInboxIds = new Map<string, Set<string>>();
  /** agentId → timestamp of the last needsHuman hook notification. */
  private lastHumanNeedsAt = new Map<string, number>();

  /** Record a PTY spawn so its boot sequence is left alone. */
  noteSpawn(ptyId: string, at = Date.now()): void {
    this.spawnedAt.set(ptyId, at);
  }

  /** Feed hook events (from HookServer) so a HITL prompt blocks nudges. */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): void {
    if (!agentId) return;
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
  }

  /** Forget per-agent state (e.g. the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.lastNudgeAt.delete(agentId);
    this.announcedInboxIds.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  Pure decision — the caller types the nudge. */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    return this.decideWithReasons(facts, now).filter((v) => v.nudge).map((v) => v.agentId);
  }

  /** The same decision as `decide`, with the reason for every worker that has
   *  mail but is not nudged. Workers with nothing to wake for (no mail, god, no
   *  terminal) get no verdict. Pure decision — the caller logs and types. */
  decideWithReasons(facts: readonly WorkerWakeFacts[], now = Date.now()): WakeVerdict[] {
    const out: WakeVerdict[] = [];
    for (const f of facts) {
      const inboxIds = new Set(f.inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
      if (inboxIds.size === 0) {
        // A fully drained inbox starts a fresh announcement cycle and bounds the
        // remembered set even for a worker that lives for months.
        this.announcedInboxIds.delete(f.agentId);
        continue;
      }
      if (f.isGod || !f.ptyId) continue;
      const announced = this.announcedInboxIds.get(f.agentId);
      // Read before any state changes below, so a nudge reports the mail it announces.
      const verdict = (reason?: WakeSkipReason): WakeVerdict => ({
        agentId: f.agentId,
        nudge: reason === undefined,
        ...(reason ? { reason } : {}),
        quietMs: f.lastOutputAt > 0 ? now - f.lastOutputAt : null,
        inboxIds: Array.from(inboxIds),
        newIds: Array.from(inboxIds).filter((id) => !announced?.has(id))
      });
      if (f.autoDeliveryPaused || f.paused || f.halted) { out.push(verdict('paused')); continue; }
      if (f.lastOutputAt <= 0) { out.push(verdict('no-output-yet')); continue; } // never produced output → still booting
      if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS) { out.push(verdict('not-quiet')); continue; } // mid-turn
      const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
      if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) { out.push(verdict('boot-grace')); continue; }
      const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
      if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) { out.push(verdict('hitl')); continue; }
      if (announced && !Array.from(inboxIds).some((id) => !announced.has(id))) {
        out.push(verdict('already-announced'));
        continue;
      }
      const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
      if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) { out.push(verdict('cooldown')); continue; }
      out.push(verdict());
      this.lastNudgeAt.set(f.agentId, now);
      this.announcedInboxIds.set(f.agentId, inboxIds);
    }
    return out;
  }

  /** Last time this worker was nudged (0 = never) — useful for diagnostics. */
  lastNudge(agentId: string): number {
    return this.lastNudgeAt.get(agentId) ?? 0;
  }
}

/** A stall is written only once undelivered mail has waited this long, so a
 *  turn that merely outlasts a beat or two never reaches the log. */
export const WAKE_SKIP_DWELL_MS = 5 * 60_000;
/** While the same stall persists it is written again at this interval, with
 *  fresh readings, rather than on every beat. */
export const WAKE_SKIP_RELOG_MS = 10 * 60_000;
/** Ids named per line; `pending` still counts all of them. */
export const WAKE_SKIP_MAX_IDS = 10;

/** One hive-log line: a stall, or the end of one. */
export type WakeSkipEntry =
  | {
    kind: 'worker-wake-skip';
    agentId: string;
    state: WakeSkipReason;
    quietMs: number | null;
    idleMs: number;
    pending: number;
    newIds: string[];
    stalledMs: number;
  }
  | {
    kind: 'worker-wake-skip';
    agentId: string;
    state: 'resolved';
    via: 'nudged' | 'drained';
    stalledMs: number;
  };

/**
 * Turns the watchdog's per-beat verdicts into a few hive-log lines.
 *
 * The watchdog used to decline silently, so a worker that sat on undelivered
 * mail for hours left no record of which guard was holding it. Writing every
 * verdict would add a line per worker every beat, forever. Instead a stall is
 * written once undelivered mail has waited WAKE_SKIP_DWELL_MS; again at once if
 * the holding guard or the undelivered mail changes; again every
 * WAKE_SKIP_RELOG_MS while it persists; and once more, as `resolved`, when the
 * mail is delivered or drained. Mail the worker was already woken for is not a
 * stall of the wake path, however long its turn runs, and is never written.
 *
 * Pure — returns the lines; the caller writes them.
 */
export class WakeSkipLog {
  /** agentId → the stall in progress: when it began, what it last looked like,
   *  and when it was last written (0 = not yet). */
  private stalls = new Map<string, { since: number; key: string; loggedAt: number }>();

  observe(verdicts: readonly WakeVerdict[], now = Date.now()): WakeSkipEntry[] {
    const out: WakeSkipEntry[] = [];
    const seen = new Set<string>();
    for (const v of verdicts) {
      seen.add(v.agentId);
      const stall = this.stalls.get(v.agentId);
      if (v.nudge || !v.reason || v.newIds.length === 0) {
        // Delivered, or nothing left to deliver: any stall is over.
        if (stall) {
          if (stall.loggedAt > 0) {
            out.push({
              kind: 'worker-wake-skip',
              agentId: v.agentId,
              state: 'resolved',
              via: v.nudge ? 'nudged' : 'drained',
              stalledMs: now - stall.since
            });
          }
          this.stalls.delete(v.agentId);
        }
        continue;
      }
      const key = `${v.reason}|${v.newIds.join(',')}`;
      const current = stall ?? { since: now, key, loggedAt: 0 };
      const due = now - current.since >= WAKE_SKIP_DWELL_MS
        && (current.loggedAt === 0 || current.key !== key || now - current.loggedAt >= WAKE_SKIP_RELOG_MS);
      if (due) {
        out.push({
          kind: 'worker-wake-skip',
          agentId: v.agentId,
          state: v.reason,
          quietMs: v.quietMs,
          idleMs: WORKER_WAKE_IDLE_MS,
          pending: v.inboxIds.length,
          newIds: v.newIds.slice(0, WAKE_SKIP_MAX_IDS),
          stalledMs: now - current.since
        });
        current.loggedAt = now;
      }
      current.key = key;
      this.stalls.set(v.agentId, current);
    }
    // A worker that was stalled and has no verdict now has drained its inbox,
    // or lost its terminal.
    for (const [agentId, stall] of this.stalls) {
      if (seen.has(agentId)) continue;
      if (stall.loggedAt > 0) {
        out.push({ kind: 'worker-wake-skip', agentId, state: 'resolved', via: 'drained', stalledMs: now - stall.since });
      }
      this.stalls.delete(agentId);
    }
    return out;
  }
}
