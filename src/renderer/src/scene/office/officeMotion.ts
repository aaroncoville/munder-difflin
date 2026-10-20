/**
 * How hard the office floor should work to animate.
 *
 * The floor is a Pixi scene whose ticker runs every character's idle animation
 * at the display's refresh rate, drawing into a canvas rendered at >= 2x device
 * pixels (see the resolution note in OfficeFloor.tsx). On a real GPU that is
 * nearly free. On a machine where Chromium backs WebGL with SwiftShader — WSL2/
 * WSLg, most VMs — it is pure CPU: seven rasterizer threads in the GPU process
 * painting ~350 megapixels a second of people sitting at desks, and taking
 * whatever cores are free to do it. Measured on WSLg: ~5.9 cores with nothing
 * else running.
 *
 * So the floor's motion is a decision with three inputs: the user's setting
 * (`officeMotion` in config: 'auto' | 'full' | 'reduced'), the cached WebGL
 * classification the terminal renderer already probes (terminalRenderer.ts — one
 * probe per process, reused here, not duplicated), and the OS's
 * `prefers-reduced-motion` hint, which 'auto' honours too. The outcome is a
 * mode, and the mode fixes the ticker's frame cap and the canvas resolution.
 *
 * 'full' is today's behaviour, bit for bit: uncapped ticker, resolution
 * max(devicePixelRatio, 2), antialias off. 'reduced' caps the ticker at
 * REDUCED_MOTION_MAX_FPS and renders at 1x, which on a 1600×900 floor is
 * 1.44 Mpx × 15 = ~22 Mpx/s instead of 5.76 Mpx × 60 = ~346 Mpx/s: sixteen
 * times less rasterisation for a scene that, at a glance, looks the same.
 * Pixel-art sprites with nearest-neighbour scaling do not mind 1x; bubble text
 * gets a little softer, which is the trade. The simulation itself is unchanged
 * at 15 fps: the two per-frame constants it had are time-based now
 * (frameRate.ts).
 *
 * 'reduced' also lets the ticker stop outright while nobody is watching: once
 * the window has been unfocused for UNATTENDED_GRACE_MS there is nothing to
 * animate for anyone (`unattendedPauseDelay`), and focus brings it back. Only
 * the blur counts. An earlier version also re-armed the grace on every agent
 * state change, on the theory that a changing floor was worth watching; on a
 * busy floor the agents slice changes several times a second for as long as
 * anyone is working, so the pause never came, and an unfocused window drew
 * all afternoon.
 *
 * `createOfficeMotionGate` is the runtime: it owns the inputs' listeners and
 * the grace timer, and applies a change to the LIVE Pixi application (maxFPS
 * on the ticker, resolution through renderer.resize) rather than rebuilding
 * the scene. Everything takes injected dependencies so node:test can drive it
 * with a fake window, clock and app (test/office-motion.test.cjs); only
 * `currentOfficeMotion` and the defaults touch the DOM, lazily.
 */
import { webglRendererInfo, type WebglClassification } from '@/components/terminalRenderer';

/** The user's setting. 'auto' is the default: reduced on a software GPU or when
 *  the OS asks for reduced motion, full otherwise. */
export type OfficeMotionPref = 'auto' | 'full' | 'reduced';

export type OfficeMotionMode = 'full' | 'reduced';

/** Frame cap on the reduced path. Idle animations are a few frames a second
 *  anyway; 15 keeps walking smooth enough to read while quartering the work. */
export const REDUCED_MOTION_MAX_FPS = 15;
/** Canvas resolution on the reduced path: one device pixel per CSS pixel. */
export const REDUCED_MOTION_RESOLUTION = 1;
/** The floor of the full path's resolution (see OfficeFloor.tsx for why 2). */
export const FULL_MOTION_MIN_RESOLUTION = 2;
/** How long a window has to sit unfocused before the reduced path stops the
 *  ticker altogether. */
export const UNATTENDED_GRACE_MS = 30_000;

export interface OfficeMotionDecision {
  mode: OfficeMotionMode;
  /** Pixi `Ticker.maxFPS`; 0 means uncapped (Pixi's own default). */
  maxFPS: number;
  /** Pixi `Application.init({ resolution })`, used with autoDensity. */
  resolution: number;
  /** Pixi `Application.init({ antialias })`. Off on both paths today. */
  antialias: boolean;
}

/** Which mode the three inputs add up to. 'full' and 'reduced' are the user
 *  overriding everything; 'auto' reduces on a POSITIVE software finding or an
 *  OS reduced-motion request, and treats 'unknown' as hardware so a masked
 *  renderer string (Macs) changes nothing. */
export function resolveOfficeMotionMode(
  pref: OfficeMotionPref | undefined,
  classification: WebglClassification,
  prefersReducedMotion: boolean
): OfficeMotionMode {
  switch (pref) {
    case 'full': return 'full';
    case 'reduced': return 'reduced';
    case 'auto':
    default:
      return classification === 'software' || prefersReducedMotion ? 'reduced' : 'full';
  }
}

/** Today's resolution rule, unchanged: real device pixels, floored at 2 so the
 *  half-scale-supersampled bubble text stays legible at 100% scaling. */
export function fullMotionResolution(devicePixelRatio: number): number {
  return Math.max(devicePixelRatio || 1, FULL_MOTION_MIN_RESOLUTION);
}

/** The decision: mode plus the two renderer knobs it fixes. */
export function decideOfficeMotion(
  pref: OfficeMotionPref | undefined,
  classification: WebglClassification,
  prefersReducedMotion: boolean,
  devicePixelRatio: number
): OfficeMotionDecision {
  const mode = resolveOfficeMotionMode(pref, classification, prefersReducedMotion);
  if (mode === 'reduced') {
    return { mode, maxFPS: REDUCED_MOTION_MAX_FPS, resolution: REDUCED_MOTION_RESOLUTION, antialias: false };
  }
  return { mode, maxFPS: 0, resolution: fullMotionResolution(devicePixelRatio), antialias: false };
}

/** How long until an unwatched floor may stop its ticker, or null when it must
 *  keep running: the window is focused, or the mode is 'full' (today's
 *  behaviour, which never pauses for focus). The grace counts from the blur
 *  and nothing else: what the agents are doing does not change whether anyone
 *  is looking. Zero means "now". */
export function unattendedPauseDelay(input: {
  mode: OfficeMotionMode;
  focused: boolean;
  /** When the window last lost focus. */
  blurredAt: number;
  now: number;
  graceMs?: number;
}): number | null {
  if (input.focused || input.mode !== 'reduced') return null;
  const grace = input.graceMs ?? UNATTENDED_GRACE_MS;
  return Math.max(0, grace - (input.now - input.blurredAt));
}

/* ─── The mirrored setting ───────────────────────────────────────────────────
 *
 * Same shape as terminalRenderer.ts: App.tsx mirrors config into a module
 * variable on initial load and on every config:changed, and the gate below
 * subscribes so a change in Settings takes effect on the live floor.
 */

let pref: OfficeMotionPref = 'auto';
const listeners = new Set<() => void>();

export function getOfficeMotionPref(): OfficeMotionPref {
  return pref;
}

/** Record the setting. Returns true when it changed. Junk falls back to 'auto'. */
export function setOfficeMotionPref(next: OfficeMotionPref | undefined): boolean {
  const normalized: OfficeMotionPref =
    next === 'full' || next === 'reduced' || next === 'auto' ? next : 'auto';
  if (normalized === pref) return false;
  pref = normalized;
  return true;
}

/** Subscribe to setting changes. */
export function subscribeOfficeMotionPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** For tests: how many subscribers the setting has. */
export function officeMotionPrefListenerCount(): number {
  return listeners.size;
}

/** What App.tsx calls: record the setting and wake the floor if it changed. */
export function applyOfficeMotionPref(next: OfficeMotionPref | undefined): void {
  if (!setOfficeMotionPref(next)) return;
  for (const l of [...listeners]) l();
}

/* ─── The DOM-touching bit ────────────────────────────────────────────────── */

export const REDUCED_MOTION_MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

/** The OS hint, read now. False when matchMedia is unavailable. */
export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION_MEDIA_QUERY)?.matches;
  } catch { return false; }
}

let reducedLogged = false;

/** The decision for this process, right now: the mirrored setting, the cached
 *  WebGL probe, the OS hint and the current devicePixelRatio. Logs the
 *  automatic reduction once, with the renderer string, so a floor running at
 *  15 fps is explained in the console rather than a mystery. */
export function currentOfficeMotion(): OfficeMotionDecision {
  const info = webglRendererInfo();
  const osReduced = prefersReducedMotion();
  const dpr = typeof window !== 'undefined' ? (window.devicePixelRatio || 1) : 1;
  const decision = decideOfficeMotion(pref, info.classification, osReduced, dpr);
  if (decision.mode === 'reduced' && pref === 'auto' && !reducedLogged) {
    reducedLogged = true;
    const why = info.classification === 'software'
      ? `software GPU (${info.renderer ?? 'unknown'})`
      : 'prefers-reduced-motion';
    console.info(`[OfficeFloor] reduced motion: ${why} — ${REDUCED_MOTION_MAX_FPS} fps, ${REDUCED_MOTION_RESOLUTION}x resolution`);
  }
  return decision;
}

/* ─── The gate: inputs in, live application out ───────────────────────────── */

type Listener = () => void;

/** The slice of a Pixi Application the gate touches. */
export interface MotionGateApp {
  ticker: { maxFPS: number };
  /** `resize(w, h, resolution)` re-sizes the canvas source at the new density
   *  and, with autoDensity, keeps the CSS size — Pixi 8's live-resolution path. */
  renderer: { resolution: number; resize(width: number, height: number, resolution?: number): void };
  /** Logical (CSS) size, which is what resize wants. */
  screen: { width: number; height: number };
}

export interface MotionGateOptions {
  /** Focus source — `window` in the app. */
  target: {
    addEventListener(type: 'focus' | 'blur', fn: Listener): void;
    removeEventListener(type: 'focus' | 'blur', fn: Listener): void;
  };
  hasFocus: () => boolean;
  /** Called when the unattended verdict flips, so the floor can re-run
   *  shouldRunTicker against its other gates. */
  onUnattendedChange: (unattended: boolean) => void;
  /** The OS hint, live. Null when matchMedia is unavailable. */
  reducedMotionQuery?: {
    addEventListener(type: 'change', fn: Listener): void;
    removeEventListener(type: 'change', fn: Listener): void;
  } | null;
  /** The setting's subscription; defaults to the mirrored one above. */
  onPrefChange?: (listener: Listener) => () => void;
  /** The decision, re-read on every input change; defaults to currentOfficeMotion. */
  decide?: () => OfficeMotionDecision;
  /** Injectable for tests. */
  now?: () => number;
  schedule?: (fn: Listener, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  graceMs?: number;
}

export interface OfficeMotionGate {
  /** True while the reduced path has decided nobody is watching. */
  readonly unattended: boolean;
  /** The decision in force. */
  readonly decision: OfficeMotionDecision;
  /** Apply the decision to this app now and on every input change until
   *  detach(). The floor attaches once init() has produced a renderer. */
  attach(app: MotionGateApp): void;
  detach(): void;
  /** Drop every listener and timer. Idempotent. */
  dispose(): void;
}

export function createOfficeMotionGate(opts: MotionGateOptions): OfficeMotionGate {
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn: Listener, ms: number) => setTimeout(fn, ms));
  const cancel = opts.cancel ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const decide = opts.decide ?? currentOfficeMotion;
  const onPrefChange = opts.onPrefChange ?? subscribeOfficeMotionPref;

  let decision = decide();
  let app: MotionGateApp | null = null;
  let focused = opts.hasFocus();
  // Starts "now": a floor that is born unfocused still waits the whole grace
  // before it stops.
  let blurredAt = now();
  let unattended = false;
  let timer: unknown = null;
  let disposed = false;

  const setUnattended = (next: boolean) => {
    if (next === unattended) return;
    unattended = next;
    opts.onUnattendedChange(next);
  };

  /** Re-plan from the current inputs: clear the verdict, and (re)start the
   *  grace timer if one applies. */
  const arm = () => {
    if (timer !== null) { cancel(timer); timer = null; }
    const delay = unattendedPauseDelay({
      mode: decision.mode, focused, blurredAt, now: now(), graceMs: opts.graceMs
    });
    if (delay === null) { setUnattended(false); return; }
    if (delay === 0) { setUnattended(true); return; }
    setUnattended(false);
    timer = schedule(() => { timer = null; setUnattended(true); }, delay);
  };

  const apply = () => {
    if (!app) return;
    app.ticker.maxFPS = decision.maxFPS;
    if (app.renderer.resolution !== decision.resolution) {
      app.renderer.resize(app.screen.width, app.screen.height, decision.resolution);
    }
  };

  const onFocus = () => { focused = true; arm(); };
  const onBlur = () => { focused = false; blurredAt = now(); arm(); };
  const onInputs = () => { decision = decide(); apply(); arm(); };

  opts.target.addEventListener('focus', onFocus);
  opts.target.addEventListener('blur', onBlur);
  const offPref = onPrefChange(onInputs);
  opts.reducedMotionQuery?.addEventListener('change', onInputs);
  arm();

  return {
    get unattended() { return unattended; },
    get decision() { return decision; },
    attach(next) { app = next; apply(); },
    detach() { app = null; },
    dispose() {
      if (disposed) return;
      disposed = true;
      app = null;
      if (timer !== null) { cancel(timer); timer = null; }
      opts.target.removeEventListener('focus', onFocus);
      opts.target.removeEventListener('blur', onBlur);
      offPref();
      opts.reducedMotionQuery?.removeEventListener('change', onInputs);
    }
  };
}
