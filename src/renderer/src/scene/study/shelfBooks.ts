/**
 * What the shelf wall holds, and where on it each thing sits.
 *
 * Aaron's design: the shelves room is a painting of pale books, and an archived
 * thing lights one of them up — by DARKENING it. Against light books, darkening
 * is what reads as emphasis, so the whole vocabulary here is inverted from the
 * usual and the code says `darken` on purpose.
 *
 * What the wall keeps is the House's FINISHED WORK. It kept departed assistants
 * instead, until Aaron read the darkening books as "where the done items go" —
 * which is the better reading, because a departed assistant has already left
 * the floor while a concluded commission has nowhere else to be once the card
 * table carries open work only. The geometry below still describes any dated or
 * undated thing, because the bound is about the wall's capacity rather than
 * about what is standing on it.
 *
 * ── The bound, and why it is the shape it is ───────────────────────────────
 *
 * A wall that keeps everything looks right on the day it ships and is an
 * unreadable smear a month later, so it is bounded two ways: an age window and
 * a hard count, oldest off first.
 *
 * The age window can only be applied to something that HAS an age, and the
 * ledger is a file edited by hand: a card can reach this wall with every one of
 * its timestamps missing or unreadable. Dropping the undated for want of a date
 * would mean finished work VANISHING rather than being archived, which is the
 * opposite of what the wall is for. So the window filters what has a date, the
 * count bounds everything, and the undated keep the order the ledger gives them
 * — which is file order, and therefore a real ordering even without a clock.
 *
 * ── Why this file is not called shelfArchive.ts ────────────────────────────
 *
 * It was, next to the `ShelfArchive.tsx` that draws these. On a
 * case-insensitive filesystem — every default macOS and Windows checkout —
 * `./ShelfArchive` and `./shelfArchive` are the same path, and a resolver that
 * tries `.ts` before `.tsx` hands the importer THIS module when it asked for the
 * component. The component then resolves to undefined and renders as nothing,
 * with no error anywhere; on Linux the same code is fine, so it is the kind of
 * bug that only appears on somebody else's machine. Two modules whose names
 * differ only in case are a trap regardless of who resolves them first.
 */

/**
 * Where each volume the wall can mark stands, normalized to the shelves panel.
 *
 * These are the painted books themselves. Aaron: *"the library books being
 * archived don't even line up with the background books on the shelves — I was
 * thinking you'd have the same image but with pieces darker that you could
 * activate in that layer, so the actual background comes alive."* So nothing is
 * drawn: archiving darkens the painting inside one of these rectangles, and the
 * thing that stands out is paint the painter put there.
 *
 * Each rectangle is one BAY of the wall — the run of books standing between two
 * posts on one shelf, from the ledge up to the shelf above it. It used to be one
 * spine, four to a shelf and spread along it, and however much work had been
 * finished the wall read as a book lit here and there: twenty-two spines of the
 * several hundred painted, and the rest of the wall could never change. Aaron:
 * *"the whole background of books should be able to be darkened."* A bay is how
 * much of the wall one finished commission is worth if the whole wall is to
 * fill, and a filled bay is a thing the eye counts where a single darkened spine
 * among dark spines is not.
 *
 * The bays stop short of the three things on the wall that are not books. A
 * lamp is what lights the wall, and a shade taken down with the books beside it
 * reads as the light going out; the ladder and the sleeping cat stand in front
 * of the shelves rather than on them. Where one of those stands in a bay, the
 * bay is cut at its edge, and a sliver too narrow to be read as books is left
 * out rather than marked.
 *
 * The order is the order they are handed out in — along each shelf, top shelf
 * first — which is how a wall of books fills, so the archive reads as a level.
 *
 * Read off the painting rather than authored freehand: the posts and ledges are
 * the columns and rows of that panel where the paint is shelving all the way
 * across, and the lamps are where it is lamplight.
 */
export const SHELF_BOOKS: readonly { x: number; y: number; w: number; h: number }[] = [
  { x: 0.0108, y: 0.0074, w: 0.0867, h: 0.1369 },
  { x: 0.1084, y: 0.0074, w: 0.0969, h: 0.1369 },
  { x: 0.2353, y: 0.0074, w: 0.1582, h: 0.1369 },
  { x: 0.4043, y: 0.0074, w: 0.0874, h: 0.1369 },
  { x: 0.5096, y: 0.0074, w: 0.0867, h: 0.1369 },
  { x: 0.6078, y: 0.0074, w: 0.0963, h: 0.1369 },
  { x: 0.7156, y: 0.0074, w: 0.0893, h: 0.1369 },
  { x: 0.8170, y: 0.0074, w: 0.0861, h: 0.1369 },
  { x: 0.9133, y: 0.0074, w: 0.0861, h: 0.1369 },
  { x: 0.0344, y: 0.1905, w: 0.0631, h: 0.1131 },
  { x: 0.1084, y: 0.1905, w: 0.0867, h: 0.1131 },
  { x: 0.2481, y: 0.1905, w: 0.1454, h: 0.1131 },
  { x: 0.4043, y: 0.1905, w: 0.0746, h: 0.1131 },
  { x: 0.5287, y: 0.1905, w: 0.0676, h: 0.1131 },
  { x: 0.6078, y: 0.1905, w: 0.0708, h: 0.1131 },
  { x: 0.7302, y: 0.1905, w: 0.0746, h: 0.1131 },
  { x: 0.8170, y: 0.1905, w: 0.0625, h: 0.1131 },
  { x: 0.9426, y: 0.1905, w: 0.0568, h: 0.1131 },
  { x: 0.0344, y: 0.3557, w: 0.0631, h: 0.1086 },
  { x: 0.1084, y: 0.3557, w: 0.0867, h: 0.1086 },
  { x: 0.2481, y: 0.3557, w: 0.1454, h: 0.1086 },
  { x: 0.4043, y: 0.3557, w: 0.0746, h: 0.1086 },
  { x: 0.5287, y: 0.3557, w: 0.0676, h: 0.1086 },
  { x: 0.6078, y: 0.3557, w: 0.0708, h: 0.1086 },
  { x: 0.7302, y: 0.3557, w: 0.0746, h: 0.1086 },
  { x: 0.8170, y: 0.3557, w: 0.0364, h: 0.1086 },
  { x: 0.9426, y: 0.3557, w: 0.0568, h: 0.1086 },
  { x: 0.0351, y: 0.5074, w: 0.0625, h: 0.1146 },
  { x: 0.1084, y: 0.5074, w: 0.0867, h: 0.1146 },
  { x: 0.2481, y: 0.5074, w: 0.1454, h: 0.1146 },
  { x: 0.4043, y: 0.5074, w: 0.0727, h: 0.1146 },
  { x: 0.5319, y: 0.5074, w: 0.0644, h: 0.1146 },
  { x: 0.6078, y: 0.5074, w: 0.0689, h: 0.1146 },
  { x: 0.7296, y: 0.5074, w: 0.0753, h: 0.1146 },
  { x: 0.8170, y: 0.5074, w: 0.0364, h: 0.1146 },
  { x: 0.9330, y: 0.5074, w: 0.0663, h: 0.1146 },
  { x: 0.0351, y: 0.6622, w: 0.0625, h: 0.1205 },
  { x: 0.1084, y: 0.6622, w: 0.0867, h: 0.1205 },
  { x: 0.2481, y: 0.6622, w: 0.1454, h: 0.1205 },
  { x: 0.4043, y: 0.6622, w: 0.0727, h: 0.1205 },
  { x: 0.5319, y: 0.6622, w: 0.0644, h: 0.1205 },
  { x: 0.6078, y: 0.6622, w: 0.0689, h: 0.1205 },
  { x: 0.7296, y: 0.6622, w: 0.0753, h: 0.1205 },
  { x: 0.8170, y: 0.6622, w: 0.0364, h: 0.1205 },
  { x: 0.9330, y: 0.6622, w: 0.0663, h: 0.1205 },
  { x: 0.0357, y: 0.8304, w: 0.0619, h: 0.1146 },
  { x: 0.1084, y: 0.8304, w: 0.0855, h: 0.1146 },
  { x: 0.2494, y: 0.8304, w: 0.1441, h: 0.1146 },
  { x: 0.4043, y: 0.8304, w: 0.0714, h: 0.1146 },
  { x: 0.5319, y: 0.8304, w: 0.0644, h: 0.1146 },
  { x: 0.6078, y: 0.8304, w: 0.0963, h: 0.1146 },
  { x: 0.8170, y: 0.8304, w: 0.0364, h: 0.1146 },
  { x: 0.9343, y: 0.8304, w: 0.0651, h: 0.1146 }
];

/** How many books the wall can carry: one per painted volume it can mark. */
export const ARCHIVE_MAX = SHELF_BOOKS.length;

/** How far back the wall remembers, for the things that carry a date. */
export const ARCHIVE_WINDOW_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivedThing {
  id: string;
  label: string;
  kind: 'commission' | 'assistant';
  /** ms since epoch, or `null` when nothing datable is recorded on it — see
   *  the note above; it is not a bug to fix here. */
  at: number | null;
}

/**
 * The things that get a book, newest last, bounded.
 *
 * Stable for the undated: they keep the order they arrived in, so the wall does
 * not reshuffle itself between polls.
 */
export function shelfBooks(
  things: readonly ArchivedThing[],
  now: number,
  max: number = ARCHIVE_MAX,
  windowDays: number = ARCHIVE_WINDOW_DAYS
): ArchivedThing[] {
  const cutoff = now - windowDays * DAY_MS;
  const inWindow = things.filter((t) => t.at == null || t.at >= cutoff);
  // Oldest falls off first. The undated sort as oldest among themselves but
  // AFTER the dated stale ones have already been filtered out, so a wall of
  // undated assistants is bounded by the count exactly as intended.
  const ordered = inWindow
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.at ?? 0) - (b.t.at ?? 0) || a.i - b.i);
  return ordered.slice(Math.max(0, ordered.length - max)).map((x) => x.t);
}

export interface Box { left: number; top: number; width: number; height: number }

/**
 * One painted volume's rectangle, projected onto the box the room draws into.
 *
 * Total in the index, because the count is data: `ARCHIVE_MAX` bounds the
 * archive to the number of volumes the wall has, but a caller that asks for one
 * past the end should get a book rather than `undefined` geometry that renders
 * as a mark of no size at a coordinate of NaN.
 */
export function bookSlot(index: number, view: { w: number; h: number }): Box {
  const book = SHELF_BOOKS[((index % SHELF_BOOKS.length) + SHELF_BOOKS.length) % SHELF_BOOKS.length];
  return {
    left: book.x * view.w,
    top: book.y * view.h,
    width: book.w * view.w,
    height: book.h * view.h
  };
}
