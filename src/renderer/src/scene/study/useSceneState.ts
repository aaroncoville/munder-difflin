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
import { parseTasks, waitsOnHuman, type HiveTask } from '@/components/TasksKanban';
import type { CardStatus } from './AgentCard';
import type { BookState } from './DeskBook';
import { deskBerths, godBerth } from './roomManifest';
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
  /** Absent when this assistant has no card on the ledger. */
  bookState?: BookState;
  bookTitle?: string;
  /** '' renders nothing — see SpeechScroll. */
  speech: string;
}

export interface SceneState {
  agents: SceneAgent[];
  openAskCount: number;
  kanbanCounts: { todo: number; doing: number; blocked: number; done: number };
  /**
   * What the shelf wall holds: concluded commissions and departed assistants,
   * newest last, already bounded — see `shelfArchive.ts` for the bound and for
   * why an archived assistant has no date to bound it by.
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
 * Impeded work outranks work in progress: an assistant holding a stuck card and
 * a live one is, in the only sense the room can show, stuck — and a sealed book
 * is the thing worth noticing from across the study.
 */
export function bookFor(tasks: readonly HiveTask[], agentId: string):
{ bookState?: BookState; bookTitle?: string } {
  const mine = tasks.filter((t) => t.assignee === agentId);
  for (const [status, book] of [
    ['blocked', 'sealed'], ['doing', 'open'], ['todo', 'closed']
  ] as const) {
    const hit = mine.find((t) => t.status === status);
    if (hit) return { bookState: book, bookTitle: hit.title };
  }
  return {};
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
/**
 * The people the House has parted with, as books on the shelf wall.
 *
 * Concluded commissions used to be listed here too, and that was right while
 * the card table drew four column totals: the finished work had nowhere else to
 * be. It has somewhere else now — the baize deals every commission as a book of
 * its own, done ones included — so listing them here as well drew one thing
 * twice, in two rooms, with nothing to say which mark was which.
 *
 * An archived assistant carries no timestamp anywhere in the store, so these
 * keep the store's own order and are bounded by the count alone.
 */
export function archiveOf(
  archivedAgents: readonly Agent[],
  now: number
): ArchivedThing[] {
  const things: ArchivedThing[] = archivedAgents.map((a) => ({
    id: a.id, label: a.name, kind: 'assistant' as const, at: null
  }));
  return shelfBooks(things, now);
}

export function projectScene(
  agents: readonly Agent[],
  tasks: readonly HiveTask[],
  archivedAgents: readonly Agent[] = [],
  now: number = Date.now()
): SceneState {
  const desks = deskBerths(studyRoom);
  const god = godBerth(studyRoom);
  /** How many are already sitting at each berth. */
  const seated = new Map<string, number>();
  let seat = 0;
  const projected = agents.map((a) => {
    const berthId = a.isGod ? god.id : desks[seat++ % desks.length].id;
    const stackIndex = seated.get(berthId) ?? 0;
    seated.set(berthId, stackIndex + 1);
    return {
      id: a.id,
      name: a.name,
      role: a.description || undefined,
      status: cardStatusOf(a),
      isGod: a.isGod,
      berthId,
      stackIndex,
      speech: speechFor(a),
      ...bookFor(tasks, a.id)
    };
  });
  const kanbanCounts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const t of tasks) kanbanCounts[t.status]++;
  return {
    agents: projected,
    openAskCount: tasks.filter(waitsOnHuman).length,
    kanbanCounts,
    archive: archiveOf(archivedAgents, now),
    tasks
  };
}

export function useSceneState(): SceneState {
  const agents = useStore((s) => s.agents);
  const archivedAgents = useStore((s) => s.archivedAgents);
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
    () => projectScene(agents, tasks, archivedAgents, Date.now()),
    [agents, tasks, archivedAgents]
  );
}
