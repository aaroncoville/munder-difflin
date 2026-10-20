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
 * gets a little softer, which is the trade.
 *
 * 'reduced' also lets the ticker stop outright while nobody is watching: once
 * the window has been unfocused for UNATTENDED_GRACE_MS with no agent changing
 * state, there is nothing to animate for anyone (`unattendedPauseDelay`).
 *
 * Everything here except `currentOfficeMotion` is pure — no DOM, no Pixi — so
 * node:test can pin it (test/office-motion.test.cjs).
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
/** How long an unfocused window has to sit with no agent state change before
 *  the reduced path stops the ticker altogether. */
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
 *  behaviour, which never pauses for focus). Zero means "now": the grace has
 *  already elapsed since the last agent state change. */
export function unattendedPauseDelay(input: {
  mode: OfficeMotionMode;
  focused: boolean;
  lastAgentChangeAt: number;
  now: number;
  graceMs?: number;
}): number | null {
  if (input.focused || input.mode !== 'reduced') return null;
  const grace = input.graceMs ?? UNATTENDED_GRACE_MS;
  return Math.max(0, grace - (input.now - input.lastAgentChangeAt));
}

/* ─── The mirrored setting ───────────────────────────────────────────────────
 *
 * Same shape as terminalRenderer.ts: App.tsx mirrors config into a module
 * variable on initial load and on every config:changed, and OfficeFloor
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

/** Subscribe to setting changes (useSyncExternalStore shape). */
export function subscribeOfficeMotionPref(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
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
