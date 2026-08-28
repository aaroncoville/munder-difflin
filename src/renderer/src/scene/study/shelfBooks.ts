/**
 * What the shelf wall holds, and where on it each thing sits.
 *
 * Aaron's design: the shelves room is a painting of pale books, and an archived
 * thing lights one of them up — by DARKENING it. Against light books, darkening
 * is what reads as emphasis, so the whole vocabulary here is inverted from the
 * usual and the code says `darken` on purpose.
 *
 * What the wall keeps is the House's PEOPLE. Concluded commissions were shelved
 * here too until the card table learned to deal every commission as a book of
 * its own; drawing them in both rooms marked one thing twice, so the finished
 * work now lives on the baize and the wall is the archive of who has gone. The
 * geometry below still describes any dated or undated thing, because the bound
 * is about the wall's capacity rather than about who is standing on it.
 *
 * ── The bound, and why it is the shape it is ───────────────────────────────
 *
 * A wall that keeps everything looks right on the day it ships and is an
 * unreadable smear a month later, so it is bounded two ways: an age window and
 * a hard count, oldest off first.
 *
 * The age window can only be applied to something that HAS an age, and half of
 * what goes on this wall does not:
 *
 *   - An archived assistant carries no timestamp at all. Nothing in the store
 *     records when somebody was archived, so nothing here can date one.
 *
 * Dropping the undated for want of a date would mean archived assistants never
 * appeared, which is exactly what the design asks for. So the window filters
 * what has a date, the count bounds everything, and the undated keep the order
 * the store gives them — which is append order, and therefore a real ordering
 * even without a clock.
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
 * activate in that layer, so the actual background comes alive. These overlay
 * books are doing more harm than good."* He is right, and the reason the old
 * ones could not line up is structural: they were rectangles placed at the
 * room's LIGHT points, which mark the shelf lamps, so a mark landed near a
 * shelf and never on a spine. A drawn book can only ever approximate a painted
 * one.
 *
 * So there is nothing drawn any more. Each entry below is one spine in
 * `room-shelves.png`, read off the painting: six shelf rows, four volumes on
 * each, spread along the row and kept clear of the ladder and the sleeping cat,
 * which are the two things on that wall that are not books. Archiving darkens
 * the painting inside one of these rectangles, so the volume that stands out is
 * a volume the painter put there.
 *
 * The order is the order they are handed out in — along each shelf, top row
 * first, which is how a wall of books fills.
 *
 * Read off the painting rather than authored freehand: each rectangle is a
 * column of that panel where the paint is a spine from the shelf above it right
 * down to the ledge, which is why the marks sit flush with the volumes either
 * side of them rather than hovering somewhere near a shelf.
 */
export const SHELF_BOOKS: readonly { x: number; y: number; w: number; h: number }[] = [
  { x: 0.0121, y: 0.0342, w: 0.0108, h: 0.1116 },
  { x: 0.6084, y: 0.0268, w: 0.0179, h: 0.1190 },
  { x: 0.8176, y: 0.0461, w: 0.0108, h: 0.0997 },
  { x: 0.1091, y: 0.1964, w: 0.0128, h: 0.1071 },
  { x: 0.5536, y: 0.1905, w: 0.0166, h: 0.1131 },
  { x: 0.7902, y: 0.1979, w: 0.0134, h: 0.1057 },
  { x: 0.9732, y: 0.1830, w: 0.0115, h: 0.1205 },
  { x: 0.1301, y: 0.3512, w: 0.0166, h: 0.1131 },
  { x: 0.3661, y: 0.3557, w: 0.0089, h: 0.1086 },
  { x: 0.5835, y: 0.3408, w: 0.0102, h: 0.1235 },
  { x: 0.7615, y: 0.3452, w: 0.0217, h: 0.1190 },
  { x: 0.1091, y: 0.5074, w: 0.0121, h: 0.1146 },
  { x: 0.3642, y: 0.5060, w: 0.0115, h: 0.1161 },
  { x: 0.6084, y: 0.4970, w: 0.0198, h: 0.1250 },
  { x: 0.0765, y: 0.6563, w: 0.0198, h: 0.1280 },
  { x: 0.3482, y: 0.6652, w: 0.0198, h: 0.1190 },
  { x: 0.6282, y: 0.6592, w: 0.0102, h: 0.1250 },
  { x: 0.8176, y: 0.6741, w: 0.0102, h: 0.1101 },
  { x: 0.1467, y: 0.8289, w: 0.0102, h: 0.1131 },
  { x: 0.3782, y: 0.8170, w: 0.0121, h: 0.1250 },
  { x: 0.5810, y: 0.8155, w: 0.0134, h: 0.1265 },
  { x: 0.9700, y: 0.8363, w: 0.0128, h: 0.1057 }
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
  /** ms since epoch, or `null` when the store records no time for this — see
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
