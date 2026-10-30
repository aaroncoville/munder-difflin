/**
 * Render only when something changed.
 *
 * Pixi's TickerPlugin renders the stage on every tick, whether or not a pixel
 * would differ. On the reduced path (officeMotion.ts) the ticker runs at 15
 * fps, so a floor where everyone is sitting still — single-frame idle poses,
 * a settled camera — was redrawn fifteen times a second for nothing: on a
 * software GPU, a full rasterisation each time. The simulation still has to
 * advance every tick (walking, fades, timers), so the ticker keeps running;
 * what stops is the draw.
 *
 * "Something changed" is read off Pixi's own bookkeeping rather than tracked
 * by hand across a thousand call sites. Every setter that affects the picture
 * queues work on the stage's RenderGroup for the next render: a transform,
 * alpha or tint change puts the container in `childrenToUpdate`
 * (Container._onUpdate), a texture, frame, text or Graphics change puts the
 * view in `childrenRenderablesToUpdate` (ViewContainer.onViewUpdate), and a
 * child added or removed, a visibility, blend-mode or mask change sets
 * `structureDidChange`. Each queue is deduplicated by a per-container flag
 * (`didChange`, `didViewUpdate`) that only a render clears, so a change that
 * sits unrendered for ten ticks is queued once, and setting a property to the
 * value it already has queues nothing (ObservablePoint and the setters all
 * compare first). An AnimatedSprite only assigns `texture` when its frame
 * index moves, so a breathing idle counts exactly when its frame changes.
 *
 * The one change the scene graph cannot see is the canvas itself being
 * cleared: a resize, including the gate's resolution change, wipes the
 * bitmap. The floor forwards the renderer's 'resize' event to `invalidate`.
 *
 * On the full path nothing changes: a render every tick, as the TickerPlugin
 * did. The decision is re-read every tick so a live mode change
 * (createOfficeMotionGate) takes effect without a rebuild.
 */
import type { OfficeMotionMode } from './officeMotion';

/** The slice of a Pixi RenderGroup the check reads. */
export interface RenderGroupLike {
  structureDidChange: boolean;
  /** Keyed by depth; each entry's `index` is how many containers are queued. */
  childrenToUpdate: Record<string, { index: number }>;
  childrenRenderablesToUpdate: { index: number };
  renderGroupChildren: RenderGroupLike[];
}

/** True when Pixi has work queued for the next render of this group or any
 *  nested one. A stage that has never been rendered has no render group yet
 *  (the first render creates it), which is a change. */
export function sceneChangedSinceRender(group: RenderGroupLike | null | undefined): boolean {
  if (!group) return true;
  if (group.structureDidChange) return true;
  if (group.childrenRenderablesToUpdate.index > 0) return true;
  for (const depth in group.childrenToUpdate) {
    if (group.childrenToUpdate[depth].index > 0) return true;
  }
  for (const child of group.renderGroupChildren) {
    if (sceneChangedSinceRender(child)) return true;
  }
  return false;
}

/** The shortest gap between two renders under a frame cap; 0 is uncapped. */
export function minRenderIntervalMs(maxFPS: number): number {
  return maxFPS > 0 ? 1000 / maxFPS : 0;
}

export interface RenderPlanInput {
  mode: OfficeMotionMode;
  /** Pixi has queued work (sceneChangedSinceRender). */
  changed: boolean;
  /** The canvas was cleared behind the scene graph's back (a resize). */
  invalidated: boolean;
  /** The ticker's timestamp for this tick. */
  now: number;
  lastRenderAt: number | null;
  /** The decision's frame cap, 0 for uncapped. Already enforced by the
   *  ticker; enforced here too so the bound holds whatever drives `step`. */
  maxFPS: number;
}

/** Whether to draw this tick. The full path draws every tick, as before. */
export function shouldRenderNow(input: RenderPlanInput): boolean {
  if (input.mode !== 'reduced') return true;
  if (!input.changed && !input.invalidated) return false;
  const gap = minRenderIntervalMs(input.maxFPS);
  if (gap > 0 && input.lastRenderAt !== null && input.now - input.lastRenderAt < gap) return false;
  return true;
}

export interface RenderOnChangeOptions {
  /** Draw the stage now (`app.render()`). */
  render: () => void;
  /** Read Pixi's queues (`sceneChangedSinceRender(app.stage.renderGroup)`). */
  changed: () => boolean;
  /** The decision in force, re-read every tick. */
  decision: () => { mode: OfficeMotionMode; maxFPS: number };
  /** Where the periodic rate line goes; console.debug in the app. */
  log?: (msg: string) => void;
  /** How often, in ticker time, to log renders per tick on the reduced path.
   *  0 never logs. */
  reportEveryMs?: number;
}

export interface RenderOnChange {
  /** Called once per tick after the simulation. Returns whether it drew. */
  step(now: number): boolean;
  /** The canvas no longer shows the last render: draw on the next tick
   *  whether or not the scene graph changed. */
  invalidate(): void;
  /** Lifetime counts, for diagnosis. */
  readonly ticks: number;
  readonly renders: number;
}

export const DEFAULT_REPORT_EVERY_MS = 60_000;

export function createRenderOnChange(opts: RenderOnChangeOptions): RenderOnChange {
  const log = opts.log ?? ((m: string) => console.debug(m));
  const reportEvery = opts.reportEveryMs ?? DEFAULT_REPORT_EVERY_MS;
  let ticks = 0;
  let renders = 0;
  let invalidated = false;
  let lastRenderAt: number | null = null;
  let reportStartedAt: number | null = null;
  let ticksAtReport = 0;
  let rendersAtReport = 0;

  const report = (now: number, mode: OfficeMotionMode) => {
    if (reportEvery <= 0) return;
    if (reportStartedAt === null) { reportStartedAt = now; ticksAtReport = ticks; rendersAtReport = renders; return; }
    const elapsed = now - reportStartedAt;
    if (elapsed < reportEvery) return;
    if (mode === 'reduced') {
      const t = ticks - ticksAtReport;
      const r = renders - rendersAtReport;
      const perSec = (r / (elapsed / 1000)).toFixed(1);
      log(`[office] rendered ${r} of ${t} ticks in the last ${Math.round(elapsed / 1000)} s (${perSec} renders/s)`);
    }
    reportStartedAt = now; ticksAtReport = ticks; rendersAtReport = renders;
  };

  return {
    step(now) {
      ticks += 1;
      const d = opts.decision();
      const draw = shouldRenderNow({
        mode: d.mode, maxFPS: d.maxFPS, now, lastRenderAt, invalidated,
        // Only consulted when it matters: reading the queues is cheap, but
        // the full path draws regardless.
        changed: d.mode === 'reduced' ? opts.changed() : true
      });
      if (draw) {
        opts.render();
        renders += 1;
        lastRenderAt = now;
        invalidated = false;
      }
      report(now, d.mode);
      return draw;
    },
    invalidate() { invalidated = true; },
    get ticks() { return ticks; },
    get renders() { return renders; }
  };
}
