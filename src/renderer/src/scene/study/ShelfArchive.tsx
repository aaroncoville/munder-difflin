/**
 * The volumes that concluded commissions mark on the shelf wall.
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
 * `background-position` is the whole trick, and it is exact: the layer is a
 * window `box.width × box.height` onto a copy of the panel drawn at the panel's
 * own size, slid back by exactly where the window is. There is no scaling
 * factor to get wrong and no second coordinate system — if the panel is
 * repainted, every mark moves with the paint under it.
 *
 * The re-laid painting and its shade are a LAYER of the mark rather than the
 * mark itself, and that separation is load-bearing: a CSS filter takes the
 * element and everything inside it, so a shade on the mark would darken
 * whatever the mark carries by exactly the amount that makes the painting
 * recede. With the shade on its own layer, a mark can be drawn on.
 *
 * A concluded commission's mark is also a BOOK, and a book carries its number.
 * The wall used to say only that something had been finished, never which
 * thing — so a commission's mark wears the same done face the card table's
 * spines wear, with the same number out of the same id, printed the way a
 * STANDING book carries its title: down the spine rather than across it.
 *
 * A departed assistant's mark stays a mark. It has no commission number to
 * print and nowhere to lead, and the wall draws whatever it is handed.
 */
import { bookSlot, type ArchivedThing, type Box } from './shelfBooks';
import { baizeNumber, spineType, SPINE_FACES } from './BaizeStacks';

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
 *
 * The wall is given only concluded commissions now — a departed assistant is
 * already off the floor and needs no second mark — but the shade for one stays,
 * because the wall is what draws a marked volume whatever it is handed, and a
 * kind without a shade paints as no mark at all rather than as a wrong one.
 */
export const BOOK_SHADE: Record<ArchivedThing['kind'], string> = {
  commission: 'brightness(0.34) saturate(1.7)',
  assistant: 'brightness(0.34) saturate(0.18)'
};

/**
 * How the number is set on a standing book, and how long a label it needs.
 *
 * The size comes from the spine's THICKNESS — its width, for a book on its end
 * — because the house is drawn at natural size and letterboxed into the window
 * as one scaled drawing: a fixed 12px face arrives on screen at three or four
 * pixels, so type inside the house has to be a fraction of the thing it is
 * printed on. That is the card table's rule exactly, turned a quarter.
 *
 * The label's LENGTH then follows the number rather than a fixed fraction of
 * the volume, because the wall's volumes are not one shape: the widest painted
 * spine is more than twice the thickness of the narrowest, so a label sized as
 * a share of one of them runs off the other. Capped at half the volume so a
 * label never becomes the book.
 */
export function shelfLabel(box: Box, n: number): { fontSize: number; height: number } {
  const { fontSize } = spineType({ height: box.width }, n);
  const run = fontSize * (0.62 * String(n).length + 0.5);
  return { fontSize, height: Math.min(box.height * 0.5, run) };
}

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
        const face = SPINE_FACES.done;
        const n = baizeNumber(book, i);
        const label = shelfLabel(box, n);
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
              pointerEvents: 'none'
            }}
          >
            <div
              data-shelf-paint=""
              style={{
                position: 'absolute',
                inset: 0,
                // The same painting, at the same size, slid back by exactly
                // where this window onto it sits. Aligned by construction.
                backgroundImage: `url(${panelSrc})`,
                backgroundSize: `${view.w}px ${view.h}px`,
                backgroundPosition: `${-box.left}px ${-box.top}px`,
                backgroundRepeat: 'no-repeat',
                filter: BOOK_SHADE[book.kind]
              }}
            />
            {book.kind === 'commission'
              ? (
                <div
                  data-shelf-number=""
                  style={{
                    // At the foot of the spine, where a library's own call
                    // number is pasted — clear of the head band and of the
                    // shelf edge the book is standing on.
                    position: 'absolute',
                    left: 0,
                    right: 0,
                    bottom: box.height * 0.06,
                    height: label.height,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    // The done face the card table prints on, so one commission
                    // looks like itself on both surfaces. It is a plate rather
                    // than bare ink because what is behind it is a photograph
                    // of a painting: ink on the darkened paint would be legible
                    // by whatever accident of pigment the volume happens to
                    // have, and legibility here is measured.
                    background: face.background,
                    color: face.color,
                    fontFamily: 'var(--cth-font-display)',
                    fontSize: label.fontSize,
                    lineHeight: 1,
                    overflow: 'hidden'
                  }}
                >
                  <div
                    style={{
                      // Turned a quarter, the way a title is printed on a book
                      // that is STANDING: the digits run down the spine rather
                      // than across its thickness.
                      transform: 'rotate(90deg)',
                      whiteSpace: 'nowrap'
                    }}
                  >
                    {n}
                  </div>
                </div>
              )
              : null}
          </div>
        );
      })}
    </>
  );
}
