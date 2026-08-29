/**
 * The Study, projected out of the existing store.
 *
 * This hook adds no state and opens no new channel: the roster comes from the
 * same store the office floor reads, and the task ledger from the same bridge
 * call the kanban makes. Everything the scene draws is derived here, so the
 * components below stay presentational and the whole room can be reasoned about
 * as one function of (roster, ledger).
 *
 * The projection is deliberately lossy in two places, and both are decisions
 * rather than shortcuts — see `cardStatusOf` and the seating rule below.
 */
import { useEffect, useMemo, useState } from 'react';
import { useStore, type Agent } from '@/store/store';
import { parseTasks, type HiveTask } from '@/components/TasksKanban';
import { concluded } from './BaizeStacks';
import type { CardStatus } from './AgentCard';
import type { BookState } from './DeskBook';
import { deskBerths, godBerth } from './roomManifest';
import { booksFor, placeOpenWork, type DeskVolume } from './deskPile';
import { shelfBooks, type ArchivedThing } from './shelfBooks';
import { studyRoom } from './StudyScene';

export interface SceneAgent {
  id: string;
  name: string;
  role?: string;
  status: CardStatus;
  /** The orchestrator, who sits at his own berth and wears his own portrait. */
  isGod?: boolean;
  berthId: string;
  /**
   * How many assistants were already seated at that berth — 0 for the first.
   *
   * A berth alone is not a place: everyone handed the same berth and nothing
   * else is drawn at identical coordinates, which is one card as far as both
   * the eye and the pointer are concerned. The scene deals each one back from
   * the one below it, and this is the count it deals by.
   */
  stackIndex: number;
  /**
   * Every commission this assistant is holding, the one in hand first.
   *
   * A desk draws them all. It used to draw one, and choosing cost nothing while
   * the card table drew the rest — but the felt now keeps only the work nobody
   * has picked up, so a card this list left out would be drawn nowhere in the
   * house at all.
   */
  books: DeskVolume[];
  /** The first of them, which is the one that lies in the painted book's place.
   *  Carried separately because it is what a flight leaves from and what the
   *  place setting draws open. Absent when the desk is clear. */
  bookState?: BookState;
  bookTitle?: string;
  /** The commission the book stands for, so pressing it can open that one. */
  bookTaskId?: string;
  /** '' renders nothing — see SpeechScroll. */
  speech: string;
}

export interface SceneState {
  agents: SceneAgent[];
  kanbanCounts: { todo: number; doing: number; blocked: number; done: number };
  /**
   * What the shelf wall holds: the concluded commissions, newest last, already
   * bounded — see `shelfBooks.ts` for the bound.
   */
  archive: ArchivedThing[];
  /**
   * The ledger itself, carried through rather than only counted.
   *
   * The card table deals the actual commissions onto the baize, and a card that
   * opens a commission needs the commission's id — which a column total does
   * not carry. This is the same array the counts were derived from, so the two
   * cannot disagree about what is on the board.
   */
  tasks: readonly HiveTask[];
  /**
   * What the card table has been given: every open commission no desk drew.
   *
   * Carried rather than worked out again at the table, because the felt and
   * the desks are two halves of ONE split — see `placeOpenWork`. Asking two
   * questions separately is how a card came to be drawn on neither.
   */
  felt: readonly HiveTask[];
}

/** Same cadence as the kanban — the ledger is a file the god edits by hand. */
const POLL_MS = 5000;

/**
 * The store's ten statuses onto the four a card can draw.
 *
 * At desk-card size the distinction that reads across a room is at-work /
 * at-rest / stuck / gone, and the finer grain already has the roster card to
 * live on. Two of these mappings are judgement calls worth stating: `waiting`
 * joins `blocked` because from the room's point of view they are the same
 * event — nothing is advancing — and only the banner cares which of you or
 * another assistant is the one being waited on. `ghost` draws as archived
 * because that is what the office floor does with it too: present, faded, not
 * working.
 */
const CARD_STATUS: Record<string, CardStatus> = {
  idle: 'idle',
  success: 'idle',
  working: 'working',
  thinking: 'working',
  compacting: 'working',
  looping: 'working',
  typing: 'working',
  blocked: 'blocked',
  waiting: 'blocked',
  ghost: 'archived'
};

export function cardStatusOf(agent: Pick<Agent, 'status' | 'archived'>): CardStatus {
  if (agent.archived) return 'archived';
  return CARD_STATUS[agent.status] ?? 'idle';
}

/** First few words of the last prompt — the office floor's desk card shows the
 *  same thing, and the scroll is that bubble in another idiom. */
function firstWords(prompt: string | undefined, maxWords = 6, maxChars = 42): string {
  if (!prompt) return '';
  const words = prompt.trim().split(/\s+/);
  let out = words.slice(0, maxWords).join(' ');
  const truncatedWords = words.length > maxWords;
  if (out.length > maxChars) out = out.slice(0, maxChars).trimEnd();
  else if (truncatedWords) out += '…';
  return out;
}

/** What the assistant is doing, or failing that what it was last asked to do. */
export function speechFor(agent: Pick<Agent, 'action' | 'lastPrompt'>): string {
  const action = (agent.action || '').trim();
  return action || firstWords(agent.lastPrompt);
}

/**
 * The book on one assistant's desk, from the cards assigned to it.
 *
 * The one in hand lies open in the painted book's place and the rest stack
 * behind it — see `deskPile.ts` for which is which and why. This carries the
 * first of them out separately, because it is the volume the place setting
 * draws open and the volume a flight leaves from.
 */
export function bookFor(tasks: readonly HiveTask[], agentId: string):
{ books: DeskVolume[]; bookState?: BookState; bookTitle?: string; bookTaskId?: string } {
  return deskOf(booksFor(tasks, agentId));
}

/** One desk's volumes, with the first carried out separately. */
function deskOf(books: DeskVolume[]):
{ books: DeskVolume[]; bookState?: BookState; bookTitle?: string; bookTaskId?: string } {
  const first = books[0];
  return first
    ? { books, bookState: first.state, bookTitle: first.title, bookTaskId: first.id }
    : { books };
}

/**
 * The work the House has concluded, as books on the shelf wall.
 *
 * The wall was the archive of departed ASSISTANTS, and Aaron read it as the
 * archive of finished WORK. His reading is the better one and this is the flip
 * to it: a departed assistant is already gone from the floor and needs no
 * second mark, whereas a concluded commission has nowhere else to be now that
 * the card table carries open work only. So the two surfaces divide the ledger
 * between them — open on the felt, finished on the wall — and which surface a
 * commission is on is what says whether it is done.
 *
 * The date is the last thing the ledger records happening on the card, not the
 * date it was raised. Nothing in `tasks.json` records a completion time, and
 * `createdAt` is the wrong stand-in for one: dating by it would drop a
 * long-running commission off the fourteen-day window the moment it finished,
 * which is precisely the commission most worth having marked.
 *
 * Two kinds of date are refused rather than believed, because the ledger is a
 * hand-written file and both were quietly wrecking the wall:
 *
 *   - A stamp LATER than the projection's own clock did not happen. A skewed
 *     machine or a hand-typed year puts one card above every real one and keeps
 *     it inside the fourteen-day window until fourteen days after a date that
 *     has not arrived — displacing recent work the whole time.
 *   - A card with no readable date at all is `null`, and stays `null`. It is
 *     then bounded by the count alone, which is the documented behaviour for
 *     anything undated on this wall. What it must NOT do is acquire a date,
 *     which is why `parseTasks` no longer invents one: a `createdAt` filled in
 *     at parse time is re-filled every five seconds, so the least-known card on
 *     the ledger stood at the newest end of the wall for ever.
 */
export function lastTouched(task: HiveTask, now: number): number | null {
  const stamps: (string | undefined)[] = [task.createdAt];
  for (const qa of task.humanQA ?? []) stamps.push(qa.askedAt, qa.answeredAt, qa.dismissedAt);
  const times = stamps
    .map((stamp) => (stamp ? Date.parse(stamp) : NaN))
    .filter((n) => Number.isFinite(n) && n <= now);
  return times.length === 0 ? null : Math.max(...times);
}

export function archiveOf(tasks: readonly HiveTask[], now: number): ArchivedThing[] {
  const things: ArchivedThing[] = tasks
    .filter(concluded)
    .map((t) => ({
      id: t.id, label: t.title, kind: 'commission' as const, at: lastTouched(t, now)
    }));
  return shelfBooks(things, now);
}

/**
 * Seat the roster.
 *
 * Reading desks are handed out in roster order, which is the order the user
 * already sees in the strip and can reorder by hand — so the house's seating
 * and the roster's agree, and summoning somebody new never reshuffles the
 * people already sitting down. The berths themselves come from the reading
 * rooms in the order the manifest builds the house, so adding a storey of desks
 * to the cross-section extends the seating without touching this. The god has
 * his own study and does not consume a reading desk on his way past.
 *
 * A house with more assistants than desks is a real state, not an error: the
 * overflow shares, rather than the scene inventing berths no room has the
 * furniture for. It shares by carrying on round the house from the first desk
 * again, so a crowd settles evenly instead of piling onto whichever desk the
 * seating ran out at — the ninth assistant of nine sits with the first, not
 * with the eighth, and a house of three times its desks is three deep
 * everywhere rather than seventeen deep in one room. Depth is what costs: each
 * assistant past the first at a desk is dealt back from the one below by a
 * fixed step, and a pile deep enough runs out of desk to recede into and stops
 * receding — `STACK_DEEPEST` is where.
 *
 * Seating stays stable through it, because a place is a function of an
 * assistant's index in the roster and nothing else: somebody new arriving at
 * the end never moves anybody already sitting down.
 */
export function projectScene(
  agents: readonly Agent[],
  tasks: readonly HiveTask[],
  now: number = Date.now()
): SceneState {
  const desks = deskBerths(studyRoom);
  const god = godBerth(studyRoom);
  /** How many are already sitting at each berth. */
  const occupancy = new Map<string, number>();
  let seat = 0;
  // Every assistant on the roster is dealt a berth, so the roster IS the
  // seating — see the seating rule above. The open work is split between the
  // desks and the felt ONCE, against that seating, so the two surfaces cannot
  // each decide the other is drawing a card.
  const placed = placeOpenWork(tasks, new Set(agents.map((a) => a.id)));
  const projected = agents.map((a) => {
    const berthId = a.isGod ? god.id : desks[seat++ % desks.length].id;
    const stackIndex = occupancy.get(berthId) ?? 0;
    occupancy.set(berthId, stackIndex + 1);
    return {
      id: a.id,
      name: a.name,
      role: a.description || undefined,
      status: cardStatusOf(a),
      isGod: a.isGod,
      berthId,
      stackIndex,
      speech: speechFor(a),
      ...deskOf(placed.desks.get(a.id) ?? [])
    };
  });
  const kanbanCounts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const t of tasks) kanbanCounts[t.status]++;
  return {
    agents: projected,
    kanbanCounts,
    archive: archiveOf(tasks, now),
    tasks,
    felt: placed.felt
  };
}

export function useSceneState(): SceneState {
  const agents = useStore((s) => s.agents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);

  useEffect(() => {
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const raw = await window.cth?.hiveTasks?.();
        if (alive) setTasks(parseTasks(raw));
      } catch { /* keep the last good ledger rather than emptying the room */ }
    };
    void poll();
    const timer = setInterval(() => { void poll(); }, POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  // `now` is read on each projection rather than held in state: the window is
  // fourteen days wide, so a clock that only advances when the roster or the
  // ledger changes is exact enough, and one that ticked would re-render the
  // whole house for nothing.
  return useMemo(
    () => projectScene(agents, tasks, Date.now()),
    [agents, tasks]
  );
}
