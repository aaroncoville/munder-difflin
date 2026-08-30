/**
 * The book under the reader's hand, and the ring that says so.
 *
 * The shelf wall had this first: hover or tab onto a concluded volume and a
 * gilt ring is drawn round it, so the thing about to be opened is the thing you
 * think it is. Aaron asked for it everywhere books are — the card table's
 * felt, the piles waiting on a desk, and the open book somebody is reading.
 *
 * So it lives HERE, and all four surfaces use it. Four copies of a ring would
 * be four rings the moment anybody tuned one of them, and this is exactly the
 * kind of small affordance that gets tuned.
 *
 * WHY THE RING IS OUTSIDE THE BOX. An inset ring is drawn under whatever the
 * piece carries — the shelf mark's slice of painting, a spine's head band, a
 * book's cover — so it would be a ring round the art on the book rather than
 * round the book. Outset, it sits in the room.
 *
 * WHY IT IS MEASURED FROM THE SMALLER SIDE. The house is drawn at natural size
 * and letterboxed into the window as one scaled drawing, so a fixed pixel ring
 * arrives on screen at whatever the scale leaves of it; every ornament in here
 * is a fraction of the thing it is drawn on. The smaller side is the one that
 * reads as the book's thickness — a spine standing on the shelf is narrow and
 * tall, a book lying open on a desk is wide and shallow — and taking the
 * smaller of the two gives both the same ring for the same apparent heft. On
 * the shelf, where every slot is narrower than it is tall, that is the width:
 * the wall is drawn exactly as it was.
 */

/**
 * Which book the pointer is on, and which one the keyboard is on.
 *
 * Two, because they are independent: either can be on a book the other is not,
 * and both can be on the same one.
 */
export interface PulledBooks { hover: string | null; focus: string | null }

/** Nothing in either hand. */
export const NOTHING_PULLED: PulledBooks = { hover: null, focus: null };

/**
 * A hand arriving at a book, or coming off one.
 *
 * Letting go only ever clears the book that hand was actually on. Without that
 * guard the pointer crossing from one spine to the next — which fires the leave
 * of the old and the enter of the new, in an order nothing here controls —
 * would clear whichever book had just been entered.
 */
export function pullBook(
  now: PulledBooks, id: string, by: keyof PulledBooks, on: boolean
): PulledBooks {
  if (on) return { ...now, [by]: id };
  return now[by] === id ? { ...now, [by]: null } : now;
}

/** Forward if ANY hand is on it. */
export function bookIsPulled(now: PulledBooks, id: string): boolean {
  return now.hover === id || now.focus === id;
}

/** The ring's thickness, as a share of the book's smaller side. */
const PULL_RING = 0.14;

/**
 * How far a held book comes forward.
 *
 * Above its neighbours, or the ring is overdrawn by whichever book happens to
 * be painted after it — books overlap on every surface in this house: the felt
 * leans them, a desk pile stacks them, the shelf stands them shoulder to
 * shoulder. Above the page-turn film as well, which draws at 1 over the reader
 * it belongs to, or the ring round the open book would be under the very thing
 * that makes it worth pointing at.
 */
export const PULL_Z = 2;

/** The ring itself, as a box-shadow layer — see the note above about outset. */
export function pullRing(box: { width: number; height: number }): string {
  return `0 0 0 ${Math.max(1, Math.min(box.width, box.height) * PULL_RING)}px var(--cth-gilt)`;
}

/**
 * The four handlers that keep a book's hands up to date.
 *
 * Pointer and keyboard both, on the same terms: every one of these surfaces is
 * a tab stop, and a reader arriving by keyboard would otherwise land on a book
 * with nothing to say they were on it.
 *
 * Empty when nobody is holding the state — a book drawn somewhere that does not
 * track hands (a volume in flight, say) is scenery, and scenery does not need
 * to report where the pointer is.
 */
export function pullHands(
  id: string, hands: PulledBooks, onPull?: (next: PulledBooks) => void
): Record<string, () => void> {
  if (!onPull) return {};
  const look = (by: keyof PulledBooks, on: boolean): void => onPull(pullBook(hands, id, by, on));
  return {
    onMouseEnter: () => look('hover', true),
    onMouseLeave: () => look('hover', false),
    onFocus: () => look('focus', true),
    onBlur: () => look('focus', false)
  };
}
