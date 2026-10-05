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
 *    same quiescence the renderer's idle fallback uses), never a mid-turn one.
 *    A STALLED worker (old mail, no turn since it landed) is nudged whatever
 *    its terminal prints, but never while a turn its hooks opened is still
 *    open (TURN_CEILING_MS bounds a turn whose Stop was lost),
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
/** Mail this old with NO session activity since it landed = a STALLED worker:
 *  its CLI never took the first turn (a boot-time nudge lost while the TUI was
 *  still drawing, an occluded renderer that never typed one). PTY output cannot
 *  vouch for such a worker — a TUI redraws its chrome without doing any work,
 *  and the boot sequence itself is output — so past this age the quiet-output
 *  and never-output rules are bypassed, and so is the announced-ids edge trigger
 *  (#358 is for a worker that HEARD the announcement; a stalled one did not),
 *  still subject to paused/halted/HITL/boot-grace/cooldown. Observed live
 *  2026-09-06: a worker sat 17 minutes on its work order with 0 tokens and no
 *  transcript until the human typed "read your inbox" by hand; this watchdog
 *  never fired.
 *
 *  "Session activity" is a tool span or a usage sample with tokens (telemetry,
 *  which only Claude Code exports) OR a hook event that proves a turn
 *  (UserPromptSubmit / PreToolUse / PostToolUse / Stop — every engine the
 *  harness shims sends those). The rule is OFF for an agent that has produced
 *  neither a telemetry sample nor a single hook event: with no channel that
 *  could ever show a turn, "no activity" is not evidence of anything, and a
 *  Codex/Gemini/grok worker would otherwise read as stalled forever and be
 *  nudged every cooldown while working — the repeated nudging #368 removed. */
export const WORKER_WAKE_STALL_MS = 90_000;
/** How long an open turn keeps the stall rule off with no further hook. A
 *  turn is open from the hook that starts one (a prompt, a tool call, a
 *  subagent) until Stop; while it is open the worker is working, whatever its
 *  mail's age, and typing into it lands keystrokes in the middle of that work.
 *  A Stop the harness never heard would hold the worker for good, so past this
 *  long since the turn's last hook it no longer counts as open. */
export const WORKER_WAKE_TURN_CEILING_MS = 20 * 60_000;
/** Minimum age of pending mail before a held worker is reported in the log. */
export const WORKER_WAKE_REPORT_MS = 60_000;

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

/** A hook event that proves the CLI took a turn — the activity signal every
 *  engine the harness shims produces (Codex, Gemini, grok, … are mapped onto
 *  these names in hive.ts), unlike telemetry, which only Claude Code exports.
 *  SessionStart is the CLI coming up, not a turn: a worker whose boot nudge was
 *  lost has exactly that and nothing else. Notification is the CLI waiting. */
export function isTurnHook(event: string | undefined): boolean {
  switch (event) {
    case 'UserPromptSubmit':
    case 'PreToolUse':
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'Stop':
    case 'StopFailure':
    case 'SubagentStart':
    case 'SubagentStop':
      return true;
    default:
      return false;
  }
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
  /** When telemetry last showed the CLI doing a turn — a tool span, or a usage
   *  sample WITH tokens (activityEvidenceAt) — or 0/undefined when it never has. */
  lastActivityAt?: number;
  /** True when the telemetry collector holds ANY usage sample for the agent
   *  (even the zero-token one stamped at session start): its CLI exports
   *  telemetry, so a missing turn there means something. Only Claude Code
   *  does; for every other engine the hooks are the activity channel. */
  hasTelemetry?: boolean;
  /** created_at of the OLDEST undrained inbox message, or 0/undefined when
   *  unknown (the stall rule then stays off — fail closed, as before). */
  oldestMailAt?: number;
}

/** Why a worker with pending mail is NOT being nudged right now. */
export type WorkerWakeHold =
  | 'god' | 'no-mail' | 'no-pty'
  | 'delivery-paused' | 'paused' | 'halted'
  | 'booting' | 'mid-turn' | 'boot-grace' | 'hitl' | 'announced' | 'cooldown';

/** The inbox ids that count as mail: non-empty strings only. */
function liveInboxIds(f: WorkerWakeFacts): Set<string> {
  return new Set(f.inboxIds.filter((id) => typeof id === 'string' && id.length > 0));
}

/** Mail has waited WORKER_WAKE_STALL_MS and the CLI has shown no session
 *  activity since it landed: whatever its terminal is printing, this worker is
 *  not working the mail. */
export function isStalledWorker(f: WorkerWakeFacts, now = Date.now()): boolean {
  const mailAt = f.oldestMailAt ?? 0;
  if (mailAt <= 0 || liveInboxIds(f).size === 0) return false;
  if (now - mailAt < WORKER_WAKE_STALL_MS) return false;
  return (f.lastActivityAt ?? 0) < mailAt;
}

/** The subset of telemetry the activity rule reads. Structural so the beat can
 *  hand it the collector's own types and tests can hand it literals. */
export interface ActivityEvidence {
  /** The agent's latest usage sample (cumulative counters, ts = last update). */
  usage?: { ts: number; input: number; output: number } | null;
  /** Tool spans the agent has run, in arrival order. */
  spans?: ReadonlyArray<{ ts: number }> | null;
}

/** When the CLI last demonstrably did a turn, or 0 when it never has.
 *
 *  A usage sample only counts when it carries tokens: the collector stamps a
 *  sample at session start with every counter at zero, and a boot-time sample
 *  is exactly what a worker that never took its first turn has. A tool span is
 *  always a turn. Observed live 2026-09-07: a worker with 0 tokens, no tool and
 *  no transcript read as "last activity 63s ago" and was held as mid-turn. */
export function activityEvidenceAt(ev: ActivityEvidence): number {
  const u = ev.usage;
  const worked = u && (Number(u.input) || 0) + (Number(u.output) || 0) > 0 ? Number(u.ts) || 0 : 0;
  let span = 0;
  for (const s of ev.spans ?? []) if (s && Number(s.ts) > span) span = Number(s.ts);
  return Math.max(worked, span);
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

/** How each hold `explain` reports reads in a skip verdict. `god`, `no-pty`
 *  and `no-mail` never get a verdict, so they never reach this table. */
const SKIP_REASON: Record<Exclude<WorkerWakeHold, 'god' | 'no-pty' | 'no-mail'>, WakeSkipReason> = {
  'delivery-paused': 'paused',
  paused: 'paused',
  halted: 'paused',
  booting: 'no-output-yet',
  'mid-turn': 'not-quiet',
  'boot-grace': 'boot-grace',
  hitl: 'hitl',
  announced: 'already-announced',
  cooldown: 'cooldown'
};

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
  /** agentId → timestamp of its last hook event of ANY kind: the agent's hooks
   *  are alive, so a missing turn hook means something. */
  private hookSeenAt = new Map<string, number>();
  /** agentId → timestamp of its last hook event that proves a turn. */
  private lastTurnHookAt = new Map<string, number>();
  /** agentId → when its open turn last showed a hook; absent when no turn is
   *  open. See WORKER_WAKE_TURN_CEILING_MS. */
  private openTurnAt = new Map<string, number>();
  /** agentId → when its hold was last reported, so the beat logs a held worker
   *  once per cooldown instead of every 15 s. */
  private lastHoldReportAt = new Map<string, number>();

  /** Record a PTY spawn so its boot sequence is left alone. */
  noteSpawn(ptyId: string, at = Date.now()): void {
    this.spawnedAt.set(ptyId, at);
  }

  /** Feed hook events (from HookServer): a HITL prompt blocks nudges, and any
   *  turn-proving event is activity the stall rule credits — the one channel
   *  every engine has, telemetry being Claude-only. */
  noteHook(agentId: string | undefined, event: string | undefined, message: string | undefined, at = Date.now()): void {
    if (!agentId) return;
    this.hookSeenAt.set(agentId, at);
    if (isTurnHook(event) && at > (this.lastTurnHookAt.get(agentId) ?? 0)) this.lastTurnHookAt.set(agentId, at);
    if (event === 'Stop' || event === 'StopFailure') this.openTurnAt.delete(agentId);
    else if (event === 'UserPromptSubmit' || event === 'PreToolUse' || event === 'SubagentStart') this.openTurnAt.set(agentId, at);
    else if (isTurnHook(event) && this.openTurnAt.has(agentId)) this.openTurnAt.set(agentId, at);
    if (classifyHook(event, message) === 'needsHuman') this.lastHumanNeedsAt.set(agentId, at);
  }

  /** When the agent's hooks last proved a turn, or 0 when they never have. */
  turnHookAt(agentId: string): number {
    return this.lastTurnHookAt.get(agentId) ?? 0;
  }

  /** The stall rule on everything known: the beat's telemetry evidence plus
   *  the hooks' — and OFF for an agent that has produced neither a telemetry
   *  sample nor a single hook event, because such an agent cannot show a turn
   *  even when it takes one (see WORKER_WAKE_STALL_MS). */
  private isStalled(f: WorkerWakeFacts, now: number): boolean {
    const openAt = this.openTurnAt.get(f.agentId);
    if (openAt !== undefined && now - openAt < WORKER_WAKE_TURN_CEILING_MS) return false;
    const observable = !!f.hasTelemetry || this.hookSeenAt.has(f.agentId);
    if (!observable) return false;
    const lastActivityAt = Math.max(f.lastActivityAt ?? 0, this.turnHookAt(f.agentId));
    return isStalledWorker({ ...f, lastActivityAt }, now);
  }

  /** Forget per-agent state (e.g. the agent's PTY was closed). */
  forget(agentId: string, ptyId?: string): void {
    this.lastNudgeAt.delete(agentId);
    this.announcedInboxIds.delete(agentId);
    this.lastHumanNeedsAt.delete(agentId);
    this.hookSeenAt.delete(agentId);
    this.lastTurnHookAt.delete(agentId);
    this.openTurnAt.delete(agentId);
    this.lastHoldReportAt.delete(agentId);
    if (ptyId) this.spawnedAt.delete(ptyId);
  }

  /** Why this worker is held right now, or null when it should be nudged.
   *  The same checks decide() applies, in the same order, exposed so the beat
   *  can LOG why a worker with old pending mail is not being woken — the
   *  watchdog's silence used to be indistinguishable from "nothing to do".
   *  Pure: never touches the announcement / cooldown memory. */
  explain(f: WorkerWakeFacts, now = Date.now()): WorkerWakeHold | null {
    const inboxIds = liveInboxIds(f);
    if (inboxIds.size === 0) return 'no-mail';
    if (f.isGod) return 'god';
    if (!f.ptyId) return 'no-pty';
    if (f.autoDeliveryPaused) return 'delivery-paused';
    if (f.paused) return 'paused';
    if (f.halted) return 'halted';
    const stalled = this.isStalled(f, now);
    if (f.lastOutputAt <= 0 && !stalled) return 'booting'; // never produced output → still booting
    if (now - f.lastOutputAt < WORKER_WAKE_IDLE_MS && !stalled) return 'mid-turn';
    const spawned = this.spawnedAt.get(f.ptyId) ?? 0;
    if (spawned > 0 && now - spawned < WORKER_WAKE_BOOT_GRACE_MS) return 'boot-grace';
    const lastHuman = this.lastHumanNeedsAt.get(f.agentId) ?? 0;
    if (lastHuman > 0 && now - lastHuman < WORKER_WAKE_HITL_REARM_MS) return 'hitl';
    // Edge trigger (#358): mail already announced is not announced again — unless
    // the worker is stalled, i.e. it demonstrably never acted on the announcement.
    const announced = this.announcedInboxIds.get(f.agentId);
    if (announced && !stalled && !Array.from(inboxIds).some((id) => !announced.has(id))) return 'announced';
    const lastNudge = this.lastNudgeAt.get(f.agentId) ?? 0;
    if (lastNudge > 0 && now - lastNudge < WORKER_WAKE_COOLDOWN_MS) return 'cooldown';
    return null;
  }

  /** The worker ids that should be nudged right now, in stable registry order.
   *  Pure decision — the caller types the nudge. Remembers what it announced
   *  (the edge trigger) and when (the cooldown); a drained inbox forgets the
   *  announcement, so the remembered set is bounded by live mail. */
  decide(facts: readonly WorkerWakeFacts[], now = Date.now()): string[] {
    return this.decideWithReasons(facts, now).filter((v) => v.nudge).map((v) => v.agentId);
  }

  /** The same decision as `decide`, with the reason for every worker that has
   *  mail but is not nudged. Workers with nothing to wake for (no mail, god, no
   *  terminal) get no verdict. Pure decision — the caller logs and types. */
  decideWithReasons(facts: readonly WorkerWakeFacts[], now = Date.now()): WakeVerdict[] {
    const out: WakeVerdict[] = [];
    for (const f of facts) {
      const inboxIds = liveInboxIds(f);
      if (inboxIds.size === 0) {
        this.announcedInboxIds.delete(f.agentId);
        continue;
      }
      const hold = this.explain(f, now);
      if (hold === 'god' || hold === 'no-pty' || hold === 'no-mail') continue;
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
      if (hold !== null) { out.push(verdict(SKIP_REASON[hold])); continue; }
      out.push(verdict());
      this.lastNudgeAt.set(f.agentId, now);
      this.announcedInboxIds.set(f.agentId, inboxIds);
    }
    return out;
  }

  /** True once per WORKER_WAKE_COOLDOWN_MS per worker — the beat's log gate. */
  shouldReportHold(agentId: string, now = Date.now()): boolean {
    const last = this.lastHoldReportAt.get(agentId) ?? 0;
    if (last > 0 && now - last < WORKER_WAKE_COOLDOWN_MS) return false;
    this.lastHoldReportAt.set(agentId, now);
    return true;
  }

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

/** One hive-log line: a stall, a failed attempt to end one, or its end. */
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
    /** A nudge was typed, but its submission did not reach the terminal. */
    state: 'nudge-failed';
    stalledMs: number;
  }
  | {
    kind: 'worker-wake-skip';
    agentId: string;
    /** The worker's terminal closed, or its record was archived, with mail left. */
    state: 'terminal-lost';
    stalledMs: number;
  }
  | {
    kind: 'worker-wake-skip';
    agentId: string;
    state: 'resolved';
    /** `nudged`: a nudge's submission reached the terminal. `drained`: the
     *  worker's inbox emptied while its terminal was still open. */
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
 * the holding guard or the undelivered mail changes; and again every
 * WAKE_SKIP_RELOG_MS while it persists. Mail the worker was already woken for
 * is not a stall of the wake path, however long its turn runs, and is never
 * written.
 *
 * A stall ends only on something observed. Deciding to nudge is not
 * delivering: typing the nudge can fail, and the caller can skip it. So a
 * stall is resolved when the caller reports that a nudge's submission reached
 * the terminal (recordDelivery), or when a beat finds the worker's terminal
 * still open but no mail left for it. A worker that drops out of the beat
 * altogether lost its terminal or its record, and that is written as such,
 * never as a drain. If the wall clock is stepped back past a stall's own
 * times, its timing restarts from there instead of going negative.
 *
 * Pure — returns the lines; the caller writes them.
 */
export class WakeSkipLog {
  /** agentId → the stall in progress: when it began, what it last looked like,
   *  and when it was last written (0 = not yet). */
  private stalls = new Map<string, { since: number; key: string; loggedAt: number }>();

  /** The lines this beat's verdicts call for. `live` is every worker whose
   *  terminal is open this beat, whether or not it has a verdict. */
  observe(verdicts: readonly WakeVerdict[], now: number, live: ReadonlySet<string>): WakeSkipEntry[] {
    const out: WakeSkipEntry[] = [];
    const seen = new Set<string>();
    for (const v of verdicts) {
      seen.add(v.agentId);
      const stall = this.stalls.get(v.agentId);
      if (stall) this.rewind(stall, now);
      // A nudge decided on, or mail already announced: nothing new to write.
      // Any stall stays open until its outcome is observed.
      if (v.nudge || !v.reason || v.newIds.length === 0) continue;
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
    // A stalled worker with no verdict either has no mail left (its terminal is
    // still open) or is gone.
    for (const [agentId, stall] of this.stalls) {
      if (seen.has(agentId)) continue;
      this.rewind(stall, now);
      if (stall.loggedAt > 0) {
        out.push(live.has(agentId)
          ? { kind: 'worker-wake-skip', agentId, state: 'resolved', via: 'drained', stalledMs: now - stall.since }
          : { kind: 'worker-wake-skip', agentId, state: 'terminal-lost', stalledMs: now - stall.since });
      }
      this.stalls.delete(agentId);
    }
    return out;
  }

  /** The outcome of a nudge the watchdog decided on: whether its submission
   *  reached the terminal. Only a submitted nudge ends a stall; a failed one is
   *  written, and the stall stays open. */
  recordDelivery(agentId: string, submitted: boolean, now: number): WakeSkipEntry[] {
    const stall = this.stalls.get(agentId);
    if (!stall) return [];
    this.rewind(stall, now);
    if (submitted) {
      this.stalls.delete(agentId);
      return stall.loggedAt > 0
        ? [{ kind: 'worker-wake-skip', agentId, state: 'resolved', via: 'nudged', stalledMs: now - stall.since }]
        : [];
    }
    stall.loggedAt = now;
    return [{ kind: 'worker-wake-skip', agentId, state: 'nudge-failed', stalledMs: now - stall.since }];
  }

  /** A wall clock stepped back past the stall's own times restarts its timing
   *  from now, rather than report a negative duration or stay silent until the
   *  old clock comes round again. */
  private rewind(stall: { since: number; loggedAt: number }, now: number): void {
    if (now < stall.since) stall.since = now;
    if (now < stall.loggedAt) stall.loggedAt = now;
  }
}
