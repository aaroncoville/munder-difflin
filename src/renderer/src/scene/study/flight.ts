/**
 * A commission leaving a desk, and where in the building it is leaving for.
 *
 * The house draws a commission on every surface it belongs to and redraws them
 * all silently when the ledger changes, so the one moment worth noticing in a
 * room full of steady state — the move itself — was the one thing invisible.
 * This is the arithmetic behind showing it: which cards just moved, and where
 * the two ends of the flight are in the building's own coordinates.
 *
 * The arithmetic is pure on purpose. Both halves are the kind of thing that is
 * unreviewable in a running app — a flight that launches on the wrong card is
 * indistinguishable from one that launches on the right card the moment you
 * look away, and a flight that lands a room to the left is only wrong if you
 * know where the room was supposed to be. Neither needs a scene to check.
 */
import type { HiveTask } from '@/components/TasksKanban';

/**
 * Where a flight ends.
 *
 * One destination, and it is not an oversight. A flight is a commission LEAVING
 * a desk, and the only move that takes one off a desk is concluding: held work
 * lies at the desk of whoever holds it in every other state, so becoming
 * impeded seals the volume where it lies rather than sending it anywhere. The
 * type stays a union of one so that a second destination, if the house ever
 * grows one, has an obvious place to be added.
 */
export type FlightTo = 'shelf';

export interface Flight {
  /**
   * This flight's own key, unique to the launch and to nothing else.
   *
   * The same commission can fly more than once — blocked, freed, and blocked
   * again — and can do it faster than a flight lasts, so the second book takes
   * off while the first is still crossing the house. Anything derived from the
   * commission and the move it made gives those two books the same name, which
   * is a duplicate key in the sky and, worse, a landing that removes both: the
   * sky is a list filtered BY this. Hence a serial number rather than a
   * description. The prefix is there to keep it readable in a devtools tree.
   */
  id: string;
  taskId: string;
  /** Whose desk it leaves. Without an assistant there is no desk to leave. */
  agentId: string;
  title: string;
  to: FlightTo;
}

/** The ledger as the house last saw it: a status per commission, and nothing
 *  else, because a status is the only thing a flight is a change of. */
export type Seen = ReadonlyMap<string, HiveTask['status']>;

export function seenStatuses(tasks: readonly HiveTask[]): Seen {
  return new Map(tasks.map((t) => [t.id, t.status]));
}

/**
 * Launches so far, which is the only thing about a flight that is not a
 * function of the ledger.
 *
 * A key has to survive the same commission making the same move twice while the
 * first book is still in the air, and nothing in two consecutive ledgers
 * distinguishes those two launches — the second poll looks exactly like the
 * first. So identity is allocated rather than derived. It is deliberately not a
 * random value: a serial reads as an order in a devtools tree, and there is
 * only one house counting.
 */
let launches = 0;

/**
 * Where each commission went since the house last looked.
 *
 * One move is drawn, because only one is a commission leaving a desk: work that
 * concludes goes to the wall. Everything else is a card staying where it is as
 * far as the room is concerned — including work that becomes impeded, which
 * used to fly back to the card table and no longer can. The felt stopped
 * carrying held work, so that flight would cross the house to land on a surface
 * that does not draw the card and disappear there.
 *
 * `prev` being null — the first sighting — launches nothing, and that is the
 * load-bearing case rather than a nicety. A freshly opened house has no idea
 * which cards were blocked a minute ago and which were blocked last month, so
 * treating everything it finds as newly changed would empty every desk into the
 * air at once, every time anyone opens the Study. Nothing flies until the house
 * has watched the card in an earlier state itself.
 *
 * A commission with no assignee is skipped for the same reason: the flight
 * starts at a desk book, and a commission nobody is holding has no book on any
 * desk to leave.
 *
 * `reducedMotion` is answered here rather than downstream, because a request
 * for less movement is a request to be taken literally: a house that launches
 * the flights and then declines to draw them is still a house keeping a list of
 * things in the air, and the moment one of them is drawn by accident the
 * promise is broken. Nothing is launched at all.
 */
export function flightsFor(
  prev: Seen | null, next: readonly HiveTask[], reducedMotion = false
): Flight[] {
  if (!prev || reducedMotion) return [];
  const out: Flight[] = [];
  for (const task of next) {
    const agentId = (task.assignee || '').trim();
    if (!agentId) continue;
    const was = prev.get(task.id);
    // Never seen before: it did not move, it arrived.
    if (was === undefined || was === task.status) continue;
    if (task.status !== 'done') continue;
    const to: FlightTo = 'shelf';
    out.push({
      id: `${task.id}:${was}->${task.status}:${++launches}`,
      taskId: task.id,
      agentId,
      title: task.title,
      to
    });
  }
  return out;
}

/** A rectangle in the house's own drawing: origin plus size, in panel pixels. */
export interface ViewBox { x: number; y: number; w: number; h: number }

/**
 * One storey as the house actually lays it out.
 *
 * The building is a flexbox and has never computed a room's position — every
 * berth is positioned inside its own panel, and the panel is put on screen by
 * the layout. A book crossing from a desk in one room to the table in another
 * is the first thing that needs the missing arithmetic, so the caller measures
 * the storeys the way the layout does and this reproduces where they land.
 */
export interface LaidStorey {
  height: number;
  rooms: readonly { id: string; width: number }[];
}

/**
 * Where a room's panel sits inside the house's natural drawing.
 *
 * The house is padded by one band of masonry all round, its storeys are stacked
 * with a band between them, and a storey's rooms are laid left to right with a
 * band between each pair — and CENTRED, because a storey narrower than the
 * widest one stands in the middle of the building rather than at its left-hand
 * end. Returns null for a room this house does not hold, which is what a caller
 * has to be able to survive: the manifest is hand-edited.
 */
export function houseSlot(
  storeys: readonly LaidStorey[], band: number, innerWidth: number, roomId: string
): ViewBox | null {
  let y = band;
  for (const storey of storeys) {
    const spread = storey.rooms.reduce((sum, r) => sum + r.width, 0)
      + band * Math.max(0, storey.rooms.length - 1);
    let x = band + (innerWidth - spread) / 2;
    for (const room of storey.rooms) {
      if (room.id === roomId) return { x, y, w: room.width, h: storey.height };
      x += room.width + band;
    }
    y += storey.height + band;
  }
  return null;
}
