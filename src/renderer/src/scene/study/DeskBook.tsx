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
 * Pure CSS shapes, no images — so the book recolours with the theme and costs
 * nothing to load, and so the art track never has to produce three sprites per
 * task state.
 */
import type { CSSProperties } from 'react';
import type { Box } from './StudyScene';

export type BookState = 'closed' | 'open' | 'sealed';

export interface DeskBookProps {
  state: BookState;
  /** The task's title, shown on hover. */
  title?: string;
  box: Box;
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

const COVER: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--cth-gilt-soft)',
  borderRadius: 'var(--cth-radius-badge)',
  boxShadow: 'var(--cth-panel-border)'
};

/** Both halves of an open book, and the leaf between them, share these. */
const PAGE: CSSProperties = {
  position: 'absolute',
  top: '12%',
  width: '42%',
  height: '76%',
  background: 'var(--cth-cream-50)',
  borderRadius: 'var(--cth-radius-badge)'
};

export function DeskBook({ state, title, box, taskId, onOpen }: DeskBookProps): JSX.Element {
  const opens = Boolean(taskId) && typeof onOpen === 'function';
  const root: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    // Inside a layer that takes no pointer — see the place setting in
    // StudyScene — so the book takes it back, or it loses its own tooltip.
    pointerEvents: 'auto',
    cursor: opens ? 'pointer' : 'default',
    // The leaf turns about the gutter, so the box it turns in needs depth or
    // the page reads as a shutter closing rather than as paper.
    perspective: box.width,
    transition: 'left var(--cth-dur-slow) var(--cth-ease-glide), top var(--cth-dur-slow) var(--cth-ease-glide)'
  };
  return (
    <div
      data-book-state={state}
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
      <div style={COVER} />
      {state === 'open' ? (
        <>
          {/* Shipped with the open book alone, because it is the only state
              that turns anything. Identical sheets across several open books
              cost nothing — the rules are the same rules. */}
          <style>{TURN_SHEET}</style>
          <div data-book-page="left" style={{ ...PAGE, left: '6%' }} />
          <div data-book-page="right" style={{ ...PAGE, right: '6%' }} />
          <div
            data-book-leaf=""
            className={LEAF_CLASS}
            style={{
              ...PAGE,
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
        <div
          data-book-spine=""
          style={{
            position: 'absolute',
            left: '14%', top: 0, width: '10%', height: '100%',
            background: 'var(--cth-gilt)'
          }}
        />
      )}
      {state === 'sealed' ? (
        <div
          data-book-ribbon=""
          style={{
            position: 'absolute',
            left: 0, top: '42%', width: '100%', height: '16%',
            background: 'var(--cth-status-blocked)',
            boxShadow: 'var(--cth-panel-border)'
          }}
        />
      ) : null}
    </div>
  );
}
