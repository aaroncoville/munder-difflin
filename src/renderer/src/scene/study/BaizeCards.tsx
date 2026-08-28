/**
 * The commissions dealt out on the card table.
 *
 * The card table was a room you could click, and the numbers on the baize were
 * column totals — so the only thing a click could mean was "show me the whole
 * board". These are the cards themselves: one per commission on the ledger,
 * numbered as the board numbers them, and clicking one opens THAT one.
 *
 * It opens it through `openTaskDetail`, which is the app-wide overlay a kanban
 * card opens. That is deliberate and it is the whole of the interaction design
 * here: the Study is another way of looking at the same house, not a second
 * house with surfaces of its own that then have to be kept in step.
 *
 * The one subtlety is that a card sits INSIDE the card-table room, and the room
 * is itself a button that opens the board. A click has to stop at the card, or
 * picking up a commission would open the board over the detail it just opened.
 */
import type { HiveTask } from '@/components/TasksKanban';

export interface Box { left: number; top: number; width: number; height: number }

/**
 * How many cards the baize takes.
 *
 * Not a performance number — it is how many cards fit on a painted table at the
 * size the panel actually draws before they stop being separately clickable. A
 * ledger with forty commissions on it is a real state, and the honest thing to
 * do with it is deal the ones worth crossing the room for and leave the board
 * to show the rest.
 */
export const BAIZE_MAX = 8;

/**
 * A commission card's proportions, width over height, and how tall it stands.
 *
 * A card is a card: taller than it is wide. The dealing area is more than twice
 * as wide as it is tall, so anything that takes a share of it comes out
 * landscape — which is how the table ended up carrying eight small horizontal
 * tiles rather than a hand.
 */
const CARD = { aspect: 0.7, stand: 0.62 };

/**
 * How much of a card its neighbour may cover.
 *
 * Cards laid out on a table overlap; cards that overlap past this stop showing
 * enough of their own face to be read or pressed, so past it the hand shrinks
 * instead of tightening.
 */
const MAX_OVERLAP = 0.35;

/**
 * How far the ends of the hand ride up on the painted table, in fractions of
 * the dealing area's height.
 *
 * The baize is an ellipse. A row of feet on a straight line crosses its near
 * edge twice, so the outermost cards stand off the table while the middle ones
 * stand on it; following the curve keeps the whole hand on the felt.
 */
const ARC = 0.08;

/**
 * The order the table is dealt in: impeded, then underway, then intended, then
 * concluded.
 *
 * The board's own order, and for the same reason — what somebody glancing at
 * the table needs to see is what is stuck, not what happens to have the lowest
 * id. Ties keep the ledger's own order, so the table does not reshuffle itself
 * between polls when nothing has changed.
 */
const DEAL_ORDER: Record<HiveTask['status'], number> = {
  blocked: 0, doing: 1, todo: 2, done: 3
};

/**
 * The number printed on a card.
 *
 * The board shows a commission's id, and the table has room for about two
 * digits — so the digits out of the id are what ties the two views together. An
 * id with no digits in it falls back to the card's place on the table, because
 * a blank card is worse than an approximate handle.
 */
export function baizeNumber(task: HiveTask, index: number): number {
  const digits = String(task.id ?? '').match(/\d+/);
  return digits ? Number(digits[0]) : index + 1;
}

/**
 * Deal the ledger onto a rectangle of baize.
 *
 * As ONE spread hand, standing on the table. It used to be a four-by-two grid
 * filling the dealing area, which put only the bottom row's feet anywhere near
 * the felt: the back row had nothing under it at all and hung in the air over
 * the parlour, which is what a grid of cards on a flat panel always looks like.
 * A hand has one baseline, and that baseline is the painted table.
 *
 * The baize is an ellipse, so the baseline is a shallow arc rather than a
 * straight line — a straight row of feet crosses the near edge of an oval twice
 * and stands the outermost cards off the table.
 *
 * Pure, so the ordering rule, the bound and the geometry can be checked without
 * a table, a panel or a scene anywhere near them.
 */
export function dealBaize(
  tasks: readonly HiveTask[],
  baize: Box
): { task: HiveTask; box: Box; n: number }[] {
  const dealt = tasks
    .map((task, i) => ({ task, i }))
    .sort((a, b) =>
      (DEAL_ORDER[a.task.status] ?? 9) - (DEAL_ORDER[b.task.status] ?? 9) || a.i - b.i)
    .slice(0, BAIZE_MAX);
  const count = dealt.length;
  if (count === 0) return [];

  // As tall as the table allows and as wide as a card of that height is — but
  // never so wide that the hand cannot be spread across the felt without cards
  // covering more of each other than they can spare.
  const width = Math.min(
    baize.height * CARD.stand * CARD.aspect,
    baize.width / (1 + (count - 1) * (1 - MAX_OVERLAP))
  );
  const height = width / CARD.aspect;
  // Never further apart than their own width: two commissions are two cards
  // laid beside each other, not one at each end of the table.
  const pitch = count > 1
    ? Math.min(width, (baize.width - width) / (count - 1))
    : 0;
  const spread = width + pitch * (count - 1);
  const left = baize.left + (baize.width - spread) / 2;
  const foot = baize.top + baize.height;

  return dealt.map(({ task }, i) => {
    const u = count > 1 ? (i / (count - 1)) * 2 - 1 : 0;
    const rise = baize.height * ARC * (1 - Math.sqrt(Math.max(0, 1 - u * u)));
    return {
      task,
      n: baizeNumber(task, i),
      box: {
        left: left + pitch * i,
        top: foot - rise - height,
        width,
        height
      }
    };
  });
}

/**
 * What each status looks like on the baize — the same language the books use.
 *
 * Every card is a dark paper ground with a parchment number and a bar of its
 * status colour down the left edge, rather than a card FILLED with that colour.
 * Filled was unreadable: the printed number cleared 3.2:1 on the blocked
 * card's coral, and no ink in this palette clears 4.5 on it — a saturated
 * mid-tone has nowhere legible to put text. The bar carries the colour at full
 * strength instead, and reads faster at this size than a tinted rectangle does.
 *
 * Exported so the contrast of every pair can be measured rather than eyeballed.
 */
export const CARD_FACES: Record<HiveTask['status'],
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
  done: {
    background: 'var(--cth-paper-200)', color: 'var(--cth-ink-500)',
    edge: 'var(--cth-ink-100)'
  }
};

export interface BaizeCardsProps {
  tasks: readonly HiveTask[];
  baize: Box;
  onOpen: (id: string) => void;
}

export function BaizeCards({ tasks, baize, onOpen }: BaizeCardsProps): JSX.Element {
  return (
    <>
      {dealBaize(tasks, baize).map(({ task, box, n }) => {
        // Stopping the event is what keeps the room underneath from opening the
        // whole board on top of the card that was just picked up.
        const open = (stop: () => void): void => { stop(); onOpen(task.id); };
        return (
          <div
            key={task.id}
            data-baize-card={task.id}
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
              fontFamily: 'var(--cth-font-display)',
              // Sized FROM the card, not from a token. The whole house is laid
              // out at its natural size and then letterboxed into the window as
              // one scaled drawing, so a fixed 12px face arrives on screen at
              // three or four pixels. A fraction of the card survives the scale
              // because the card is scaled by the same number.
              fontSize: box.height * 0.5,
              lineHeight: 1,
              cursor: 'pointer',
              userSelect: 'none',
              background: CARD_FACES[task.status].background,
              color: CARD_FACES[task.status].color,
              // The status bar down the left edge, and a hairline all round so
              // the card has an edge against the baize under it. Proportional
              // for the same reason the type is.
              boxShadow: `inset ${Math.max(2, box.width * 0.09)}px 0 0 `
                + `${CARD_FACES[task.status].edge}, `
                + `inset 0 0 0 ${Math.max(1, box.width * 0.02)}px var(--cth-ink-300)`
            }}
          >
            {n}
          </div>
        );
      })}
    </>
  );
}
