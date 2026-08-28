/**
 * The volumes that finished work marks on the shelf wall.
 *
 * Nothing here is drawn. Every mark is a rectangle of the shelves panel ITSELF,
 * re-laid at the same size and offset by its own position, then put through a
 * darkening filter — so the thing that stands out is one of the books the
 * painter painted, in its own colour, at its own edges, and the alignment is a
 * property of the arithmetic rather than of somebody's eye.
 *
 * It used to be a patch of colour multiplied over the painting, positioned at
 * the room's light points. That could not line up and was never going to:
 * the light points mark the shelf LAMPS, so a mark landed near a shelf and not
 * on a spine, and a rectangle in a book-ish colour beside a painted book reads
 * as a smudge over the wall rather than as one of its volumes. Aaron's note was
 * that they were doing more harm than good, and that the wall's own books were
 * what should come alive. That is what this is.
 *
 * `background-position` is the whole trick, and it is exact: the element is a
 * window `box.width × box.height` onto a copy of the panel drawn at the panel's
 * own size, slid back by exactly where the window is. There is no scaling
 * factor to get wrong and no second coordinate system — if the panel is
 * repainted, every mark moves with the paint under it.
 *
 * The marks are not buttons. The archive has no destination of its own yet, and
 * a control that does nothing is worse than a mark that does not claim to be
 * one — but each carries its name as a tooltip, so the wall can be read.
 */
import { bookSlot, type ArchivedThing } from './shelfBooks';

/**
 * How each kind of finished thing is taken out of the painting.
 *
 * Both are darkenings, because the wall is a lit one and a hole in it is what
 * the eye finds. They differ in what happens to the colour rather than in the
 * colour applied: a concluded commission is the same volume deepened — its own
 * hue, pushed down and saturated, the way a book looks in shadow — and a
 * departed assistant is that volume drained, near enough to grey that it reads
 * as gone rather than as unlit.
 *
 * Exported so the darkening can be measured against the actual painting rather
 * than asserted to exist.
 */
export const BOOK_SHADE: Record<ArchivedThing['kind'], string> = {
  commission: 'brightness(0.34) saturate(1.7)',
  assistant: 'brightness(0.34) saturate(0.18)'
};

interface ViewBox { x: number; y: number; w: number; h: number }

export interface ShelfArchiveProps {
  books: readonly ArchivedThing[];
  /** The shelves panel's own src — the same image the room draws with. */
  panelSrc: string;
  view: ViewBox;
}

export function ShelfArchive({ books, panelSrc, view }: ShelfArchiveProps): JSX.Element {
  return (
    <>
      {books.map((book, i) => {
        const box = bookSlot(i, view);
        return (
          <div
            key={`${book.kind}:${book.id}`}
            data-shelf-book={book.id}
            data-shelf-kind={book.kind}
            title={book.kind === 'assistant' ? `${book.label} — departed` : book.label}
            style={{
              position: 'absolute',
              left: view.x + box.left,
              top: view.y + box.top,
              width: box.width,
              height: box.height,
              // The same painting, at the same size, slid back by exactly where
              // this window onto it sits. Aligned by construction.
              backgroundImage: `url(${panelSrc})`,
              backgroundSize: `${view.w}px ${view.h}px`,
              backgroundPosition: `${-box.left}px ${-box.top}px`,
              backgroundRepeat: 'no-repeat',
              filter: BOOK_SHADE[book.kind],
              pointerEvents: 'none'
            }}
          />
        );
      })}
    </>
  );
}
