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
 * focus, whether the ticker runs, the cast as counts (how many, how many
 * active and seated, how many per status), and the dirty-queue culprits —
 * for every container queued on the stage's render group at the end of a
 * tick, its constructor name, a class-like label and a short parent chain,
 * counted over the window, top five.
 *
 * A sample is bounded and anonymous by construction, since it is written to
 * the hive's log: no agent ids or names (they come from what the user typed),
 * no per-character rows, status keys from a fixed list with the rest folded
 * into 'other', at most TOP_CULPRITS culprits of at most MAX_CULPRIT_CHARS
 * each, and a label only when it looks like an identifier (LABEL_RE), never
 * free text. The sampler also runs the shared acceptance check before the
 * IPC, so nothing over the byte cap is sent.
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
 * office settings) OR a dev build (import.meta.env.DEV, recorded once by
 * App.tsx), since the question it answers comes up on the dev build first.
 */
import { FLOOR_PERF_KIND, acceptFloorPerfEvent } from '@shared/floorPerfEvent';

export const SAMPLE_EVERY_MS = 15_000;
export const EARLY_SAMPLES = 20;
export const LATE_SAMPLE_EVERY_MS = 300_000;
export const TOP_CULPRITS = 5;
/** Distinct culprits tracked per window; the rest fold into 'other'. */
export const MAX_CULPRITS = 64;
/** The longest culprit key a sample carries, prefix ('xform: ', 'view: ')
 *  included. */
export const MAX_CULPRIT_CHARS = 96;
/** A container label worth reporting: a short identifier, not a name. */
export const LABEL_RE = /^[a-z][a-z0-9_-]{0,23}$/i;
/** The statuses a sample counts by; anything else is 'other'. */
export const CAST_STATUSES = ['idle', 'working', 'thinking', 'waiting', 'blocked', 'compacting', 'looping', 'success', 'ghost'] as const;
/** The ticker priority the counter runs at: after the simulation (NORMAL, 0),
 *  before the paint (LOW, -25). */
export const COUNTER_PRIORITY = -10;

/** How long to wait before sample number `n` (0-based). */
export function sampleIntervalMs(n: number): number {
  return n < EARLY_SAMPLES ? SAMPLE_EVERY_MS : LATE_SAMPLE_EVERY_MS;
}

/* ─── The gate ──────────────────────────────────────────────────────────── */

let pref = false;
let dev = false;

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

/** Record whether this is a dev build (import.meta.env.DEV, set once by
 *  App.tsx: `import.meta` cannot appear in a module the node tests load). */
export function setFloorDiagnosticsDev(isDev: boolean): void {
  dev = isDev === true;
}

/** Whether to install the diagnostic on a scene: the setting, or a dev build. */
export function floorPerfEnabled(): boolean {
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
 *  when it has one of its own that looks like an identifier (LABEL_RE — a
 *  label can be anything, and a nameplate's would be a name), and up to
 *  `depth` ancestors. The length cap is applied to the complete culprit key
 *  (culpritKey), prefix included. */
export function describeContainer(c: ContainerLike, depth = 2): string {
  const name = (n: ContainerLike) => {
    const ctor = n.constructor?.name ?? 'Container';
    const label = n.label;
    return label && label !== ctor && LABEL_RE.test(label) ? `${ctor}#${label}` : ctor;
  };
  const parts = [name(c)];
  let p = c.parent;
  for (let i = 0; i < depth && p; i++) { parts.push(name(p)); p = p.parent; }
  return parts.join(' < ');
}

/** The key a queued container is counted under: the queue it sits in and
 *  its description, cut to MAX_CULPRIT_CHARS as a whole. */
export function culpritKey(queue: 'xform' | 'view', c: ContainerLike): string {
  return `${queue}: ${describeContainer(c)}`.slice(0, MAX_CULPRIT_CHARS);
}

/** One character's state, as the floor hands it over: no id, no name. */
export interface FloorPerfCastMember {
  status: string;
  active: boolean;
  seated: boolean;
}

/** The cast as counts: a fixed set of keys whatever the floor holds. */
export interface FloorPerfCast {
  total: number;
  active: number;
  seated: number;
  byStatus: Record<(typeof CAST_STATUSES)[number] | 'other', number>;
}

/** Fold the cast into counts. Statuses outside CAST_STATUSES count as 'other'. */
export function summarizeCast(members: readonly FloorPerfCastMember[]): FloorPerfCast {
  const byStatus = Object.fromEntries([...CAST_STATUSES, 'other'].map((k) => [k, 0])) as FloorPerfCast['byStatus'];
  let active = 0, seated = 0;
  for (const m of members) {
    const key = (CAST_STATUSES as readonly string[]).includes(m.status) ? (m.status as (typeof CAST_STATUSES)[number]) : 'other';
    byStatus[key] += 1;
    if (m.active) active += 1;
    if (m.seated) seated += 1;
  }
  return { total: members.length, active, seated, byStatus };
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
    for (let i = 0; i < q.index; i++) { bump(culpritKey('xform', q.list[i])); any = true; }
  }
  const r = group.childrenRenderablesToUpdate;
  for (let i = 0; i < r.index; i++) { bump(culpritKey('view', r.list[i])); any = true; }
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
  cast: FloorPerfCast;
  culprits: Array<{ what: string; ticks: number }>;
  tags?: Record<string, string | number | boolean>;
}

export interface FloorPerfOptions {
  app: FloorPerfApp;
  /** The cast on this canvas, statuses and flags only; a layer with none
   *  (the Study's ambiance) omits it. */
  cast?: () => readonly FloorPerfCastMember[];
  /** Carried on every sample as-is: which scene, which room, which cap. */
  tags?: Record<string, string | number | boolean>;
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
  // No rAF (a test host): no frame count, and nothing else lost.
  const hasRaf = typeof requestAnimationFrame === 'function';
  const requestFrame = opts.requestFrame ?? ((fn: () => void) => (hasRaf ? requestAnimationFrame(fn) : null));
  const cancelFrame = opts.cancelFrame ?? ((h: unknown) => { if (hasRaf && h !== null) cancelAnimationFrame(h as number); });
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
      cast: summarizeCast(opts.cast?.() ?? []),
      culprits: topCulprits(culprits),
      ...(opts.tags ? { tags: opts.tags } : {})
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
      try {
        const s = sample();
        // The shared acceptance check, before the IPC: an oversized sample
        // is dropped here, not in main.
        if (acceptFloorPerfEvent(s)) opts.log(s);
      } catch { /* a diagnostic must never take the floor down */ }
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
