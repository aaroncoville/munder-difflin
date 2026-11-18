import { useEffect, useSyncExternalStore } from 'react';
import { useStore, type Agent } from '@/store/store';
import { buildSpawnCommand, inferAgentProvider, tokenizeCommand, type HarnessConfig } from '@/store/config';
import { roleForHiveSpawn } from '@shared/agentRole';

/** "Restore team" — respawn every worker from the previous session.
 *
 *  Lives here rather than inside AgentStrip because the floor strip is hidden in
 *  fullscreen, which used to mean the restore button (and the list of restorable
 *  agents) simply vanished when you went fullscreen. Both mount points share the
 *  progress state below, so a restore kicked off from one view shows as running
 *  in the other and can't be double-started. */

let restoring = false;
let note: string | null = null;
/** True only while the AUTOMATIC boot restore is in flight, so the UI can say
 *  "this is happening on its own" rather than looking like a click you don't
 *  remember making. */
let autoRestoring = false;
/** Latched the moment the automatic restore starts. Module-level, not per
 *  component: `useRestoreTeam` is mounted from both the floor strip and the
 *  fullscreen rail, and without this each of them would kick off its own. */
let autoStarted = false;
const listeners = new Set<() => void>();

/** How long to wait after boot before restoring on our own.
 *
 *  App.tsx reconciles the persisted roster against the PTYs actually alive in
 *  the main process, and that is an async round trip. Firing before it lands
 *  would read a restorable list that still contains agents whose terminals are
 *  already running, and try to spawn duplicates of them. The delay is also the
 *  window in which you can hit a dismiss ✕ if you don't want an agent back. */
export const AUTO_RESTORE_DELAY_MS = 2500;

function emit(): void {
  for (const l of [...listeners]) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// useSyncExternalStore requires a stable snapshot identity — returning a fresh
// object each call would loop forever, so the two fields are read separately.
const getRestoring = (): boolean => restoring;
const getNote = (): string | null => note;
const getAutoRestoring = (): boolean => autoRestoring;

export interface RestoreTeamState {
  restoring: boolean;
  /** True when the run in flight was started automatically at boot, not by a
   *  click. Drives the "restoring your team…" banner. */
  autoRestoring: boolean;
  /** Outcome of the last run ("restored 3 · 1 failed — …"), or null. */
  restoreNote: string | null;
  restoreTeam: () => Promise<void>;
}

/**
 * @param config used only to rebuild a spawn command for a restorable agent
 *        persisted before the `command` field existed.
 */
export function useRestoreTeam(config?: HarnessConfig | null): RestoreTeamState {
  const isRestoring = useSyncExternalStore(subscribe, getRestoring, getRestoring);
  const restoreNote = useSyncExternalStore(subscribe, getNote, getNote);
  const isAutoRestoring = useSyncExternalStore(subscribe, getAutoRestoring, getAutoRestoring);

  /** Respawn every worker from the previous session with its ORIGINAL agent id,
   *  cwd, model and command — the hive workspace (memory.md, inbox, registry
   *  entry) reattaches by itself, no memory transplant needed. */
  const restoreTeam = async (): Promise<void> => {
    if (restoring) return;
    restoring = true;
    note = null;
    emit();
    const prevSel = useStore.getState().selectedId;
    // addAgent selects each card it adds. The selection the restore itself last set is the card it placed last (or
    // the earlier selection); any other selection is the owner's own choice, and later cards must not take it away.
    let lastPlaced: string | null = null;
    let ownerChoice: string | null = null;
    /** Every agent this restore gave a card, in the order it did. */
    const placed: string[] = [];
    const noteChoice = (): void => {
      const selected = useStore.getState().selectedId;
      if (selected !== (lastPlaced ?? prevSel)) ownerChoice = selected;
    };
    const restorableAgents = useStore.getState().restorableAgents;
    // Tally every agent's outcome so the run ALWAYS leaves a visible trace — the
    // original bug was that every failure path was console-only, so a click that
    // couldn't spawn anything looked like a dead button.
    let restored = 0;
    let alreadyLive = 0;
    const failures: string[] = [];
    try {
      // Restore every agent CONCURRENTLY. Each spawn is keyed by its own ptyId and
      // touches no cross-agent state in the renderer, and in the main process the
      // whole `pty:spawn` handler (hive registry read-modify-write included) runs
      // synchronously between awaits, so concurrent handlers can't interleave
      // mid-update. Serially this cost the sum of every agent's git probe + spawn;
      // a 6-agent team took ~6× one agent for no reason.
      // Each card is added as soon as its own spawn answers, at its place in the
      // roster order. Adding them all after the last spawn answered let one slow
      // agent (a Codex app server using its whole trust budget) hold back every
      // card. Adding them in completion order let timing decide the roster order,
      // and that order is persisted, so a slow provider or a slow git probe
      // silently overwrote the sequence the user had dragged the cards into.
      const restoreOne = async (a: (typeof restorableAgents)[number]): Promise<Agent | null> => {
        // An agent that does not start still gets a stopped card that says why, at its place in the roster, from
        // which Restart & Continue starts it again (it accepts a terminal that is already gone). Left behind in the
        // restorable list it had no card, nothing could start it short of relaunching the app, and a later restore
        // put it after the agents that had started, out of the order the user arranged.
        const stopped = (why: string): Agent => {
          failures.push(`${a.name}: ${why}`);
          return {
            ...a,
            provider: inferAgentProvider(a.command, a.provider),
            ptyId: a.ptyId ?? `pty-${a.id}`,
            archived: false,
            status: 'blocked',
            action: `not started: ${why}`,
            carrying: undefined,
            currentStation: 'desk'
          };
        };
        // Per-agent guard: one agent's failure (or a rejected IPC call) must NEVER
        // abort the others — an unhandled rejection here used to make the
        // entire restore a silent no-op after the first bad agent.
        try {
          const provider = inferAgentProvider(a.command, a.provider);
          const command = (a.command ?? '').trim() || (config ? buildSpawnCommand(config, a.model, provider) : '');
          // No spawn recipe (an old entry persisted before `command`, with no config to rebuild one).
          if (!command || !a.cwd) return stopped('no saved command');
          const [exe, ...args] = tokenizeCommand(command);
          const ptyId = a.ptyId ?? `pty-${a.id}`;
          // An isolated agent's worktree SURVIVES an app restart on disk (it's only
          // torn down on per-tab close / mid-session exit, not on quit). So re-enter
          // that exact worktree as the cwd rather than re-isolating — `git worktree
          // add` would conflict with the existing path/branch, and re-isolating would
          // also lose the worktree's uncommitted work. cwd = the worktree means
          // resume + seedSessionTranscript land in the CORRECT checkout.
          // But the user may have manually pruned/deleted the worktree between runs —
          // gitIsRepo (git rev-parse) returns false for a missing/invalid dir, so
          // fall back to the base repo cwd rather than spawning into a dead path.
          let cwd = a.cwd;
          let worktreeGone = false;
          if (a.worktreePath) {
            if (await window.cth.gitIsRepo(a.worktreePath)) {
              cwd = a.worktreePath;
            } else {
              worktreeGone = true;
              console.warn(`[restore] worktree gone for ${a.id} (${a.worktreePath}); falling back to base repo ${a.cwd}`);
            }
          }
          const res = await window.cth.spawnPty({
            id: ptyId,
            cwd,
            command: exe,
            provider,
            args,
            cols: 100,
            rows: 30,
            // Worktree (if any) already exists on disk — cd into it, don't create a
            // new one (re-isolating would conflict on the existing path/branch and
            // lose its uncommitted work).
            isolate: false,
            // Continue the worker's prior CLI session if one was recorded — the
            // main process picks the provider's resume flag (Claude --resume,
            // agy --conversation) and for Claude reattaches the transcript. The
            // agent id is preserved across restart, so its registry entry,
            // memory.md and inbox reattach by id. No-op without a recorded session.
            resume: true,
            hive: { id: a.id, name: a.name, provider, cwd, role: roleForHiveSpawn(a) }
          });
          if (res.ok) {
            restored++;
            return {
                ...a,
                provider,
                ptyId,
                archived: false,
                status: 'idle',
                // Surface the worktree fallback on the floor card; otherwise normal.
                action: worktreeGone ? 'worktree gone — using base repo' : 'starting up',
                // The worktree is no longer on disk — drop it so this agent is treated
                // as a plain base-cwd agent going forward (a future restore won't keep
                // re-probing a dead path).
                worktreePath: worktreeGone ? undefined : a.worktreePath,
                // Crush spawns bare (no positional protocol) and hands the seed back
                // here; useHive types it after boot. Re-seeding a resumed worker is
                // idempotent (it just re-reads its inbox per protocol). (ondev-b)
                seedPrompt: res.seedPrompt,
                carrying: undefined,
                currentStation: 'desk',
                recentTextTs: Date.now()
            };
          } else if ((res.error ?? '').includes('already exists')) {
            // A live PTY with this id is already running (e.g. respawned at boot or
            // by another path) — the agent isn't actually missing, so retire it from
            // the restorable list rather than reporting a phantom failure.
            alreadyLive++;
            useStore.getState().removeRestorableAgent(a.id);
          } else {
            // Record WHY so the outcome is shown on the floor, not buried in the
            // devtools console.
            console.error('[restore] spawn failed for', a.id, res.error);
            return stopped(res.error ?? 'spawn failed');
          }
        } catch (e) {
          console.error('[restore] error for', a.id, e);
          return stopped(e instanceof Error ? e.message : String(e));
        }
        return null;
      };
      const order = restorableAgents.map((a) => a.id);
      const place = (card: Agent): void => {
        const before = useStore.getState().agents.some((x) => x.id === card.id);
        noteChoice();
        // The agent stays in the restorable list until the whole restore ends, so a quit before then leaves the
        // next launch the order to put it back in (reconcileWithLivePtys).
        useStore.getState().addAgent(card, { keepRestorable: true });
        placed.push(card.id);
        lastPlaced = card.id;
        if (ownerChoice && useStore.getState().agents.some((x) => x.id === ownerChoice)) useStore.getState().select(ownerChoice);
        if (before) return;
        // Ahead of the first card already on the floor that comes later in the roster.
        const rank = order.indexOf(card.id);
        const next = useStore.getState().agents.find((x) => x.id !== card.id && order.indexOf(x.id) > rank);
        if (next) useStore.getState().reorderAgents(card.id, next.id);
      };
      await Promise.all(restorableAgents.map((a) => restoreOne(a).then((card) => { if (card) place(card); })));
    } finally {
      // Every agent this restore placed has had a card (started or stopped), whether it is still on the floor, was
      // archived or removed meanwhile, or the restore failed part-way: none of them is restorable any more.
      for (const id of placed) useStore.getState().removeRestorableAgent(id);
      // addAgent auto-selects each spawn; put the user back where they were, or on the card they chose meanwhile.
      noteChoice();
      const sel = useStore.getState();
      const keep = ownerChoice ?? prevSel;
      if (keep && sel.agents.some((x) => x.id === keep)) sel.select(keep);
      restoring = false;
      // ALWAYS surface a result so the button can never look inert.
      const parts: string[] = [];
      if (restored) parts.push(`restored ${restored}`);
      if (alreadyLive) parts.push(`${alreadyLive} already live`);
      if (failures.length) parts.push(`${failures.length} failed — ${failures.join('; ')}`);
      note = parts.length ? parts.join(' · ') : 'nothing to restore';
      emit();
    }
  };

  // Restore the previous session's team on open, without waiting for a click.
  //
  // Deliberately driven by a store SUBSCRIPTION rather than a plain timer: the
  // restorable list is empty on the first render and only fills once App.tsx's
  // PTY reconcile resolves, so a timer started at mount would look at an empty
  // list, decide there was nothing to do, and never look again.
  //
  // Only ever fires for agents already on the restorable list — i.e. ones that
  // had a terminal open when the app last quit. Archived agents (closed tabs)
  // are never touched.
  useEffect(() => {
    if (autoStarted || !config?.onboardingComplete) return;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const check = (): void => {
      if (autoStarted || restoring || timer) return;
      if (!useStore.getState().restorableAgents.length) return;
      timer = setTimeout(() => {
        timer = null;
        if (autoStarted || restoring) return;
        if (!useStore.getState().restorableAgents.length) return;
        // Latch BEFORE the await so the other mount point's timer, which may
        // fire in this same tick, sees it.
        autoStarted = true;
        autoRestoring = true;
        emit();
        void restoreTeam().finally(() => { autoRestoring = false; emit(); });
      }, AUTO_RESTORE_DELAY_MS);
    };

    check();
    const unsub = useStore.subscribe(check);
    return () => { unsub(); if (timer) clearTimeout(timer); };
    // restoreTeam is rebuilt every render but only ever called from inside the
    // timer, so it is read fresh at call time and does not belong in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.onboardingComplete]);

  return { restoring: isRestoring, autoRestoring: isAutoRestoring, restoreNote, restoreTeam };
}
