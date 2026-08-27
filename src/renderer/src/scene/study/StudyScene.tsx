/**
 * The Study — the painted scene that replaces the pixel office floor under the
 * occult theme.
 *
 * Three stacked layers, bottom to top:
 *
 *   1. the backdrop image, contain-fitted so the whole painting is always
 *      visible and never cropped;
 *   2. a reserved slot for the ambiance canvas (flicker, motes, hearth smoke),
 *      which mounts nothing yet — it is `pointer-events: none` by contract, so
 *      that when it does arrive every click still belongs to the DOM;
 *   3. the card layer, whose children are placed from the room manifest.
 *
 * Because the backdrop is letterboxed rather than stretched, the layout can NOT
 * be expressed in CSS percentages: a berth at x=0.5 is halfway across the
 * *image*, which is not halfway across the container unless the aspects happen
 * to match. Every position therefore goes through `berthToBox`, against the
 * measured box the image actually occupies.
 */
import { useEffect, useRef, useState } from 'react';
import backdropUrl from './assets/backdrop-placeholder.png';
import { loadRoomManifest, type Berth } from './roomManifest';

/** Where the backdrop actually landed inside the container, in px. */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Natural size of the shipped backdrop — the frame the berths were authored in. */
export const BACKDROP_NATURAL = { w: 1344, h: 768 };

/** The image the scene renders. Exported so a test can hold it against the
 *  path room.json declares; the two drifting apart would put every berth on a
 *  painting they were not authored for. */
export const BACKDROP_SRC: string = backdropUrl;

/** Letterbox `natural` inside `container`, the way `object-fit: contain` does. */
export function containFit(
  container: { w: number; h: number },
  natural: { w: number; h: number }
): ViewBox {
  if (!(container.w > 0) || !(container.h > 0) || !(natural.w > 0) || !(natural.h > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(container.w / natural.w, container.h / natural.h);
  const w = natural.w * scale;
  const h = natural.h * scale;
  return { x: (container.w - w) / 2, y: (container.h - h) / 2, w, h };
}

/** A normalized berth, projected onto the box the backdrop occupies. */
export function berthToBox(berth: Berth, view: ViewBox): Box {
  return {
    left: view.x + berth.x * view.w,
    top: view.y + berth.y * view.h,
    width: berth.w * view.w,
    height: berth.h * view.h
  };
}

/** The floor plan the scene is drawn from — parsed once, shared by its children. */
export const studyRoom = loadRoomManifest();

/** The measured backdrop box. Falls back to the natural size where there is no
 *  layout to measure (node tests), so the projection is still exercisable. */
function useViewBox(hostRef: React.RefObject<HTMLDivElement | null>): ViewBox {
  const [view, setView] = useState<ViewBox>(() => containFit(BACKDROP_NATURAL, BACKDROP_NATURAL));
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      setView(containFit({ w: host.clientWidth, h: host.clientHeight }, BACKDROP_NATURAL));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef]);
  return view;
}

export function StudyScene(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const view = useViewBox(hostRef);
  return (
    <div
      ref={hostRef}
      data-study-scene=""
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--cth-cream-300)'
      }}
    >
      <img
        src={BACKDROP_SRC}
        alt=""
        aria-hidden
        draggable={false}
        style={{
          position: 'absolute',
          left: view.x,
          top: view.y,
          width: view.w,
          height: view.h,
          userSelect: 'none'
        }}
      />
      <div
        data-study-slot="ambiance"
        style={{
          position: 'absolute',
          left: view.x,
          top: view.y,
          width: view.w,
          height: view.h,
          pointerEvents: 'none'
        }}
      />
      <div data-study-layer="cards" style={{ position: 'absolute', inset: 0 }} />
    </div>
  );
}
