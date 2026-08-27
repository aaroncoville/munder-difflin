/**
 * What the shelf wall holds, and where on it each thing sits.
 *
 * Aaron's design: the shelves room is a painting of pale books, and an archived
 * thing lights one of them up — by DARKENING it. Against light books, darkening
 * is what reads as emphasis, so the whole vocabulary here is inverted from the
 * usual and the code says `darken` on purpose.
 *
 * Both a concluded commission and a departed assistant belong on the wall. That
 * is what makes it an archive rather than a done-column: the House keeps its
 * people as well as its work.
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
 *   - A commission carries `createdAt` and no completion time. So the window is
 *     applied to when it was OPENED, which is a proxy and is named as one — a
 *     long-running commission concluded today can fall outside a window its own
 *     conclusion sits well inside.
 *   - An archived assistant carries no timestamp at all. Nothing in the store
 *     records when somebody was archived.
 *
 * Dropping the undated for want of a date would mean archived assistants never
 * appeared, which is exactly what the design asks for. So the window filters
 * what has a date, the count bounds everything, and the undated keep the order
 * the store gives them — which is append order, and therefore a real ordering
 * even without a clock.
 *
 * A `completedAt` on the ledger would make the window exact. That is a
 * hive-side change and is noted rather than faked here.
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

/** How many books the wall can carry and still be read across a room. */
export const ARCHIVE_MAX = 24;

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
 * How wide and tall a book is, as a fraction of the panel.
 *
 * Wider than a painted spine on this wall, deliberately. The house is drawn at
 * its natural size and letterboxed into the window as one scaled drawing, so a
 * mark 44 panel pixels across arrives about ten pixels wide — the same as the
 * spines painted either side of it, which is exactly how a marked volume
 * disappears into the shelf it is standing on.
 */
const BOOK = { w: 0.042, h: 0.20 };

/**
 * Where the nth book sits on the shelf wall.
 *
 * The positions come from the room's OWN light points, which the manifest has
 * carried since the rooms were painted and which sit on the painted shelf rows
 * — so a book lands on a shelf in the picture rather than at a coordinate
 * somebody guessed at. Past the last marked shelf it walks along the row it is
 * on, which is what a real shelf does when you put another book on it.
 *
 * A shelves room with no marked points is a real state — `room.json` is data
 * and the art track revises it — so it falls back to an even row rather than
 * dividing by zero and taking the Study down.
 */
export function bookSlot(
  index: number,
  view: { w: number; h: number },
  shelves: readonly { x: number; y: number }[]
): Box {
  const w = view.w * BOOK.w;
  const h = view.h * BOOK.h;
  const clamp = (v: number, hi: number): number => Math.max(0, Math.min(v, hi));

  if (shelves.length === 0) {
    // No marked shelves: lay them along the middle of the wall, spaced by their
    // own width, and wrap before walking off the edge.
    const perRow = Math.max(1, Math.floor(view.w / (w * 1.6)));
    const col = index % perRow;
    const row = Math.floor(index / perRow);
    return {
      left: clamp(col * w * 1.6, view.w - w),
      top: clamp(view.h * 0.3 + row * h * 1.1, view.h - h),
      width: w,
      height: h
    };
  }

  const shelf = shelves[index % shelves.length];
  // Each pass around the shelves steps the book along that shelf, so the
  // twelfth book stands beside the second rather than on top of it.
  const pass = Math.floor(index / shelves.length);
  return {
    left: clamp(shelf.x * view.w + pass * w * 1.25, view.w - w),
    // The point marks the light on the shelf; the book stands ON that shelf, so
    // it hangs below the mark rather than being centred on it.
    top: clamp(shelf.y * view.h - h * 0.15, view.h - h),
    width: w,
    height: h
  };
}
