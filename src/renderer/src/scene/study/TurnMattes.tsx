/**
 * How a page turn is cut out of the painting it was filmed from.
 *
 * The film is a rectangle of PANEL — desk, chair and wall as well as the book —
 * and the reader's card stands on that desk. Laid over the card whole, that
 * rectangle is somebody else's wall across the portrait's lower half: a card
 * behind frosted glass. Laid under the card, a page that rises off the book
 * disappears behind the portrait instead. Neither is what a page turning on a
 * desk looks like.
 *
 * What is wanted is the leaves and nothing else, and the clip already says
 * which pixels those are: it was generated FROM the panel, so every pixel that
 * has not moved is still the panel. Difference the frame against the painting
 * and what is left is exactly the part that turns. That difference, read as
 * opacity, is the matte — so the film draws leaves over the card and draws
 * nothing at all everywhere else, including at the rectangle's own edge.
 *
 * WHY THE PAINTING AND NOT A STILL OF THE CLIP. Either works; the panel costs
 * nothing. The room already loads it, it is the same image the film was cut
 * from, and a first frame stored beside each clip would be eight more files
 * that could drift out of step with them.
 *
 * WHAT THE FLOOR IS FOR. The model and the codec shift the whole frame a few
 * parts in 255 — measured 4.1 to 6.7 of 255, flat across the frame with no
 * structural change. Straight difference would therefore make the entire
 * rectangle faintly opaque, which is the frosted glass again, only dimmer. The
 * floor is above that shift and below a page, so the shift keys out and the
 * leaves key in.
 */
import type { Room } from './roomManifest';
import { ROOM_SRC } from './roomImages';

/**
 * Luminance difference, on a 0..1 scale, below which a pixel is the codec
 * rather than a page. Above the measured 4.1–6.7 of 255 the clips drift by, and
 * well below the 100-odd of 255 a cream leaf differs from the wood behind it.
 */
export const MATTE_FLOOR = 0.068;

/**
 * How steeply difference becomes opacity above the floor. A leaf reaches full
 * opacity about 4.5 hundredths of luminance past it, so an edge still has a
 * pixel or two of ramp to be drawn on rather than a staircase.
 */
export const MATTE_GAIN = 22;

/** The filter a desk's film is drawn through. One per berth: one per painting. */
export function matteId(berthId: string): string {
  return `cth-turn-matte-${berthId}`;
}

/**
 * The definitions themselves — rendered once for the whole house, because a
 * filter is referenced by id and two readers at one desk would otherwise define
 * the same id twice.
 */
export function TurnMattes({ rooms }: { rooms: readonly Room[] }): JSX.Element {
  const cut = rooms.flatMap((room) =>
    room.berths
      .filter((berth) => berth.turn && ROOM_SRC[room.image])
      .map((berth) => ({ berth, panel: ROOM_SRC[room.image] as string })));
  return (
    <svg
      width="0"
      height="0"
      aria-hidden="true"
      style={{ position: 'absolute', width: 0, height: 0, pointerEvents: 'none' }}
    >
      <defs>
        {cut.map(({ berth, panel }) => {
          const t = berth.turn as NonNullable<typeof berth.turn>;
          return (
            <filter
              key={berth.id}
              id={matteId(berth.id)}
              x="0%"
              y="0%"
              width="100%"
              height="100%"
              primitiveUnits="objectBoundingBox"
              colorInterpolationFilters="sRGB"
            >
              {/*
                The painting, placed so that the patch this film was cut from
                lands exactly on the film. The manifest states that patch as
                fractions of the panel, which is already the ratio wanted — no
                projection is involved, so the matte registers at any window
                size, and a berth whose rectangle moves takes its matte with it.
              */}
              <feImage
                href={panel}
                x={-t.x / t.w}
                y={-t.y / t.h}
                width={1 / t.w}
                height={1 / t.h}
                preserveAspectRatio="none"
                result="PAINTING"
              />
              <feBlend in="SourceGraphic" in2="PAINTING" mode="difference" result="MOVED" />
              <feColorMatrix in="MOVED" type="luminanceToAlpha" result="RAW" />
              <feComponentTransfer in="RAW" result="MATTE">
                <feFuncA type="linear" slope={MATTE_GAIN} intercept={-MATTE_GAIN * MATTE_FLOOR} />
              </feComponentTransfer>
              {/* The film itself, kept only where the matte says something moved. */}
              <feComposite in="SourceGraphic" in2="MATTE" operator="in" />
            </filter>
          );
        })}
      </defs>
    </svg>
  );
}
