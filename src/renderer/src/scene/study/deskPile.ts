/**
 * What lies on a reading desk: the commissions its assistant is holding.
 *
 * The house draws every commission on the surface that says where it IS, and
 * for open work that surface is a desk — somebody is holding it, and the desk
 * they hold it at is the fact worth drawing. The card table keeps the work
 * nobody has picked up yet, so the two surfaces divide the ledger between them
 * the way the felt and the shelf wall already divide it: unclaimed on the
 * table, in hand at a desk, concluded on the wall.
 *
 * A desk therefore has to carry MORE than one volume. It used to carry exactly
 * one, and choosing which cost nothing, because every card it did not choose
 * was drawn on the felt anyway. Once work in somebody's hands leaves the felt
 * that stops being true: the unchosen cards would be drawn nowhere in the house
 * at all. So the desk shows them all — the one in hand lying open, the rest
 * stacked behind it.
 *
 * Pure, and separate from the drawing: which volumes a desk holds and where
 * they lie are both checkable without a room, a panel or a scene.
 */
import { waitsOnHuman, type HiveTask } from '@/components/TasksKanban';
import { concluded } from './BaizeStacks';
import type { Box } from './BaizeStacks';
import type { BookState } from './DeskBook';

/**
 * Whether a commission is in somebody's hands, and therefore on their desk.
 *
 * One exclusion: concluded work is on the shelf wall, and a finished commission
 * on a desk would say it is still being worked on. Everything else somebody
 * holds is at their desk, INCLUDING a commission waiting on the human — an
 * assistant blocked on a question is still the assistant holding that card, and
 * the desk is where the room says so. The waiting-on-you mark travels with it;
 * see `petition` on the desk book.
 */
export function handHeld(task: HiveTask): boolean {
  if (task.status === 'done') return false;
  return (task.assignee || '').trim().length > 0;
}

/** One volume on a desk: what it is, and how it is lying. */
export interface DeskVolume {
  id: string;
  title: string;
  state: BookState;
  /** The ledger's own status, so a volume waiting its turn can be drawn with
   *  the face the card table gives that status — see `SpineBook`. */
  status: HiveTask['status'];
  /** Set when the commission is waiting on the human, so the volume can carry
   *  the mark the card table prints at the head of such a spine. */
  petition?: boolean;
}

/**
 * How many volumes stack BEHIND the open one before the desk stops taking them.
 *
 * Not a performance number, the same way the felt's bound is not: it is how
 * many books a painted desk can carry before the pile stops reading as a pile
 * and starts climbing up the portrait sitting at it. An assistant holding more
 * than this is a real state, and the honest thing to do with it is show the
 * ones a reader would have to hand and leave the board to show the rest.
 */
export const DESK_PILE_MAX = 4;

/**
 * The order a desk is piled in: what is being read, then what is stuck, then
 * what is waiting its turn.
 *
 * Work IN HAND leads, which is a change from the single-book desk. While a desk
 * could show one volume, impeded work outranked work in progress — a sealed
 * book is the thing worth noticing from across the study, and it was that or
 * nothing. Now both are on the desk and the sealed one is seen either way, so
 * the open slot goes to the commission actually being read. That is the only
 * thing turning pages can honestly mean, and a desk whose pages turned for a
 * card nobody was touching would say the opposite of the truth.
 *
 * Ties keep the ledger's own order, so a desk does not restack itself between
 * polls when nothing has changed.
 */
const DESK_ORDER: Partial<Record<HiveTask['status'], number>> = {
  doing: 0, blocked: 1, todo: 2
};

/** How each status lies on the desk. */
const DESK_STATE: Partial<Record<HiveTask['status'], BookState>> = {
  doing: 'open', blocked: 'sealed', todo: 'closed'
};

/**
 * The volumes on one assistant's desk, the open one first.
 *
 * The first is what lies in the painted book's place; the rest stack behind it.
 * Bounded, so a desk handed thirty commissions draws a pile rather than a wall.
 */
export function booksFor(tasks: readonly HiveTask[], agentId: string): DeskVolume[] {
  return tasks
    .filter((t) => handHeld(t) && t.assignee === agentId)
    .map((task, i) => ({ task, i }))
    .sort((a, b) =>
      (DESK_ORDER[a.task.status] ?? 9) - (DESK_ORDER[b.task.status] ?? 9) || a.i - b.i)
    .slice(0, DESK_PILE_MAX + 1)
    .map(({ task }) => ({
      id: task.id,
      title: task.title,
      state: DESK_STATE[task.status] ?? 'closed',
      status: task.status,
      ...(waitsOnHuman(task) ? { petition: true } : {})
    }));
}

/**
 * How thick a stacked volume is, as a fraction of the open book's height, and
 * how far each one sits out of true.
 *
 * A closed book seen in a flat cross-section is much thinner than an open one —
 * that is most of what says it is closed, before any of the drawing does. The
 * lean is fixed rather than random, so the pile does not shuffle itself every
 * time the ledger is polled, and small enough that the pile still stands over
 * the book it rests on.
 */
const VOLUME = { thickness: 0.34, width: 0.92 };
const LEAN = [0.03, -0.025, 0.02, -0.03];

/**
 * Where the stacked volumes lie, given the place the open book has.
 *
 * The house is drawn as a flat cross-section and straight on, so there is no
 * depth to stack INTO: further up the panel is further back on the desk, which
 * is exactly where a reader's other volumes are. Each one therefore sits above
 * the last.
 *
 * The slot is the book's place on that desk — the volume the painter drew — and
 * the pile stands in it rather than beside it. A closed volume covering the
 * painted book is the House saying which book is on that desk NOW, which is the
 * one thing a reading desk is for. What must not happen is a stack of bare
 * boards there; the drawing is `SpineBook`'s business, and it deals the same
 * bound volume the card table deals.
 *
 * `restingOn` says whether the book being READ already lies in the slot. When
 * it does the pile starts above it, because a reader's other volumes sit behind
 * the one open in front of them; when it does not, the pile stands on the desk
 * itself and the bottom of it takes the painted book's place.
 */
export function deskPile(slot: Box, count: number, restingOn = false): Box[] {
  const height = slot.height * VOLUME.thickness;
  const width = slot.width * VOLUME.width;
  const left = slot.left + (slot.width - width) / 2;
  const foot = restingOn ? slot.top : slot.top + slot.height;
  return Array.from({ length: Math.max(0, count) }, (_, i) => ({
    left: left + width * (LEAN[i % LEAN.length] ?? 0),
    top: foot - height * (i + 1),
    width,
    height
  }));
}

/**
 * Where the volume in hand lies: on the book the PAINTER already put there.
 *
 * Two reading rooms have an open book drawn on the desk, and a book of ours
 * drawn beside it is two books on one desk — the very doubling the painting was
 * supposed to save us from drawing. So the desk book takes that book's place
 * instead: it is registered on the painted volume and covers it, the way the
 * shelf wall floats a volume you can press over the one the painting shelved.
 * The painting keeps the piece of itself it drew there as the backdrop, and
 * what moves and what answers a click is ours.
 *
 * It also settles how the page turn READS. A painted volume's box is the room's
 * own perspective already worked out — wide and shallow, foreshortened the way
 * a book lying on an angled desk is — so a book registered on it is drawn at
 * that angle for nothing. A book given a box of its own is drawn as if the desk
 * were seen from straight above, and the page then flips in a plane the room
 * does not have.
 *
 * Where the painter left the desk bare there is nothing to register on, and the
 * book lies in the clear desk beside the card as it always did.
 */
export function bookFloat(volume: Box | null, beside: Box): Box {
  return volume ?? beside;
}

/**
 * Where every open commission goes: the desks, and what is left for the felt.
 *
 * One function, over the whole ledger, returning both halves — rather than two
 * predicates asked separately and hoped to agree. They did not agree. The felt
 * dropped everything a seated assistant held, the desk drew the first few, and
 * the difference was drawn NOWHERE: the sixth open card of an assistant holding
 * six, and a concluded commission still carrying an unanswered question, which
 * no desk takes because it is finished and which the old felt rule dropped
 * because somebody's name was on it.
 *
 * A card missing from the house entirely is worse than the double this replaced
 * — a double is at least visible — and no predicate could have been trusted to
 * prevent it, because the bound belongs to the DESK and a rule about one card
 * cannot see it. So the split is made once, here, and the leftovers ARE the
 * felt: every open commission the desks did not take, whatever the reason.
 * Totality stops being a property to test for and becomes the shape of the
 * function.
 *
 * Concluded work appears in neither. The shelf wall is the third surface and
 * takes it, on its own rule — see `concluded`.
 *
 * What this settles is MEMBERSHIP: which surface each open commission belongs
 * to. Whether that surface then has room to draw it is a separate question with
 * a separate answer — the felt is bounded at four piles of six and the desk at
 * five volumes, both because of what the painting can carry rather than for
 * anything to do with cost. The desk's overflow comes back here and lands on
 * the felt; the felt's own overflow is not drawn, and the card table is a door
 * to the whole board precisely so that it can still be read. Do not read the
 * totality below as a promise that everything is drawn — it is a promise that
 * nothing is unaccounted for.
 */
export interface Placement {
  /** What lies on each seated assistant's desk, the one in hand first. */
  desks: ReadonlyMap<string, DeskVolume[]>;
  /** The commissions on the felt, in the ledger's own order. */
  felt: readonly HiveTask[];
}

export function placeOpenWork(
  tasks: readonly HiveTask[], seated: ReadonlySet<string>
): Placement {
  const desks = new Map<string, DeskVolume[]>();
  const taken = new Set<string>();
  for (const holder of seated) {
    const books = booksFor(tasks, holder);
    if (books.length === 0) continue;
    desks.set(holder, books);
    for (const book of books) taken.add(book.id);
  }
  return {
    desks,
    felt: tasks.filter((task) => !concluded(task) && !taken.has(task.id))
  };
}
