/**
 * The pixi canvas that sits between a painted room and the cards on top of it.
 *
 * The spec calls ambiance required rather than polish, and this is what it
 * amounts to: candlelight that moves at the points the manifest marks, dust
 * drifting in the light, and a slow warm haze over the hearth. It is a thin
 * layer on purpose — no gameplay, no state, no input.
 *
 * Four constraints shape every decision below.
 *
 * **It cannot be clickable.** Every card, room and commission in the Study is a
 * DOM element underneath this canvas. A canvas that took pointer events would
 * swallow all of them, and the failure would look like "the Study stopped
 * responding" rather than like a graphics bug. So the host is
 * `pointer-events: none` and pixi's own event system is switched off at the
 * root, which is the belt to that braces.
 *
 * **It cannot be eager.** `pixi.js` is a large dependency and the office floor
 * — every user not in this theme — must not pay for it. It is loaded by dynamic
 * `import()` inside the effect, so the chunk is only fetched once a room has
 * actually mounted under the occult theme.
 *
 * **It has to stop.** A ticker running in a hidden window is a battery
 * complaint, and `prefers-reduced-motion` is a request to be taken literally,
 * not damped. Both are read here and both stop the ticker outright.
 *
 * **It has to survive being unmounted mid-load.** The dynamic import means
 * there is a window between "the room mounted" and "pixi is here" in which the
 * room can be gone — resized, rerendered, the theme switched back. Every await
 * is followed by a liveness check, and the application is destroyed on the way
 * out whichever side of that window we are on. A WebGL context leaked per room
 * per resize is the failure mode the office floor has already been bitten by.
 */
import { useEffect, useRef, useState } from 'react';
import type { Room } from './roomManifest';
import {
  HEARTH_SPREAD, MOTE_CAP, ambianceEnabled, driftMotes, flicker, glowRings, glowsFor,
  hearthFlicker, seedFor, seedMotes, type Mote
} from './ambiance';

interface ViewBox { x: number; y: number; w: number; h: number }

/** Candlelight, as a colour. Matches `--cth-gilt`; pixi takes a number. */
const CANDLE = 0xc9a227;
/** The hearth's own light — deeper and redder than a candle. `--cth-coral`. */
const HEARTH = 0xb0524e;
/** The coal under it, hotter than the light it throws. `--cth-peach`. */
const EMBER = 0xc98a4b;

/** Does this machine want less movement? Read once per mount, and re-read on
 *  change, because somebody can turn it on while the app is open. */
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const read = (): void => setReduced(mq.matches);
    read();
    mq.addEventListener('change', read);
    return () => mq.removeEventListener('change', read);
  }, []);
  return reduced;
}

/** Is anybody looking? */
function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const read = (): void => setVisible(!document.hidden);
    read();
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return visible;
}

/**
 * Start the pixi build-out, and let it fail.
 *
 * Two awaits in there can reject and neither is under this app's control: the
 * dynamic `import()` (a chunk missing from a patched install, a renderer
 * offline) and `Application.init` (a machine with no working WebGL context).
 * Ambiance is decoration over a room that is already correct without it, so
 * the only sensible outcome is a room with no ambiance — the failure is
 * visible as the candles not lighting.
 *
 * What must NOT happen is the rejection escaping: unhandled, it reaches the
 * window as an error report nobody can act on, and a host configured to treat
 * unhandled rejections as fatal takes the whole renderer down over a
 * decoration. Hence a catch that deliberately says nothing.
 */
export function startAmbiance(build: () => Promise<void>): void {
  void build().catch(() => {
    /* No ambiance. The room, the cards and the commissions are unaffected. */
  });
}

/** Anything holding a GPU context until it is told to let go. Declared as a
 *  method rather than a function-typed property so that pixi's own wider
 *  `destroy` overload satisfies it. */
interface Destroyable {
  destroy(removeView: boolean, opts: unknown): void;
}

/**
 * A constructed resource, and the one call that takes it down.
 *
 * `release` is idempotent on purpose. The build's failure path and the effect's
 * cleanup can both reach the same resource, in either order — an unmount that
 * lands between `init` rejecting and the catch running is exactly that race —
 * and destroying a pixi Application twice is an error of its own.
 *
 * `release` is also a *request*. A half-constructed resource is not always able
 * to survive its own `destroy`, and asking it to anyway throws from wherever
 * the request came from — which is React's cleanup. So a request arriving
 * during `initialize` is held until that step has settled and destruction is
 * meaningful again.
 */
export interface Held<T> {
  value: T;
  /**
   * Run the one step that leaves `value` unable to be destroyed, and report
   * whether the caller should carry on building.
   *
   * `false` means a release arrived while the step was in flight: it has been
   * honoured now that it can be, and there is nothing left to build on. A
   * rejection travels unchanged — the value never reached a state its own
   * `destroy` handles, so nothing is destroyed and nothing masks the failure.
   */
  initialize: (step: () => Promise<void>) => Promise<boolean>;
  release: () => void;
}

/**
 * Construct, hand the handle out, then build — destroying on the way out if the
 * build fails.
 *
 * The constructor allocates before anything is awaited, and `init` allocates
 * the canvas and the GL context before it can reject. So there is no point
 * between the constructor and the last line of setup at which simply dropping
 * the reference is free: whatever was built has to be destroyed. A handle
 * published only once setup has finished is a handle nobody holds during the
 * entire window in which the build can fail, and the caller's deliberately
 * silent catch then swallows the failure with the context still open — a leak
 * per room, per resize, per retry.
 *
 * `hold` therefore runs before the first await, so a cleanup arriving mid-build
 * has something to destroy; the failure path destroys through the same handle;
 * and `release` makes that exactly once between them. The failure keeps
 * travelling so the caller can still decline it.
 */
export async function buildOrDestroy<T extends Destroyable>(
  construct: () => T,
  hold: (held: Held<T>) => void,
  build: (value: T, held: Held<T>) => Promise<void>
): Promise<void> {
  const value = construct();
  // Can `value.destroy` be called at all right now? Assume yes, because a
  // resource that cannot be destroyed cannot be released either, and silently
  // declining to destroy is the leak this whole function exists to close. The
  // build declares its own exception by running the step through `initialize`
  // — for a pixi Application that is `init`, because `Application.destroy`
  // reaches through `this.renderer`, and `this.renderer` is assigned by `init`
  // and by nothing else. There is no await between `hold` below and the build
  // entering `initialize`, so the Application is never actually reachable
  // during the moment before that window opens.
  let destroyable = true;
  let requested = false;
  let released = false;
  const destroy = (): void => {
    if (released || !destroyable) return;
    released = true;
    // `true` removes the canvas from the DOM with it; the options object
    // takes the display objects and their textures down too. Leaving either
    // behind leaks a WebGL context per room, and a house has ten rooms.
    value.destroy(true, { children: true, texture: true });
  };
  const held: Held<T> = {
    value,
    initialize: async (step) => {
      destroyable = false;
      // A rejection leaves `destroyable` false for good, deliberately: there is
      // no public call that takes down a half-initialised Application, so the
      // only thing another `destroy` would add is a second error on top of the
      // first one.
      await step();
      destroyable = true;
      if (!requested) return true;
      destroy();
      return false;
    },
    release: () => {
      requested = true;
      destroy();
    }
  };
  hold(held);
  try {
    await build(value, held);
  } catch (err) {
    held.release();
    throw err;
  }
}

export interface AmbianceLayerProps {
  room: Room;
  /** Where the room's panel image actually landed, in px. The canvas matches it
   *  exactly, so a light point normalized to the painting lands on the painting
   *  and not on the letterbox beside it. */
  view: ViewBox;
}

export function AmbianceLayer({ room, view }: AmbianceLayerProps): JSX.Element | null {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const reducedMotion = useReducedMotion();
  const visible = usePageVisible();
  const run = ambianceEnabled({ reducedMotion, visible });

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !run) return;
    if (!(view.w > 1) || !(view.h > 1)) return;

    let alive = true;
    // Held outside the async body so cleanup can reach whatever exists by the
    // time it runs, however far the load got.
    let held: { release: () => void } | null = null;

    startAmbiance(async () => {
      const PIXI = await import('pixi.js');
      if (!alive) return;
      await buildOrDestroy(
        () => new PIXI.Application(),
        (h) => { held = h; },
        async (application, owned) => {
          // `init` is the step after which an Application can be destroyed and
          // before which it cannot, so it is the step the guard runs. An
          // unmount landing in here is held until the line below.
          const wanted = await owned.initialize(() => application.init({
            width: Math.round(view.w),
            height: Math.round(view.h),
            backgroundAlpha: 0,
            antialias: true,
            autoDensity: true,
            resolution: window.devicePixelRatio || 1
          }));
          // Unmounted while pixi was initialising: it has just been destroyed,
          // now that destroying it is possible, and there is nothing to parent
          // into a detached node.
          if (!wanted) return;

          // Input belongs to the DOM. 'none' is pixi's own opt-out, on top of the
          // host's `pointer-events: none` — the canvas must be invisible to the
          // pointer by two independent mechanisms, because the whole Study is
          // clickable underneath it.
          application.stage.eventMode = 'none';
          application.canvas.style.pointerEvents = 'none';
          host.appendChild(application.canvas);

          // Which light is the fire is carried by the light, not by the room:
          // the hearth is an anchor the floor plan may stand inside somebody
          // else's panel, so the fire can be one glow among a parlour's
          // candles and the room it burns in has no kind that says so.
          const lights = glowsFor(room.lightPoints ?? []);

          const scale = Math.min(view.w / 520, 1.6);
          const glows = lights.map((p, i) => {
            const hearth = p.hearth;
            const g = new PIXI.Graphics();
            const radius = 18 * scale * (hearth ? HEARTH_SPREAD : 1);
            // Nested rings rather than one filled circle: a single disc has an
            // edge no matter how translucent it is, and the edge is what reads
            // as a coloured sticker sitting on the paint.
            for (const ring of glowRings(radius)) {
              g.circle(0, 0, ring.r).fill({ color: hearth ? HEARTH : CANDLE, alpha: ring.alpha });
            }
            // The hearth alone gets an ember under its halo — a small, hotter
            // core, so the fire has a visible source instead of being a wash of
            // warm colour over the grate.
            if (hearth) {
              for (const ring of glowRings(radius * 0.34, 5)) {
                g.circle(0, 0, ring.r).fill({ color: EMBER, alpha: ring.alpha });
              }
            }
            g.position.set(p.x * view.w, p.y * view.h);
            // Additive, so light adds to the paint underneath instead of sitting on
            // it as a disc of colour — the difference between a glow and a sticker.
            g.blendMode = 'add';
            application.stage.addChild(g);
            return { g, hearth };
          });

          const motes: Mote[] = seedMotes(seedFor(room.id), MOTE_CAP, view);
          const dust = new PIXI.Graphics();
          dust.blendMode = 'add';
          application.stage.addChild(dust);

          let t = 0;
          application.ticker.add((tick: { deltaMS: number }) => {
            t += tick.deltaMS;
            for (let i = 0; i < glows.length; i++) {
              const { g, hearth } = glows[i];
              const f = hearth ? hearthFlicker(t) : flicker(t, i);
              g.alpha = f;
              // Breathing the radius as well as the alpha is what stops it reading
              // as a light on a dimmer. The hearth breathes a fraction of what a
              // candle does: a flame moves, a fire's whole light does not.
              g.scale.set(hearth ? 0.96 + f * 0.06 : 0.9 + f * 0.18);
            }
            driftMotes(motes, tick.deltaMS, view);
            dust.clear();
            for (const m of motes) dust.circle(m.x, m.y, m.r).fill({ color: CANDLE, alpha: m.a });
          });
        }
      );
    });

    return () => {
      alive = false;
      held?.release();
      held = null;
    };
  }, [room.id, room.lightPoints, run, view.w, view.h]);

  // Rendering nothing while the layer is off means no canvas, no context, and
  // no ticker — rather than a live canvas told to hold still.
  if (!run) return null;
  return (
    <div
      ref={hostRef}
      data-study-ambiance={room.id}
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    />
  );
}
