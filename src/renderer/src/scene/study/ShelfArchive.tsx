/**
 * The books that finished work lights on the shelf wall.
 *
 * A book is not a picture of a book — the wall already has those, painted. It
 * is a patch of the painting darkened and deepened, so the thing you see is one
 * of the painted volumes standing out from the rest. `mixBlendMode: multiply`
 * is what makes that true rather than approximately true: an opaque patch in a
 * book-ish colour would COVER the painting it is meant to be pointing at, and
 * would sit visibly wrong the moment the art track repaints the shelves.
 *
 * A gilt hairline down the spine edge catches the eye at a distance, which the
 * darkening alone does not at this size.
 *
 * The books are not buttons. The archive has no destination of its own yet, and
 * a control that does nothing is worse than a mark that does not claim to be
 * one — but each carries its name as a tooltip, so the wall can be read.
 */
import { bookSlot, type ArchivedThing } from './shelfBooks';

interface ViewBox { x: number; y: number; w: number; h: number }

export interface ShelfArchiveProps {
  books: readonly ArchivedThing[];
  /** The shelves room's own marked points, normalized to its panel. */
  shelves: readonly { x: number; y: number }[];
  view: ViewBox;
}

export function ShelfArchive({ books, shelves, view }: ShelfArchiveProps): JSX.Element {
  return (
    <>
      {books.map((book, i) => {
        const box = bookSlot(i, view, shelves);
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
              // Darken, and deepen what is already there. Against a wall of pale
              // painted books this is what reads as "lit" — the inverse of the
              // usual, and the whole of the design for this wall.
              background: book.kind === 'assistant'
                ? 'var(--cth-lilac)'
                : 'var(--cth-peach)',
              mixBlendMode: 'multiply',
              // A gilt edge on the spine, so a book carries at a distance that
              // the darkening alone does not at this size.
              boxShadow: 'inset -1px 0 0 var(--cth-gilt-soft)',
              borderRadius: 'var(--cth-radius-badge)',
              pointerEvents: 'none'
            }}
          />
        );
      })}
    </>
  );
}
