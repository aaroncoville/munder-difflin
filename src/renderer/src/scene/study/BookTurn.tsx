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
 * all. That matters more than it used to, because this is drawn OVER the
 * reader's card — a layer above a door that took the pointer would close it.
 * The book stays a DOOR through `DeskBook`, which keeps the root box, the title
 * and the press, and the card stays one through `AgentCard`.
 *
 * ONLY WHAT MOVES IS DRAWN. The clip is a rectangle of panel, and the panel is
 * what is already painted underneath it, so drawing the rectangle whole means
 * drawing the room twice — over the card, that is the room's wall across the
 * portrait. It is therefore cut against the painting it was filmed from, and
 * what survives is the part that turns. See `TurnMattes` for how, and for the
 * measured drift the cut has to ignore.
 *
 * WHY IT IS STILL FEATHERED. The matte removes the rectangle's edge already,
 * because an edge that does not move is not drawn. This is for the pixels that
 * DO move within a hand's width of the border: a leaf caught half in shot would
 * otherwise stop at a straight line.
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
 * of being torn out. Note what the matte makes of that: a first frame differs
 * from its own painting only by the codec's drift, which the cut discards, so a
 * house holding still draws no leaf at all. That is the right answer to being
 * asked for stillness, and it is worth saying plainly rather than leaving the
 * old claim that a paused frame shows which book is in whose hands — it never
 * did, because the frame it pauses on IS the painting.
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
  /**
   * The matte that cuts the moving pages out of the still painting — see
   * `TurnMattes`, which defines one per desk.
   *
   * Without it this is a rectangle of somebody else's wall laid over the card.
   */
  matteId: string;
  /**
   * Whether to drop behind the reader's card instead of sweeping across it.
   *
   * True while the card is being looked at, because the caption the leaves pass
   * over is the assistant's name and role, and a reader who has gone to the
   * card to read it should not have to wait out a page turn.
   */
  behindCard: boolean;
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

export function BookTurn({
  src, box, playing, matteId, behindCard
}: BookTurnProps): JSX.Element {
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
    // In FRONT of the card by default, so a leaf that leaves the book crosses
    // the portrait the way it would cross anything else standing on that desk.
    // The matte is what makes that safe: everything that is not moving is cut
    // away, so the card is covered by leaves and by nothing else.
    zIndex: behindCard ? -1 : 1,
    filter: `url(#${matteId})`,
    // The matte already removes the rectangle's edge, since the edge does not
    // move. This stays for the pixels that DO move within a hand's width of the
    // border — a leaf half in shot would otherwise end at a straight line.
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
