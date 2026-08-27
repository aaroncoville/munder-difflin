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
 * The tint it multiplies by is a DEEP one, and that is the correction this
 * wall needed. The design assumed the shelves were painted pale, and they are
 * not: room-shelves.png averages a luma of 61 out of 255. Against a wall that
 * is already dark, the mid-tone accents this started on took a book's slot down
 * 55% for an assistant and only 40% for a commission — a shade among fifty
 * painted spines that are themselves dark and varied, which is why a marked
 * volume could not be found. The deep end of the same two families takes it
 * down about 80%, which is a hole in the shelf rather than another book.
 *
 * The gilt edge is a SIBLING of that patch rather than something inside it.
 * `mix-blend-mode` makes the patch its own blend group, so gilt drawn within it
 * would be multiplied along with everything else — and multiply can only
 * darken, so the one bright mark on the wall would come out as another shade of
 * the dark it exists to stand against.
 *
 * The books are not buttons. The archive has no destination of its own yet, and
 * a control that does nothing is worse than a mark that does not claim to be
 * one — but each carries its name as a tooltip, so the wall can be read.
 */
import { Fragment } from 'react';
import { bookSlot, type ArchivedThing } from './shelfBooks';

/**
 * What each kind of finished thing darkens its slot by.
 *
 * The deep end of the two accent families rather than the accents themselves:
 * multiply takes the painting DOWN by these, so the value here is the fraction
 * of the painting that survives, and a mid-tone leaves too much of it.
 * Exported so the darkening can be measured against the actual painting.
 */
export const BOOK_TINT: Record<ArchivedThing['kind'], string> = {
  assistant: 'var(--cth-lilac-light)',
  thing: 'var(--cth-peach-light)'
};

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
          <Fragment key={`${book.kind}:${book.id}`}>
            <div
              data-shelf-book={book.id}
              data-shelf-kind={book.kind}
              title={book.kind === 'assistant' ? `${book.label} — departed` : book.label}
              style={{
                position: 'absolute',
                left: view.x + box.left,
                top: view.y + box.top,
                width: box.width,
                height: box.height,
                // Darken, and deepen what is already there, rather than paint
                // over it — the volume you see is the one the wall already had.
                background: BOOK_TINT[book.kind],
                mixBlendMode: 'multiply',
                borderRadius: 'var(--cth-radius-badge)',
                pointerEvents: 'none'
              }}
            />
            <div
              data-shelf-gilt={book.id}
              aria-hidden
              style={{
                position: 'absolute',
                // On the spine edge, standing outside the darkening so it can
                // actually be bright.
                left: view.x + box.left + box.width * 0.78,
                top: view.y + box.top,
                width: box.width * 0.22,
                height: box.height,
                background: 'var(--cth-gilt)',
                // Proportional, like everything else inside the house: a 1px
                // hairline is erased by the scale the whole building is drawn
                // at, which is what left the darkening to carry the mark alone.
                boxShadow: `inset 0 0 0 ${Math.max(1, box.width * 0.03)}px var(--cth-gilt-soft)`,
                borderRadius: 'var(--cth-radius-badge)',
                pointerEvents: 'none'
              }}
            />
          </Fragment>
        );
      })}
    </>
  );
}
