/**
 * The painted book on a desk, turning its pages — the room's own art in motion.
 *
 * The pages used to be drawn: two cream rectangles and a third that swung
 * across them on a CSS keyframe, laid over the volume the painter had already
 * put on that desk. It read as a page turning, and it was our shapes doing it,
 * in our colours, on top of somebody else's painting. This is a few seconds of
 * that corner of that very panel instead, generated from the panel itself, so
 * the thing that moves is the painting rather than a stand-in for it.
 *
 * WHAT IS AND IS NOT DRAWN HERE. The clip is scenery: it takes no pointer at
 * all. The book stays a DOOR through `DeskBook`, which keeps the root box, the
 * title and the press — the hit target is the book, not the whole patch of room
 * the film covers, and a reader should not find themselves clicking a desk leg
 * to open a commission.
 *
 * WHY IT IS FEATHERED. The clip and the panel are the same pixels, but not to
 * the byte: the model and the codec shift the overall level a few parts in 255,
 * flat across the frame, with no structural change. Against a hard rectangle
 * edge that flat shift is a faintly visible pane of glass over the desk;
 * feathered, there is no edge for it to show against. So the mask is not
 * decoration, it is what makes a generated frame sit inside a painted one.
 *
 * WHY IT IS BIGGER THAN THE BOOK. A page needs somewhere to go. The rectangle
 * is read data on the berth — see `turn` in the room manifest — chosen per desk
 * to hold the book with room to move while keeping that room's candle out of
 * shot, because a flame invented by the model would burn beside the one the
 * ambiance layer already draws at the manifest's own light point.
 *
 * STILLNESS IS A STATE, NOT AN ABSENCE. A desk with nobody reading at it does
 * not draw this at all — the panel underneath is the book at rest, and it is
 * the painting itself, so a quiet desk is exactly as painted. When the House is
 * asked to hold still the clip is mounted and PAUSED on its first frame instead
 * of being torn out, because a reader who has asked for stillness should still
 * see the book somebody is holding.
 */
import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import type { Box } from './BaizeStacks';

export interface BookTurnProps {
  /** The clip for this desk — see `TURN_SRC`. */
  src: string;
  /** The patch of panel it covers, projected onto the room's own box. */
  box: Box;
  /**
   * Whether the pages are turning.
   *
   * False is a paused first frame, not a blank: see the note above. It is false
   * when the House has been asked to hold still, and that is the only reason it
   * is ever false — a desk with nothing in hand does not render this at all.
   */
  playing: boolean;
}

/**
 * How the clip is let into the painting: opaque over the book, gone by the
 * edges of its own rectangle.
 *
 * Centred low rather than in the middle, because the book sits below the middle
 * of the frame and the room above it is only there to give a page somewhere to
 * rise into.
 */
const FEATHER =
  'radial-gradient(ellipse 60% 60% at 50% 62%, #000 50%, transparent 100%)';

export function BookTurn({ src, box, playing }: BookTurnProps): JSX.Element {
  const film = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const node = film.current;
    if (!node) return;
    if (playing) {
      // A rejected play is not an error worth throwing: a browser that refuses
      // to start a muted clip leaves the first frame up, which is the still
      // book, and the desk still reads correctly.
      void node.play?.().catch?.(() => {});
      return;
    }
    node.pause?.();
    // Back to the frame that IS the painting, so a paused desk is the panel
    // rather than whatever moment the clip happened to stop on.
    node.currentTime = 0;
  }, [playing, src]);
  const style: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    // Scenery. The press belongs to the book — see the note above — and a film
    // that took the pointer would put the hit target on the desk around it.
    pointerEvents: 'none',
    WebkitMaskImage: FEATHER,
    maskImage: FEATHER
  };
  return (
    <video
      data-book-turn={src}
      {...(playing ? { 'data-book-turning': '' } : {})}
      ref={film}
      src={src}
      // Muted and inline: the house has no sound and a clip that asked to go
      // fullscreen on a phone would take the room with it.
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
      style={style}
    />
  );
}
