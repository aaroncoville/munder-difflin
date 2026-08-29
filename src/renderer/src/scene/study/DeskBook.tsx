/**
 * A task, as the book open on an assistant's desk.
 *
 * The three states are the three things a reader can be doing with a volume,
 * and they are drawn rather than labelled: a closed book shows only its spine,
 * an open one shows two pages, and a book whose work is impeded is closed with
 * a ribbon seal across it. At desk scale that reads across the room without any
 * text at all.
 *
 * An open book's pages TURN. That is the whole point of the animation and it is
 * why only the open state has one: the house draws every commission somewhere,
 * and the one thing it could not say was WHICH desk a given piece of work is
 * being done at. Movement says it. A commission waiting its turn and a
 * commission that is stuck are both books nobody is reading, so animating them
 * would say the opposite of what they mean — they lie still.
 *
 * A book is also a DOOR. The card table's spines and the shelf wall's volumes
 * already open the commission they stand for, and a house where two of the
 * three surfaces that draw a commission can be pressed and the third cannot
 * teaches the wrong lesson about which marks are live. It opens through the
 * same `openTaskDetail` the other two use, by pointer and by key alike.
 *
 * A book is BOUND FOR ITS ROOM. See `BOOK_BINDINGS`.
 *
 * Pure CSS shapes, no images — so the book recolours with the theme and costs
 * nothing to load, and so the art track never has to produce three sprites per
 * task state per room.
 */
import type { CSSProperties } from 'react';
import { PETITION_EDGE, spineType, type Box } from './BaizeStacks';

export type BookState = 'closed' | 'open' | 'sealed';

/**
 * How a volume is bound, and why there is more than one way.
 *
 * The book was drawn once, in gilt on cream, and it was drawn for the two
 * reading rooms on the LEFT of the house: both are warm dark wood, and a gilt
 * volume on a wooden desk is simply a volume on a desk. The two rooms on the
 * right are not those rooms, and the same book in them is a book that has to
 * be looked for.
 *
 *   - The stone-arched room is grey masonry under gothic glass. A gilt board
 *     there is one more warm smudge among the mullions, so its volume takes
 *     its colour from the WINDOW instead — a violet board, clasped in gilt down
 *     the fore-edge, which is then the one solid colour in the room. Its pages
 *     are cut with an arch, the room's own shape.
 *   - The attic is dusty rose plaster and pale beams, where gilt is very nearly
 *     the wall. Its volume is bound in the complement — deep teal — and marked
 *     with a warm ribbon hanging past the foot, which is what separates a small
 *     dark rectangle from the shadow of a beam.
 *
 * Every value is a theme token, so a binding is a choice about WHICH of the
 * palette a room uses and never a colour of its own. Nothing here is a room
 * name: a binding is a look, and the floor plan is what says who wears it.
 */
export interface BookBinding {
  /** The boards. */
  cover: string;
  /** The paper. */
  pages: string;
  /** The band down the spine of a shut book. */
  spine: string;
  /** The one mark that separates this volume from the wall behind it. */
  mark: string;
  /** Whether the pages are cut square or arched at the head. */
  arched?: boolean;
  /** Whether a marker hangs past the foot. */
  ribbon?: boolean;
}

export const BOOK_BINDINGS = {
  ledger: {
    cover: 'var(--cth-gilt-soft)',
    pages: 'var(--cth-cream-50)',
    spine: 'var(--cth-gilt)',
    mark: 'var(--cth-gilt)'
  },
  arch: {
    cover: 'var(--cth-lilac)',
    pages: 'var(--cth-cream-50)',
    spine: 'var(--cth-lilac-light)',
    mark: 'var(--cth-gilt)',
    arched: true
  },
  attic: {
    cover: 'var(--cth-sky)',
    pages: 'var(--cth-cream-50)',
    spine: 'var(--cth-sky-light)',
    mark: 'var(--cth-peach)',
    ribbon: true
  }
} as const satisfies Record<string, BookBinding>;

export type BookBindingName = keyof typeof BOOK_BINDINGS;

/** What a room that asks for nothing else gets — the volume the left-hand
 *  reading rooms were drawn for. */
export const DEFAULT_BINDING: BookBindingName = 'ledger';

export interface DeskBookProps {
  state: BookState;
  /** The task's title, shown on hover. */
  title?: string;
  box: Box;
  /** How this room binds its volumes. Absent is the default binding, drawn by
   *  the same rules rather than by a second set of them. */
  binding?: BookBindingName;
  /**
   * The commission this book stands for.
   *
   * Absent for a book drawn on a surface that has no commission behind it. A
   * book only becomes a control when it has BOTH an id and somewhere to send
   * it — a tab stop that opens nothing is worse than a mark that never claimed
   * to be one.
   */
  taskId?: string;
  onOpen?: (id: string) => void;
  /**
   * The commission's handle, stamped on a closed board.
   *
   * The same mark the card table prints on a spine and the shelf wall on a
   * volume, printed the same way — sideways, in the display face, sized from
   * the board it is on. A desk carrying several volumes needs it for the reason
   * the felt does: a closed book is a rectangle, and without the mark a pile of
   * them says how much work is in hand but never which work.
   *
   * Only a CLOSED board carries it. An open book's face is its pages, and a
   * number printed across those would be printed on the very thing the reader
   * is reading.
   */
  mark?: number | string;
  /**
   * Whether this commission is waiting on the human.
   *
   * The card table prints the waiting-on-you mark at the head of a spine, and
   * for as long as every petition was dealt onto the felt that was the only
   * place it had to exist. A commission somebody is holding is now on their
   * DESK instead, so the mark has to be able to live on a desk book too, or an
   * assistant blocked on a question would be a sealed volume like any other and
   * nothing in the house would say the question is yours to answer.
   */
  petition?: boolean;
}

/** The leaf mid-turn, and the rule that stops it. Scoped by class so the sheet
 *  can reach the element it is about without reaching anything else. */
const LEAF_CLASS = 'cth-desk-book-leaf';

/**
 * One page lifting off the right-hand side and falling over to the left.
 *
 * It fades out as it passes the upright, which is what lets a single leaf loop
 * forever and still read as a fresh page every time: without the fade the same
 * sheet would visibly snap back across the gutter on every repeat.
 *
 * `backface-visibility` is deliberately left alone — the leaf is a flat cream
 * rectangle and its back is the same cream, which is what the back of a page
 * looks like.
 */
const TURN_SHEET = `
@keyframes cth-desk-book-turn {
  0%, 10% { transform: rotateY(0deg); opacity: 1; }
  55% { opacity: 0.92; }
  70%, 100% { transform: rotateY(-168deg); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .${LEAF_CLASS} { animation: none; transform: none; opacity: 1; }
}
`;

export function DeskBook({
  state, title, box, binding, taskId, onOpen, mark, petition
}: DeskBookProps): JSX.Element {
  const bound: BookBinding = BOOK_BINDINGS[binding ?? DEFAULT_BINDING];
  const opens = Boolean(taskId) && typeof onOpen === 'function';
  const root: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    // Inside a layer that takes no pointer — see the place setting in
    // StudyScene — so the book takes it back, or it loses its own tooltip.
    // Only when it has something to answer with, though: a book drawn as pure
    // scenery, with neither a tooltip nor a press, would otherwise swallow
    // clicks meant for the room it is drawn over.
    pointerEvents: title || opens ? 'auto' : 'none',
    cursor: opens ? 'pointer' : 'default',
    // The leaf turns about the gutter, so the box it turns in needs depth or
    // the page reads as a shutter closing rather than as paper.
    perspective: box.width,
    transition: 'left var(--cth-dur-slow) var(--cth-ease-glide), top var(--cth-dur-slow) var(--cth-ease-glide)'
  };
  const cover: CSSProperties = {
    position: 'absolute',
    inset: 0,
    background: bound.cover,
    borderRadius: 'var(--cth-radius-badge)',
    boxShadow: 'var(--cth-panel-border)'
  };
  /** Both halves of an open book, and the leaf between them. An arched binding
   *  cuts its paper at the head, which is that room's own window shape. */
  const page: CSSProperties = {
    position: 'absolute',
    top: '12%',
    width: '42%',
    height: '76%',
    background: bound.pages,
    borderRadius: bound.arched
      ? '50% 50% var(--cth-radius-badge) var(--cth-radius-badge)'
      : 'var(--cth-radius-badge)'
  };
  return (
    <div
      data-book-state={state}
      data-book-binding={binding ?? DEFAULT_BINDING}
      {...(title ? { title } : {})}
      {...(opens
        ? {
          role: 'button',
          tabIndex: 0,
          ...(title ? { 'aria-label': title } : {}),
          onClick: (event: React.MouseEvent) => {
            event.stopPropagation();
            onOpen?.(taskId as string);
          },
          // A real <button> answers Enter and Space for free; `role` only
          // promises that it does. The target check keeps a key pressed on
          // something inside the book from reading as a press of the book —
          // the same guard the card-table spines and the shelf volumes use.
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            event.stopPropagation();
            onOpen?.(taskId as string);
          }
        }
        : {})}
      style={root}
    >
      <div style={cover} />
      {/* The clasp down the fore-edge, on the bindings that have one. Over the
          boards and under the paper, so it reads as metal holding the book
          shut rather than as a stripe printed on a page. */}
      {bound.arched ? (
        <div
          data-book-clasp=""
          style={{
            position: 'absolute',
            right: 0, top: '22%', width: '6%', height: '56%',
            background: bound.mark,
            borderRadius: 'var(--cth-radius-badge)'
          }}
        />
      ) : null}
      {state === 'open' ? (
        <>
          {/* Shipped with the open book alone, because it is the only state
              that turns anything. Identical sheets across several open books
              cost nothing — the rules are the same rules. */}
          <style>{TURN_SHEET}</style>
          <div data-book-page="left" style={{ ...page, left: '6%' }} />
          <div data-book-page="right" style={{ ...page, right: '6%' }} />
          <div
            data-book-leaf=""
            className={LEAF_CLASS}
            style={{
              ...page,
              right: '6%',
              // Hinged at the gutter, which for the right-hand page is its
              // LEFT edge — that is the spine the sheet is sewn to.
              transformOrigin: 'left center',
              animation: 'cth-desk-book-turn var(--cth-dur-drift) var(--cth-ease-glide) infinite',
              // The leaf lifts off the page it was resting on.
              boxShadow: 'var(--cth-panel-border)'
            }}
          />
        </>
      ) : (
        <>
          <div
            data-book-spine=""
            style={{
              position: 'absolute',
              left: '14%', top: 0, width: '10%', height: '100%',
              background: bound.spine
            }}
          />
          {mark === undefined ? null : (
            <div
              data-book-mark=""
              style={{
                position: 'absolute',
                inset: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                // Turned a quarter, the way a title is printed on a book that
                // is lying down — the same quarter the felt turns its spines.
                transform: 'rotate(90deg)',
                fontFamily: 'var(--cth-font-display)',
                fontSize: spineType(box, mark).fontSize,
                lineHeight: 1,
                color: bound.pages,
                pointerEvents: 'none'
              }}
            >
              {mark}
            </div>
          )}
        </>
      )}
      {/* A marker left in the book, hanging past its foot — what separates a
          small dark volume from a shadow in a room with no light on it. */}
      {bound.ribbon ? (
        <div
          data-book-marker=""
          style={{
            position: 'absolute',
            left: '62%', top: '55%', width: '7%', height: '58%',
            background: bound.mark
          }}
        />
      ) : null}
      {/* The band across the book: impeded work is sealed, and a commission
          waiting on YOU is sealed in the petition's own colour — the same
          lilac the card table prints at the head of such a spine. A petition
          shows it whatever state the book is in, because the question stands
          whether or not the work under it is moving. */}
      {state === 'sealed' || petition ? (
        <div
          data-book-ribbon=""
          data-book-petition={petition ? '' : undefined}
          style={{
            position: 'absolute',
            left: 0, top: '42%', width: '100%', height: '16%',
            background: petition ? PETITION_EDGE : 'var(--cth-status-blocked)',
            boxShadow: 'var(--cth-panel-border)'
          }}
        />
      ) : null}
    </div>
  );
}
