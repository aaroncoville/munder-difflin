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
import { studyRoom } from './StudyScene';

export interface SceneAgent {
  id: string;
  name: string;
  role?: string;
  status: CardStatus;
  berthId: string;
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
 * overflow shares the last desk rather than the scene inventing berths no room
 * has the furniture for.
 */
export function projectScene(agents: readonly Agent[], tasks: readonly HiveTask[]): SceneState {
  const desks = deskBerths(studyRoom);
  const god = godBerth(studyRoom);
  let seat = 0;
  const projected = agents.map((a) => ({
    id: a.id,
    name: a.name,
    role: a.description || undefined,
    status: cardStatusOf(a),
    berthId: a.isGod
      ? god.id
      : desks[Math.min(seat++, desks.length - 1)].id,
    speech: speechFor(a),
    ...bookFor(tasks, a.id)
  }));
  const kanbanCounts = { todo: 0, doing: 0, blocked: 0, done: 0 };
  for (const t of tasks) kanbanCounts[t.status]++;
  return {
    agents: projected,
    openAskCount: tasks.filter(waitsOnHuman).length,
    kanbanCounts
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

  return useMemo(() => projectScene(agents, tasks), [agents, tasks]);
}
