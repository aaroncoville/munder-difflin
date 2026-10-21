/**
 * Floor performance diagnostic: what the office floor is doing per second,
 * and what makes it draw.
 *
 * The idle cost of the floor on a software GPU is decided by how often it
 * renders (renderOnChange.ts), and what decides that is which containers
 * queue work on Pixi's render group between ticks. Reading that from outside
 * the process needs a remote-debugging port; this reads it from inside and
 * writes a sample to the hive log (kind 'floor-perf') so the live app can be
 * read without attaching to it.
 *
 * Every sample window it reports: renders/s, ticker ticks/s, rAF/s, the
 * canvas size and resolution, the renderer kind, document visibility and
 * focus, whether the ticker runs, each character's status and flags, and the
 * dirty-queue culprits — for every container queued on the stage's render
 * group at the end of a tick, its constructor name, label and a short parent
 * chain, counted over the window, top five.
 *
 * Cost: off, nothing is installed and the per-tick path has a null check per
 * render. On, one ticker callback at priority -10 (after the simulation,
 * before the paint) walks the queues counting — no allocation beyond a map
 * entry per distinct culprit, capped — plus a rAF counter. Samples come every
 * SAMPLE_EVERY_MS for the first EARLY_SAMPLES windows after a scene builds
 * and every LATE_SAMPLE_EVERY_MS after that, so a long-running dev app does
 * not fill log.jsonl.
 *
 * Gate: config `officeDiagnostics: true` (mirrored by App.tsx like the other
 * office settings) OR a dev build (import.meta.env.DEV, passed in by the
 * floor), since the question it answers comes up on the dev build first.
 */
import { FLOOR_PERF_KIND } from '@shared/floorPerfEvent';

export const SAMPLE_EVERY_MS = 15_000;
export const EARLY_SAMPLES = 20;
export const LATE_SAMPLE_EVERY_MS = 300_000;
export const TOP_CULPRITS = 5;
/** Distinct culprits tracked per window; the rest fold into 'other'. */
export const MAX_CULPRITS = 64;
/** The ticker priority the counter runs at: after the simulation (NORMAL, 0),
 *  before the paint (LOW, -25). */
export const COUNTER_PRIORITY = -10;

/** How long to wait before sample number `n` (0-based). */
export function sampleIntervalMs(n: number): number {
  return n < EARLY_SAMPLES ? SAMPLE_EVERY_MS : LATE_SAMPLE_EVERY_MS;
}

/* ─── The gate ──────────────────────────────────────────────────────────── */

let pref = false;

/** Record the `officeDiagnostics` setting; returns true when it changed. */
export function setFloorDiagnosticsPref(next: boolean | undefined): boolean {
  const v = next === true;
  if (v === pref) return false;
  pref = v;
  return true;
}

export function floorDiagnosticsPref(): boolean {
  return pref;
}

/** Whether to install the diagnostic on a scene: the setting, or a dev build
 *  (`dev` is import.meta.env.DEV, passed in by the floor so this module loads
 *  under node). */
export function floorPerfEnabled(dev: boolean): boolean {
  return pref || dev;
}

/* ─── Culprits ──────────────────────────────────────────────────────────── */

/** The slice of a Pixi Container the description reads. */
export interface ContainerLike {
  constructor: { name: string };
  label?: string | null;
  parent?: ContainerLike | null;
}

/** The slice of a Pixi RenderGroup the counter walks (renderOnChange.ts reads
 *  the same queues, without the lists). */
export interface RenderGroupQueues {
  structureDidChange: boolean;
  childrenToUpdate: Record<string, { index: number; list: ContainerLike[] }>;
  childrenRenderablesToUpdate: { index: number; list: ContainerLike[] };
  renderGroupChildren: RenderGroupQueues[];
}

/** `Graphics#halo < Container < Container`: the constructor name, its label
 *  when it has one of its own, and up to `depth` ancestors. */
export function describeContainer(c: ContainerLike, depth = 2): string {
  const name = (n: ContainerLike) => {
    const ctor = n.constructor?.name ?? 'Container';
    return n.label && n.label !== ctor ? `${ctor}#${n.label}` : ctor;
  };
  const parts = [name(c)];
  let p = c.parent;
  for (let i = 0; i < depth && p; i++) { parts.push(name(p)); p = p.parent; }
  return parts.join(' < ');
}

/** Count this tick's queued containers into `into` (one per container, by
 *  description; 'xform:' for transform/alpha/tint updates, 'view:' for
 *  texture/Graphics/text updates, 'structure' for an add/remove/visibility
 *  change). Reads only; the queues are left exactly as found. Returns whether
 *  anything was queued. */
export function countCulprits(group: RenderGroupQueues, into: Map<string, number>): boolean {
  let any = false;
  const bump = (k: string) => {
    if (into.size >= MAX_CULPRITS && !into.has(k)) k = 'other';
    into.set(k, (into.get(k) ?? 0) + 1);
  };
  if (group.structureDidChange) { bump('structure'); any = true; }
  for (const depth in group.childrenToUpdate) {
    const q = group.childrenToUpdate[depth];
    for (let i = 0; i < q.index; i++) { bump('xform: ' + describeContainer(q.list[i])); any = true; }
  }
  const r = group.childrenRenderablesToUpdate;
  for (let i = 0; i < r.index; i++) { bump('view: ' + describeContainer(r.list[i])); any = true; }
  for (const child of group.renderGroupChildren) any = countCulprits(child, into) || any;
  return any;
}

/** The `TOP_CULPRITS` most frequent entries, largest first. */
export function topCulprits(counts: Map<string, number>, n = TOP_CULPRITS): Array<{ what: string; ticks: number }> {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([what, ticks]) => ({ what, ticks }));
}

/* ─── The sampler ───────────────────────────────────────────────────────── */

export interface FloorPerfCharacter {
  id: string;
  status: string;
  active: boolean;
  seated: boolean;
}

export interface FloorPerfApp {
  ticker: {
    started: boolean;
    add(fn: () => void, context?: unknown, priority?: number): unknown;
    remove(fn: () => void, context?: unknown): unknown;
  };
  stage: { renderGroup: RenderGroupQueues | null | undefined };
  renderer: { name: string; resolution: number; width: number; height: number };
}

export interface FloorPerfSample {
  kind: typeof FLOOR_PERF_KIND;
  /** Seconds the window actually covered. */
  windowS: number;
  rendersPerSec: number;
  ticksPerSec: number;
  rafPerSec: number;
  /** Ticks on which something was queued, and the total. */
  dirtyTicks: number;
  ticks: number;
  renders: number;
  canvas: { width: number; height: number; resolution: number };
  renderer: string;
  visibility: string;
  focus: boolean;
  tickerRunning: boolean;
  characters: FloorPerfCharacter[];
  culprits: Array<{ what: string; ticks: number }>;
}

export interface FloorPerfOptions {
  app: FloorPerfApp;
  characters: () => FloorPerfCharacter[];
  /** Where samples go: the hive log, through window.cth.hiveLogEvent. */
  log: (sample: FloorPerfSample) => void;
  /** Injectable for tests. */
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  requestFrame?: (fn: () => void) => unknown;
  cancelFrame?: (handle: unknown) => void;
  doc?: { visibilityState: string; hasFocus(): boolean };
}

export interface FloorPerf {
  /** The paint calls this once per app.render(). */
  onRender(): void;
  /** Take a sample now (what the timer does), resetting the window. */
  sample(): FloorPerfSample;
  /** Remove the ticker callback, the rAF loop and the timer. Idempotent. */
  dispose(): void;
}

export function createFloorPerf(opts: FloorPerfOptions): FloorPerf {
  const now = opts.now ?? (() => performance.now());
  const schedule = opts.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const requestFrame = opts.requestFrame ?? ((fn: () => void) => requestAnimationFrame(fn));
  const cancelFrame = opts.cancelFrame ?? ((h: unknown) => cancelAnimationFrame(h as number));
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : { visibilityState: 'unknown', hasFocus: () => false });

  let ticks = 0, dirtyTicks = 0, renders = 0, frames = 0;
  let culprits = new Map<string, number>();
  let windowStart = now();
  let samples = 0;
  let timer: unknown = null;
  let frame: unknown = null;
  let disposed = false;

  const onTick = () => {
    ticks += 1;
    const rg = opts.app.stage.renderGroup;
    if (rg && countCulprits(rg, culprits)) dirtyTicks += 1;
  };
  opts.app.ticker.add(onTick, undefined, COUNTER_PRIORITY);

  const onFrame = () => {
    frames += 1;
    frame = requestFrame(onFrame);
  };
  frame = requestFrame(onFrame);

  const sample = (): FloorPerfSample => {
    const t = now();
    const windowS = Math.max((t - windowStart) / 1000, 1e-3);
    const r = opts.app.renderer;
    const s: FloorPerfSample = {
      kind: FLOOR_PERF_KIND,
      windowS: Math.round(windowS * 100) / 100,
      rendersPerSec: Math.round((renders / windowS) * 10) / 10,
      ticksPerSec: Math.round((ticks / windowS) * 10) / 10,
      rafPerSec: Math.round((frames / windowS) * 10) / 10,
      dirtyTicks, ticks, renders,
      canvas: { width: r.width, height: r.height, resolution: r.resolution },
      renderer: r.name,
      visibility: doc.visibilityState,
      focus: doc.hasFocus(),
      tickerRunning: opts.app.ticker.started,
      characters: opts.characters(),
      culprits: topCulprits(culprits)
    };
    ticks = 0; dirtyTicks = 0; renders = 0; frames = 0;
    culprits = new Map();
    windowStart = t;
    return s;
  };

  const arm = () => {
    timer = schedule(() => {
      timer = null;
      if (disposed) return;
      try { opts.log(sample()); } catch { /* a diagnostic must never take the floor down */ }
      samples += 1;
      arm();
    }, sampleIntervalMs(samples));
  };
  arm();

  return {
    onRender() { renders += 1; },
    sample,
    dispose() {
      if (disposed) return;
      disposed = true;
      opts.app.ticker.remove(onTick, undefined);
      if (frame !== null) { cancelFrame(frame); frame = null; }
      if (timer !== null) { cancel(timer); timer = null; }
    }
  };
}
