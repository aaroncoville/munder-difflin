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
 * The piles hold OPEN commissions only. Concluded work goes to the shelf wall,
 * where a finished volume darkens in the painting — so each surface says one
 * thing, and the height of the piles is how much is still to do.
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
import type { HiveTask } from '@/components/TasksKanban';

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
 * How far the ends of the row ride up on the painted table, in fractions of
 * the dealing area's height.
 *
 * The baize is an ellipse. A row of feet on a straight line crosses its near
 * edge twice, so the outermost piles would stand off the table while the middle
 * ones stand on it; following the curve keeps every pile on the felt.
 */
const ARC = 0.08;

/**
 * The order the table is piled in: impeded, then underway, then intended.
 *
 * The board's own order, and for the same reason — what somebody glancing at
 * the table needs to see is what is stuck, not what happens to have the lowest
 * id. Ties keep the ledger's own order, so the table does not restack itself
 * between polls when nothing has changed.
 *
 * Concluded work is not in it because concluded work is not on this table: the
 * felt carries what the House still has to do, and a pile that also kept
 * everything ever finished would read as a busy House for ever, most of it
 * piles of things nobody has to touch. Finished commissions darken a volume on
 * the shelf wall instead, which is the surface that means "done" — see
 * `shelfBooks.ts`.
 */
const PILE_ORDER: Record<OpenStatus, number> = {
  blocked: 0, doing: 1, todo: 2
};

/** A commission the House has not finished — the only kind the table carries. */
export type OpenTask = HiveTask & { status: OpenStatus };
type OpenStatus = Exclude<HiveTask['status'], 'done'>;

export function isOpen(task: HiveTask): task is OpenTask {
  return task.status !== 'done';
}

/**
 * The number printed on a spine.
 *
 * The board shows a commission's id, and a spine has room for about two
 * digits — so the digits out of the id are what ties the two views together. An
 * id with no digits in it falls back to its place on the table, because a blank
 * spine is worse than an approximate handle.
 */
export function baizeNumber(task: HiveTask, index: number): number {
  const digits = String(task.id ?? '').match(/\d+/);
  return digits ? Number(digits[0]) : index + 1;
}

export interface Spine {
  task: OpenTask;
  box: Box;
  n: number;
  /** Which pile it is in, and how far up that pile — 0 is on the felt. */
  stack: number;
  level: number;
}

/**
 * Pile the ledger onto a rectangle of baize.
 *
 * Pure, so the ordering rule, the bound and the geometry can be checked without
 * a table, a panel or a scene anywhere near them.
 */
export function stackBaize(tasks: readonly HiveTask[], baize: Box): Spine[] {
  const taken = tasks
    .filter(isOpen)
    .map((task, i) => ({ task, i }))
    .sort((a, b) =>
      (PILE_ORDER[a.task.status] ?? 9) - (PILE_ORDER[b.task.status] ?? 9) || a.i - b.i)
    .slice(0, BAIZE_MAX);
  if (taken.length === 0) return [];

  const piles = Math.ceil(taken.length / STACK_HIGH);
  const slot = baize.width / STACKS;
  const width = slot * SPINE.width;
  const gap = slot - width;
  const thickness = baize.height * SPINE.thickness;
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
    const lean = width * (LEAN[level % LEAN.length] ?? 0);
    return {
      task,
      n: baizeNumber(task, i),
      stack,
      level,
      box: {
        left: x + lean,
        top: foot - thickness * (level + 1),
        width,
        height: thickness
      }
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
export const SPINE_FACES: Record<OpenStatus,
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
  }
};

/**
 * How big the number on a spine is printed.
 *
 * Sized FROM the spine, not from a type token: the house is laid out at its
 * natural size and letterboxed into the window as one scaled drawing, so a
 * fixed 12px face arrives on screen at three or four pixels. And it is printed
 * SIDEWAYS, the way a book carries its title, so what has to fit across the
 * thickness of the spine is the number's LENGTH — which is why a three-digit
 * commission is set smaller than a two-digit one rather than running off the
 * end of its own book.
 */
export function spineType(box: Box, n: number): { fontSize: number } {
  const digits = String(n).length;
  return { fontSize: Math.min(box.height * 0.68, (box.height * 1.6) / digits) };
}

export interface BaizeStacksProps {
  tasks: readonly HiveTask[];
  baize: Box;
  onOpen: (id: string) => void;
}

export function BaizeStacks({ tasks, baize, onOpen }: BaizeStacksProps): JSX.Element {
  return (
    <>
      {stackBaize(tasks, baize).map(({ task, box, n }) => {
        // Stopping the event is what keeps the room underneath from opening the
        // whole board on top of the commission that was just picked up.
        const open = (stop: () => void): void => { stop(); onOpen(task.id); };
        const face = SPINE_FACES[task.status];
        const { fontSize } = spineType(box, n);
        return (
          <div
            key={task.id}
            data-baize-book={task.id}
            role="button"
            tabIndex={0}
            title={`${task.title} — ${task.status}`}
            aria-label={task.title}
            onClick={(e: React.MouseEvent) => open(() => e.stopPropagation())}
            onKeyDown={(e: React.KeyboardEvent) => {
              if (e.target !== e.currentTarget) return;
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault();
              open(() => e.stopPropagation());
            }}
            style={{
              position: 'absolute',
              left: box.left,
              top: box.top,
              width: box.width,
              height: box.height,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxSizing: 'border-box',
              borderRadius: 'var(--cth-radius-badge)',
              cursor: 'pointer',
              userSelect: 'none',
              background: face.background,
              // The head band at the spine's near end, and a hairline all round
              // so one book has an edge against the next. Proportional, for the
              // same reason the type is.
              boxShadow: `inset ${Math.max(2, box.width * 0.06)}px 0 0 ${face.edge}, `
                + `inset 0 0 0 ${Math.max(1, box.height * 0.06)}px var(--cth-ink-300)`
            }}
          >
            <div
              data-baize-number=""
              style={{
                // Turned a quarter, the way a title is printed on a book that
                // is lying down: the digits run across the thickness of the
                // spine rather than along its length.
                transform: 'rotate(90deg)',
                fontFamily: 'var(--cth-font-display)',
                fontSize,
                lineHeight: 1,
                color: face.color,
                pointerEvents: 'none'
              }}
            >
              {n}
            </div>
          </div>
        );
      })}
    </>
  );
}
