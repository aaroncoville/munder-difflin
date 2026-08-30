/**
 * The commissions, piled on the card table as books.
 *
 * They were dealt as a spread hand of cards standing on the felt, and standing
 * is the problem: eight cards on their edges in the middle of a parlour read as
 * eight cards balanced on a table, and the more there were the thinner and
 * flimsier each one got. A pile of books lying flat reads as WORK — you see the
 * volume of it across the room before you read a single number, which is the
 * only thing the table has to say at this size.
 *
 * The piles hold what the House is not finished with. Concluded work goes to
 * the shelf wall, where a finished volume darkens in the painting — so each
 * surface says one thing, and the height of the piles is how much is still to
 * do. The one exception is a concluded commission that still holds an
 * unanswered question: the wall is BOUNDED, by an age window and by the number
 * of volumes the painting has, so a question shelved is a question that can
 * fall off the wall entirely — and the wall does not print the waiting-on-you
 * mark in any case. It stays here until the question is resolved.
 *
 * So: up to four piles on the baize, each growing upward a spine at a time.
 * When a pile reaches its height the next one starts beside it, the way books
 * actually accumulate on a table. The number is printed sideways on the spine,
 * as a book carries its title — small, and deliberately secondary to the shape
 * of the pile.
 *
 * Clicking a spine opens THAT commission, through `openTaskDetail` — the
 * app-wide overlay a kanban card opens. That is unchanged and it is the whole
 * of the interaction design here: the Study is another way of looking at the
 * same house, not a second house with surfaces of its own.
 *
 * The one subtlety is that a spine sits INSIDE the card-table room, and the
 * room is itself a button that opens the board. A click has to stop at the
 * book, or picking one up would open the board over the detail it just opened.
 */
import { waitsOnHuman, type HiveTask } from '@/components/TasksKanban';
import { SpineBook } from './SpineBook';
import type { PulledBooks } from './pulledBooks';

export interface Box { left: number; top: number; width: number; height: number }

/**
 * How many piles the table holds, and how tall one gets before the next starts.
 *
 * Not a performance number: it is how much the painted table can carry before
 * the piles stop being piles. Four across is what fits the felt at a spine wide
 * enough to press; six high is where a pile stops reading as a pile and starts
 * reading as a column. A ledger with more than twenty-four commissions on it is
 * a real state, and the honest thing to do with it is show the ones worth
 * crossing the room for and leave the board to show the rest.
 */
export const STACKS = 4;
export const STACK_HIGH = 6;
export const BAIZE_MAX = STACKS * STACK_HIGH;

/**
 * The proportions of one pile, in fractions of the dealing area.
 *
 * A spine is a book seen end-on, so it is much wider than it is thick. The
 * thickness is what the whole drawing rests on: too thin and the numbers go,
 * too thick and six of them stand off the top of the table.
 */
const SPINE = {
  /** How much of its slot a spine takes across; the rest is the gap. */
  width: 0.78,
  /** How thick one book is, as a fraction of the dealing area's height. */
  thickness: 0.12
};

/**
 * How far each book above the bottom one sits out of true, in fractions of a
 * spine's width.
 *
 * Books stacked by hand do not line up, and a pile drawn with perfectly
 * flush edges is a bar chart. Fixed rather than random, so the pile does not
 * shuffle itself every time the ledger is polled; and small enough that the
 * whole pile still stands over the foot it rests on.
 */
const LEAN = [0, 0.05, -0.04, 0.03, -0.05, 0.02];

/**
 * How big one book is, given the felt it is dealt onto.
 *
 * Stated here rather than inside the dealing, because a reading desk piles the
 * SAME volumes and has to be able to ask what size they are. Asking is the
 * whole point: a desk that carried its own copy of these proportions is a desk
 * that goes on dealing the old book after the felt's has changed.
 */
export function feltSpine(baize: { width: number; height: number }):
{ width: number; height: number } {
  return { width: (baize.width / STACKS) * SPINE.width, height: baize.height * SPINE.thickness };
}

/**
 * One book of a pile, `level` up from the surface the pile stands on.
 *
 * The foot is a point, not a box: what a pile needs to know is where the
 * surface is and where the near end of it lies, and every surface in the house
 * that carries books — the felt, a reading desk — has both. Level 0 stands on
 * the surface, and each one above sits on the last, out of true by a fixed
 * amount so the pile is a pile and not a bar chart.
 */
export function pileBox(
  foot: { left: number; bottom: number },
  spine: { width: number; height: number },
  level: number
): Box {
  return {
    left: foot.left + spine.width * (LEAN[level % LEAN.length] ?? 0),
    top: foot.bottom - spine.height * (level + 1),
    width: spine.width,
    height: spine.height
  };
}

/**
 * How far the ends of the row ride up on the painted table, in fractions of
 * the dealing area's height.
 *
 * The baize is an ellipse. A row of feet on a straight line crosses its near
 * edge twice, so the outermost piles would stand off the table while the middle
 * ones stand on it; following the curve keeps every pile on the felt.
 */
const ARC = 0.08;

/**
 * The order the table is piled in: what needs YOU, then impeded, then underway,
 * then intended, then the concluded — which are only ever here at all because
 * they are still waiting on you.
 *
 * The board's own order after the first rank, and for the same reason — what
 * somebody glancing at the table needs to see is what is stuck, not what
 * happens to have the lowest id. Ties keep the ledger's own order, so the table
 * does not restack itself between polls when nothing has changed.
 *
 * A commission waiting on the human is dealt FIRST because of the bound. Open
 * work the bound cuts is still on the board and the table says as much; a
 * concluded commission the bound cut would be on NEITHER surface of the Study,
 * since the wall will not take it while the question stands. First is where the
 * bound cannot reach it.
 */
const PILE_ORDER: Record<HiveTask['status'], number> = {
  blocked: 1, doing: 2, todo: 3, done: 4
};

export function pileRank(task: HiveTask): number {
  return waitsOnHuman(task) ? 0 : PILE_ORDER[task.status] ?? 9;
}

/**
 * Whether the House is finished with a commission — the shelf wall's own test.
 *
 * Stated on its own rather than as "not on the table", which is what it used to
 * be. The three surfaces divide the ledger between them, and defining any one
 * of them by the absence of another makes them share a single rule: the moment
 * the felt stopped taking work that is in somebody's hands, every held card
 * became "not on the table" and would have been filed on the wall as concluded.
 */
export function concluded(task: HiveTask): boolean {
  return task.status === 'done' && !waitsOnHuman(task);
}

/**
 * The mark printed on a spine.
 *
 * The board shows a commission's id, and a spine has room for about two
 * characters — so the digits out of the id are what ties the two views
 * together. An id with no digits in it gets its first letters instead, because
 * a blank spine is worse than an approximate handle, and letters cannot be
 * mistaken for another commission's number.
 *
 * The mark comes out of the COMMISSION and never out of where the commission
 * happens to be standing. The fallback used to be the book's index in whatever
 * list it had been dealt into, and the two surfaces deal into different lists:
 * the table's index is a position among sorted open work, the wall's is a slot
 * in the archive. So one commission was marked `3` on the felt and `1` on the
 * wall, and either changed the moment a neighbour was added, finished or
 * answered. A handle that moves is not a handle — it says two books are the
 * same commission, or that one commission is two. There is no index to pass
 * here now, which is what makes that unrepeatable rather than merely fixed.
 *
 * Asks for an id and nothing else, so a commission filed on the shelf wall —
 * which reaches its spine as an archive entry rather than as a ledger card —
 * gets the same mark the table would have printed on it.
 */
export function spineMark(item: { id: string }): number | string {
  const id = String(item.id ?? '');
  const digits = id.match(/\d+/);
  if (digits) return Number(digits[0]);
  // The ledger is a file edited by hand, so an id can be blank or punctuation
  // alone. A mark that admits it does not know still beats a blank spine.
  return id.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || '?';
}

export interface Spine {
  task: HiveTask;
  box: Box;
  n: number | string;
  /** Which pile it is in, and how far up that pile — 0 is on the felt. */
  stack: number;
  level: number;
}

/**
 * Pile onto a rectangle of baize the commissions the felt has been given.
 *
 * It decides the ORDER, the bound and the geometry, and no longer decides
 * membership: what belongs on the felt is settled once, for the whole ledger,
 * by `placeOpenWork` — which is the only way the felt and the desks can be
 * guaranteed to divide the work between them rather than each drop a card the
 * other also dropped.
 *
 * Pure, so all three can be checked without a table, a panel or a scene
 * anywhere near them.
 */
export function stackBaize(tasks: readonly HiveTask[], baize: Box): Spine[] {
  const taken = tasks
    .map((task, i) => ({ task, i }))
    .sort((a, b) => pileRank(a.task) - pileRank(b.task) || a.i - b.i)
    .slice(0, BAIZE_MAX);
  if (taken.length === 0) return [];

  const piles = Math.ceil(taken.length / STACK_HIGH);
  const slot = baize.width / STACKS;
  const spine = feltSpine(baize);
  const width = spine.width;
  const gap = slot - width;
  // Centred as a group: one pile stands in the middle of the table rather than
  // at the left-hand end of a row of three empty places.
  const spread = piles * width + (piles - 1) * gap;
  const left = baize.left + (baize.width - spread) / 2;
  const middle = baize.left + baize.width / 2;

  return taken.map(({ task }, i) => {
    const stack = Math.floor(i / STACK_HIGH);
    const level = i % STACK_HIGH;
    const x = left + stack * (width + gap);
    // Where this pile's foot sits on the ellipse: further from the middle of
    // the table, further back up the near edge of it.
    const u = (x + width / 2 - middle) / (baize.width / 2);
    const rise = baize.height * ARC * (1 - Math.sqrt(Math.max(0, 1 - u * u)));
    const foot = baize.top + baize.height - rise;
    return {
      task,
      n: spineMark(task),
      stack,
      level,
      box: pileBox({ left: x, bottom: foot }, spine, level)
    };
  });
}

/**
 * What each status looks like on the felt — the same language the desk books
 * and the archive's shelves use.
 *
 * Every spine is a bound volume: a paper-toned board with the status colour
 * carried at the head of it at full strength, rather than a spine FILLED with
 * that colour. Filled was unreadable at card size and is no better at spine
 * size: the printed number cleared 3.2:1 on the blocked card's coral, and no
 * ink in this palette clears 4.5 on it.
 *
 * Exported so the contrast of every pair can be measured rather than eyeballed.
 */
export const SPINE_FACES: Record<HiveTask['status'],
{ background: string; color: string; edge: string }> = {
  blocked: {
    background: 'var(--cth-coral-light)', color: 'var(--cth-ink-900)',
    edge: 'var(--cth-status-blocked)'
  },
  doing: {
    background: 'var(--cth-lemon-light)', color: 'var(--cth-ink-900)',
    edge: 'var(--cth-status-working)'
  },
  todo: {
    background: 'var(--cth-paper-100)', color: 'var(--cth-ink-900)',
    edge: 'var(--cth-ink-300)'
  },
  // Only ever drawn for a concluded commission that is still waiting on you —
  // which then wears the petition head over this one. The face is here because
  // a status without one paints as no face at all rather than as a wrong one.
  done: {
    background: 'var(--cth-paper-200)', color: 'var(--cth-ink-500)',
    edge: 'var(--cth-ink-100)'
  }
};

/**
 * How big the number on a spine is printed.
 *
 * Sized FROM the spine, not from a type token: the house is laid out at its
 * natural size and letterboxed into the window as one scaled drawing, so a
 * fixed 12px face arrives on screen at three or four pixels. And it is printed
 * SIDEWAYS, the way a book carries its title, so what has to fit across the
 * thickness of the spine is the mark's LENGTH — which is why a three-figure
 * commission is set smaller than a two-figure one rather than running off the
 * end of its own book.
 *
 * It is therefore sized from the spine's THICKNESS alone, which is all this
 * asks for: a book lying on a table is thick across its height, and a book
 * standing on a shelf is thick across its width — the same rule, turned a
 * quarter.
 */
export function spineType(box: { height: number }, n: number | string): { fontSize: number } {
  const figures = String(n).length;
  return { fontSize: Math.min(box.height * 0.68, (box.height * 1.6) / figures) };
}

/**
 * The head a commission wears when it is waiting on the human.
 *
 * The parlour used to print the NUMBER of waiting petitions on the stack of
 * letters, which the painting puts on the right-hand bookcase — a bare digit on
 * a shelf of books, counting commissions that were already drawn as books on
 * the felt in the same room. The mark belongs on the commission, so it is here:
 * the same lilac the board's own "?" badge wears, at the head of the spine,
 * where the status colour would otherwise be.
 */
export const PETITION_EDGE = 'var(--cth-lilac)';

export interface BaizeStacksProps {
  /** The commissions the felt has been given — see `placeOpenWork`. */
  tasks: readonly HiveTask[];
  baize: Box;
  onOpen: (id: string) => void;
  /** Passed straight through to the spines — the felt holds no hover state of
   *  its own, because the house holds ONE for every surface books stand on. */
  pulled?: PulledBooks;
  onPull?: (next: PulledBooks) => void;
}

export function BaizeStacks({
  tasks, baize, onOpen, pulled, onPull
}: BaizeStacksProps): JSX.Element {
  return (
    <>
      {stackBaize(tasks, baize).map(({ task, box }) => (
        <SpineBook
          key={task.id}
          id={task.id}
          title={task.title}
          status={task.status}
          petition={waitsOnHuman(task)}
          box={box}
          surface="felt"
          onOpen={onOpen}
          {...(pulled ? { pulled } : {})}
          {...(onPull ? { onPull } : {})}
        />
      ))}
    </>
  );
}
