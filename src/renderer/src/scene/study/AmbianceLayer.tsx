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
  MOTE_CAP, ambianceEnabled, driftMotes, flicker, lightsFor, seedFor, seedMotes,
  type Mote
} from './ambiance';

interface ViewBox { x: number; y: number; w: number; h: number }

/** Candlelight, as a colour. Matches `--cth-gilt`; pixi takes a number. */
const CANDLE = 0xc9a227;
/** The hearth's own light — deeper and redder than a candle. `--cth-coral`. */
const HEARTH = 0xb0524e;

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
    let app: { destroy: (a: boolean, b: unknown) => void; canvas: HTMLCanvasElement;
      stage: { addChild: (c: unknown) => void; eventMode?: string };
      ticker: { add: (f: (t: { deltaMS: number }) => void) => void } } | null = null;

    startAmbiance(async () => {
      const PIXI = await import('pixi.js');
      if (!alive) return;
      const application = new PIXI.Application();
      await application.init({
        width: Math.round(view.w),
        height: Math.round(view.h),
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: window.devicePixelRatio || 1
      });
      // Unmounted while pixi was initialising: destroy what we just built
      // rather than parenting an orphan into a detached node.
      if (!alive) { application.destroy(true, { children: true }); return; }

      // Input belongs to the DOM. 'none' is pixi's own opt-out, on top of the
      // host's `pointer-events: none` — the canvas must be invisible to the
      // pointer by two independent mechanisms, because the whole Study is
      // clickable underneath it.
      application.stage.eventMode = 'none';
      application.canvas.style.pointerEvents = 'none';
      host.appendChild(application.canvas);

      const lights = lightsFor(room.lightPoints ?? []);
      // The hearth's own fire is the room's first marked light: the painting
      // puts it in the grate, and it wants the deeper colour and a wider throw.
      const isHearth = room.kind === 'hearth';

      const glows = lights.map((p, i) => {
        const g = new PIXI.Graphics();
        const radius = (isHearth && i === 0 ? 34 : 18) * Math.min(view.w / 520, 1.6);
        g.circle(0, 0, radius).fill({ color: isHearth && i === 0 ? HEARTH : CANDLE, alpha: 0.5 });
        g.position.set(p.x * view.w, p.y * view.h);
        // Additive, so light adds to the paint underneath instead of sitting on
        // it as a disc of colour — the difference between a glow and a sticker.
        g.blendMode = 'add';
        application.stage.addChild(g);
        return g;
      });

      const motes: Mote[] = seedMotes(seedFor(room.id), MOTE_CAP, view);
      const dust = new PIXI.Graphics();
      dust.blendMode = 'add';
      application.stage.addChild(dust);

      let t = 0;
      application.ticker.add((tick: { deltaMS: number }) => {
        t += tick.deltaMS;
        for (let i = 0; i < glows.length; i++) {
          const f = flicker(t, i);
          glows[i].alpha = f;
          // Breathing the radius as well as the alpha is what stops it reading
          // as a light on a dimmer.
          glows[i].scale.set(0.9 + f * 0.18);
        }
        driftMotes(motes, tick.deltaMS, view);
        dust.clear();
        for (const m of motes) dust.circle(m.x, m.y, m.r).fill({ color: CANDLE, alpha: m.a });
      });

      app = application as unknown as typeof app;
    });

    return () => {
      alive = false;
      // `true` removes the canvas from the DOM with it; the options object
      // takes the display objects and their textures down too. Leaving either
      // behind leaks a WebGL context per room, and a house has ten rooms.
      app?.destroy(true, { children: true, texture: true });
      app = null;
    };
  }, [room.id, room.kind, room.lightPoints, run, view.w, view.h]);

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
