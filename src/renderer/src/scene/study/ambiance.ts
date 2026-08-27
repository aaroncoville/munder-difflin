/**
 * The arithmetic behind the Study's ambiance — all of it, and none of the pixi.
 *
 * The layer above this file is a canvas and a ticker. Everything that decides
 * what the room looks like — where the dust sits, how it drifts, how a candle
 * flickers, whether any of it runs at all — is here, as pure functions of their
 * arguments. That split is not tidiness: a particle field is the kind of code
 * that is impossible to check once it is inside a renderer, and trivial to
 * check outside one.
 *
 * Three properties are load-bearing and each has a reason:
 *
 *  - **Seeding is deterministic.** A room that reseeds its dust on every render
 *    is a strobe, not a room. The seed is a property of the ROOM, so the same
 *    room settles the same way and two rooms never settle identically.
 *  - **Drift wraps.** A mote that leaves the panel is gone for good, and a
 *    field that leaks empties itself over a long session — the room looks right
 *    for a minute and dead after an hour.
 *  - **Counts are capped.** A house is many panels and each one runs its own
 *    field; the caps are what keeps "a lot of rooms" from meaning "a lot of
 *    particles per room times a lot of rooms".
 */
import type { LightPoint } from './roomManifest';

/** Dust motes per room. */
export const MOTE_CAP = 24;

/** Candle glows per room. `room.json` may mark more light points than a room
 *  can afford to light; the rest are painted into the panel already. */
export const GLOW_CAP = 12;

export interface Mote {
  x: number;
  y: number;
  /** px per second. Dust in still air falls slowly and wanders sideways. */
  vx: number;
  vy: number;
  r: number;
  /** 0..1 — how solid this one is, so the field has depth rather than being
   *  one sheet of identical specks. */
  a: number;
}

/** Mulberry32 — a small deterministic PRNG. Dependency-free, and good enough
 *  to spread a couple of dozen specks without visible banding. */
function rng(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Turn any string — a room id — into a seed, so a room's dust is a function
 *  of which room it is rather than of what order the rooms mounted in. */
export function seedFor(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deal a room's dust. Never more than `MOTE_CAP`, however many are asked for. */
export function seedMotes(seed: number, count: number, view: { w: number; h: number }): Mote[] {
  const n = Math.max(0, Math.min(MOTE_CAP, Math.floor(count)));
  const rand = rng(seed);
  const motes: Mote[] = [];
  for (let i = 0; i < n; i++) {
    motes.push({
      x: rand() * view.w,
      y: rand() * view.h,
      // Sideways drift either way, and always a slow fall: dust in a still room
      // settles, and a field with no net direction reads as static noise.
      vx: (rand() - 0.5) * 5,
      vy: 1.5 + rand() * 4,
      r: 0.6 + rand() * 1.4,
      a: 0.18 + rand() * 0.34
    });
  }
  return motes;
}

/**
 * Advance the dust by `dtMs`, wrapping at the panel's edges.
 *
 * Wrapping rather than respawning, because a mote that reappears at a fresh
 * random position is a blink, and at this density the eye catches it. Mutates
 * in place: this runs once per frame per room, and allocating a new array each
 * time is the one thing here that would actually cost something.
 */
export function driftMotes(motes: Mote[], dtMs: number, view: { w: number; h: number }): void {
  if (!(view.w > 0) || !(view.h > 0)) return;
  // A tab that was in the background hands back an enormous dt on its first
  // frame; without a clamp every mote jumps at once and the room twitches.
  const dt = Math.min(Math.max(dtMs, 0), 100) / 1000;
  for (const m of motes) {
    m.x += m.vx * dt;
    m.y += m.vy * dt;
    if (m.x < 0) m.x += view.w;
    else if (m.x > view.w) m.x -= view.w;
    if (m.y < 0) m.y += view.h;
    else if (m.y > view.h) m.y -= view.h;
  }
}

/**
 * A candle's brightness at time `t`, for the `i`th light in the room.
 *
 * Two sine waves at unrelated frequencies, which is the cheapest thing that
 * does not read as a pulse — one period is obvious within seconds. The index
 * offsets the phase, because candles flickering in lockstep read as one effect
 * applied to the room rather than as several flames.
 *
 * Never reaches 0: a candle that goes out and comes back is a fault light.
 */
export function flicker(t: number, i: number): number {
  const p = i * 1.7;
  const a = Math.sin(t / 310 + p);
  const b = Math.sin(t / 137 + p * 2.3);
  return 0.75 + 0.15 * a + 0.1 * b;
}

/**
 * The hearth's brightness at time `t`.
 *
 * A separate curve from `flicker`, because a fire is not a big candle. The
 * candle curve swings 0.5 → 1.0, which is a doubling of brightness, and on the
 * hard-edged disc the hearth used to be drawn as it read as a circle being
 * switched on and off over the grate. Firelight moves constantly and moves
 * very little: the band here is a tenth as wide, the periods are seconds rather
 * than fractions of one, and three superposed waves at unrelated frequencies
 * keep it from settling into a loop the eye can find and start counting.
 *
 * Bounded to [0.80, 1.00] by construction — the amplitudes sum to 0.10 either
 * side of 0.90 — and the largest step between two frames at 60Hz is under
 * 0.003, which is what "no blink" means as a number.
 */
export function hearthFlicker(t: number): number {
  return 0.90
    + 0.045 * Math.sin(t / 1130)
    + 0.032 * Math.sin(t / 701 + 1.3)
    + 0.023 * Math.sin(t / 389 + 2.7);
}

/** How much wider than a candle the hearth throws its light. The fire has to
 *  spill past the firebox it is painted inside, or it reads as a mark on the
 *  painting rather than as the thing lighting the room. */
export const HEARTH_SPREAD = 2.4;

/**
 * One glow, as nested rings from the outside in.
 *
 * A radial falloff without a gradient texture to keep per room. Additive
 * blending sums the rings, so a quadratic alpha ramp over evenly spaced radii
 * integrates to a soft centre-weighted glow — where a single filled circle,
 * however translucent, has an edge, and an edge is what makes a light look
 * like a sticker laid on the paint.
 *
 * The outermost ring is the radius asked for and is nearly invisible; the
 * alphas sum to the brightness at the centre.
 */
export function glowRings(radius: number, steps = 8): { r: number; alpha: number }[] {
  const CENTRE = 0.55;
  let weight = 0;
  for (let i = 1; i <= steps; i++) weight += i * i;
  const rings: { r: number; alpha: number }[] = [];
  for (let i = 0; i < steps; i++) {
    rings.push({
      r: radius * (1 - i / steps),
      alpha: (CENTRE * (i + 1) * (i + 1)) / weight
    });
  }
  return rings;
}

/** The lights a room actually draws, capped. */
export function lightsFor<T>(points: readonly T[]): T[] {
  return points.slice(0, GLOW_CAP);
}

/** One glow the layer will draw: where it hangs in the panel, and how it burns. */
export interface Glow {
  x: number;
  y: number;
  /** A fire rather than a flame: the deeper colour, the wider throw, the ember
   *  core and the slow curve all hang off this one bit. */
  hearth: boolean;
}

/**
 * The lights a room draws, capped and classified.
 *
 * Which light is the fire is a property of the LIGHT, and this is the whole
 * reason: the hearth is an anchor the floor plan may stand inside somebody
 * else's room, so the fire can be one glow among a parlour's candles. Asking
 * the room what kind it is answers a question about the whole panel, and a
 * panel with a fire in the corner of it has no kind that means "fire".
 */
export function glowsFor(points: readonly LightPoint[]): Glow[] {
  return lightsFor(points).map((p) => ({ x: p.x, y: p.y, hearth: p.kind === 'hearth' }));
}

/**
 * Whether the layer runs at all.
 *
 * Reduced motion is an off-switch, not a slow-down — somebody who has asked
 * the system for less movement has asked for this exactly. Hidden is a pause:
 * a document nobody is looking at should not be animating, and a background tab
 * that keeps a pixi ticker alive is a battery complaint waiting to be filed.
 */
export function ambianceEnabled(
  state: { reducedMotion: boolean; visible: boolean }
): boolean {
  return !state.reducedMotion && state.visible;
}
