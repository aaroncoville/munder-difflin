/**
 * The books in the air, between the desk they left and where they are going.
 *
 * A flight is drawn AT ITS LANDING PLACE and displaced backwards to where it
 * started, rather than drawn at the desk and moved forwards. That is the whole
 * trick and it is what makes the landing exact: the element's own box is the
 * berth on the felt or the slot on the shelf, so the last frame of the
 * animation is that berth to the pixel. Drawing it at the desk and animating
 * `left`/`top` towards the target would land it wherever the arithmetic drifted
 * to, and would also animate two layout properties per frame instead of a
 * transform.
 *
 * The arc is two animations rather than one curve. The horizontal carry runs
 * evenly and the vertical fall runs on an ease, so the book rises out of the
 * desk, hangs, and drops onto its place — the path a thrown book takes. One
 * keyframe track cannot do that without spelling out the middle of the curve;
 * two tracks with different easings do it for nothing.
 *
 * Per-flight distances reach the keyframes as custom properties. A keyframe is
 * a static rule and there is one set of them for every book in the house, so
 * the numbers cannot live in it — they live on the element, and `var()` is
 * substituted before the transform is interpolated.
 *
 * Nothing here takes the pointer. A book in the air is scenery passing over
 * rooms that are themselves controls, and a click landing on the flourish
 * instead of on the room underneath is a bug the user cannot even see the cause
 * of.
 */
import type { CSSProperties } from 'react';
import { DeskBook, type BookBindingName } from './DeskBook';
import type { Flight } from './flight';
import type { Box } from './StudyScene';

export interface FlightPath {
  flight: Flight;
  /** The desk book it leaves, in the house's own coordinates. */
  from: Box;
  /** The berth on the felt, or the slot on the shelf, in the same coordinates. */
  land: Box;
  /**
   * The binding of the room it LEFT, not of the room it is going to.
   *
   * The bindings exist so a volume is legible against its own room's paint, and
   * a book that changed binding on take-off would be a different book arriving
   * than the one that left — which is the one thing an animation between two
   * places must not be.
   */
  binding?: BookBindingName;
}

export interface FlyingBooksProps {
  paths: readonly FlightPath[];
  /** Said when a book has finished its flight, so it can leave the sky. */
  onLanded?: (flightId: string) => void;
}

/**
 * The two tracks, and the stillness rule.
 *
 * The reduced-motion rule is belt and braces: no flight is ever launched on a
 * machine that asked for less movement — see `flightsFor` — so nothing should
 * reach these rules at all. It is here because a stylesheet that animates is a
 * stylesheet that has to say what it does when asked not to, and because the
 * gate above it is a decision made once, somewhere else.
 */
const FLIGHT_SHEET = `
@keyframes cth-book-fly-across {
  from { transform: translateX(var(--cth-fly-x)); opacity: 1; }
  85%  { opacity: 1; }
  to   { transform: translateX(0); opacity: 0; }
}
@keyframes cth-book-fly-down {
  from { transform: translateY(var(--cth-fly-y)) scale(var(--cth-fly-w), var(--cth-fly-h)) rotate(-7deg); }
  to   { transform: translateY(0) scale(1, 1) rotate(0deg); }
}
@media (prefers-reduced-motion: reduce) {
  [data-book-flight], [data-flight-carry] { animation: none !important; opacity: 0; }
}
`;

/** How long a book is in the air. Long enough to follow across the house. */
const ACROSS = 'var(--cth-dur-drift) linear both';
const DOWN = 'var(--cth-dur-drift) var(--cth-ease-glide) both';

/**
 * What the book looks like on its way.
 *
 * Shut, because a book in the air is not being read, and sealed when it is
 * going back to the table — the ribbon IS why it left the desk. The one going
 * to the shelf is simply closed: it is finished, not impeded.
 */
const IN_FLIGHT = { table: 'sealed', shelf: 'closed' } as const;

export function FlyingBooks({ paths, onLanded }: FlyingBooksProps): JSX.Element | null {
  if (paths.length === 0) return null;
  return (
    <div
      data-study-flights=""
      aria-hidden
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none', overflow: 'hidden' }}
    >
      <style>{FLIGHT_SHEET}</style>
      {paths.map(({ flight, from, land, binding }) => {
        const start: CSSProperties & Record<string, string | number> = {
          position: 'absolute',
          left: land.left,
          top: land.top,
          width: land.width,
          height: land.height,
          pointerEvents: 'none',
          animation: `cth-book-fly-across ${ACROSS}`,
          '--cth-fly-x': `${from.left - land.left}px`,
          '--cth-fly-y': `${from.top - land.top}px`,
          // A ratio rather than a length: the book leaves at the size it was on
          // the desk and arrives at the size of the place it is going, and
          // `scale` is what carries that without touching the layout.
          '--cth-fly-w': land.width > 0 ? from.width / land.width : 1,
          '--cth-fly-h': land.height > 0 ? from.height / land.height : 1
        };
        return (
          <div
            key={flight.id}
            data-book-flight={flight.id}
            data-flight-to={flight.to}
            title={flight.title}
            style={start}
            // The carry is the longer of the two tracks and the one that fades,
            // so it is the one that says the flight is over.
            onAnimationEnd={() => onLanded?.(flight.id)}
          >
            <div
              data-flight-carry=""
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                // Top-left, so the scale maps the landing box exactly onto the
                // desk box it started as — any other origin puts the first
                // frame somewhere the book never was.
                transformOrigin: 'top left',
                animation: `cth-book-fly-down ${DOWN}`
              }}
            >
              <DeskBook
                state={IN_FLIGHT[flight.to]}
                binding={binding}
                box={{ left: 0, top: 0, width: land.width, height: land.height }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
