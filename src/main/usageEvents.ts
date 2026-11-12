/**
 * Floor-side usage events for the local usage log (docs/usage-log.md).
 *
 * Measure only, and ids, counts and durations only: these events never carry
 * message, question or answer text. They let a weekly review answer what the
 * hive log alone cannot: what starts each agent turn and how long it runs,
 * how long cards sit in each state, and how fast the owner's asks are answered.
 */

import { isSafeMessageId } from './messageId';

// ── field validators ─────────────────────────────────────────────────────────
// Every string written to a row passes one of these, or the field is left out
// (the row stays). Nothing is copied through because it is merely non-empty.

/** Agent, card and conversation ids: a short token, no spaces or punctuation runs. */
const ID_SHAPED = /^[A-Za-z0-9][\w.:-]{0,79}$/;
const asId = (v: unknown): string | undefined => (typeof v === 'string' && ID_SHAPED.test(v) ? v : undefined);
const asMessageId = (v: unknown): string | undefined => (isSafeMessageId(v) ? v : undefined);
export const CARD_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const;
type CardStatus = typeof CARD_STATUSES[number];
const asStatus = (v: unknown): CardStatus | undefined =>
  (typeof v === 'string' && (CARD_STATUSES as readonly string[]).includes(v) ? (v as CardStatus) : undefined);
/** A timestamp string, parsed and re-emitted in canonical ISO form, never copied. */
const asIso = (v: unknown): string | undefined => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/** A delivery older than this when a prompt starts is not what started it. */
export const TRIGGER_WINDOW_MS = 10 * 60_000;

export type TurnTrigger = 'mail' | 'heartbeat' | 'scheduler' | 'breaker' | 'system' | 'direct';

export interface TurnEvent {
  kind: 'turn';
  agentId?: string;
  startTs: number;
  durationMs: number;
  trigger: TurnTrigger;
  from?: string;
  triggerId?: string;
  conversation?: string;
}

interface Delivery { from: string; id?: string; conversation?: string; ts: number }

const SENDER_TRIGGERS: Record<string, TurnTrigger> = {
  heartbeat: 'heartbeat', scheduler: 'scheduler', breaker: 'breaker', system: 'system'
};

/**
 * Pairs each agent's prompt with its stop, and names the newest hive delivery
 * to that agent that came before the prompt (within TRIGGER_WINDOW_MS) as what
 * started the turn. A delivery starts at most one turn.
 */
export class TurnTracker {
  private readonly pending = new Map<string, Delivery>();
  private readonly open = new Map<string, { startTs: number; cause: Delivery | null }>();

  noteDelivery(agentId: string, msg: { from: string; id?: string; conversation?: string }, ts: number): void {
    this.pending.set(agentId, { from: msg.from, id: msg.id, conversation: msg.conversation, ts });
  }

  prompt(agentId: string, ts: number): void {
    const d = this.pending.get(agentId);
    const cause = d && d.ts <= ts && ts - d.ts <= TRIGGER_WINDOW_MS ? d : null;
    this.pending.delete(agentId);
    this.open.set(agentId, { startTs: ts, cause });
  }

  stop(agentId: string, ts: number): TurnEvent | null {
    const o = this.open.get(agentId);
    if (!o) return null;
    this.open.delete(agentId);
    const c = o.cause;
    const ev: TurnEvent = {
      kind: 'turn', startTs: o.startTs, durationMs: ts - o.startTs,
      trigger: c ? (SENDER_TRIGGERS[c.from] ?? 'mail') : 'direct'
    };
    const id = asId(agentId); if (id) ev.agentId = id;
    if (c) {
      const from = asId(c.from); if (from) ev.from = from;
      const triggerId = asMessageId(c.id); if (triggerId) ev.triggerId = triggerId;
      // Chosen by the sender, so kept only when it is id-shaped, never as free text.
      const conversation = asId(c.conversation); if (conversation) ev.conversation = conversation;
    }
    return ev;
  }
}

// ── tasks.json ───────────────────────────────────────────────────────────────

export type AnswerShape = 'done-ack' | 'option' | 'short' | 'sentence' | 'long';

/** The shape of an answer, so the review can tell one-tap answers from real decisions. */
export function answerShape(answer: string): AnswerShape {
  const a = answer.trim().toLowerCase().replace(/[.!]+$/, '');
  if (['done', 'ack', 'ok', 'okay', 'yes', 'no', 'go', 'superseded', 'merged'].includes(a)) return 'done-ack';
  if (/^[a-z0-9]$/.test(a)) return 'option';
  if (a.length <= 20) return 'short';
  if (a.length <= 280) return 'sentence';
  return 'long';
}

interface Card { id?: unknown; status?: unknown; updatedAt?: unknown; humanQA?: unknown }
interface Ask { askedAt?: unknown; a?: unknown; answeredAt?: unknown }

/** Rows from comparing two reads of tasks.json, so `sampled`: a change between
 *  reads that was undone, or a status passed through, is never seen. */
export type TaskEvent =
  | { kind: 'card-transition'; sampled: true; cardId?: string; from?: CardStatus | null; to?: CardStatus; msInState?: number }
  | { kind: 'ask-filed'; sampled: true; cardId?: string; askKey?: string }
  | { kind: 'ask-answered'; sampled: true; cardId?: string; askKey?: string; msSinceAsked?: number; answerLen: number; answerShape: AnswerShape };

/** A card's last observed transition, kept by the caller in memory. */
export interface SeenTransition { ts: number; to: string }

/** A move between 'todo' and 'blocked' or 'done' skipped 'doing' (or was sampled
 *  across it), so the time it reports in its old state is not that state's. */
const skipsAStatus = (from: string, to: string): boolean =>
  (from === 'todo' && (to === 'blocked' || to === 'done')) || (to === 'todo' && (from === 'blocked' || from === 'done'));

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const time = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const asks = (c: Card | undefined): Ask[] => (Array.isArray(c?.humanQA) ? (c!.humanQA as Ask[]) : []);
const answered = (q: Ask): boolean => typeof q.a === 'string' && q.a.trim().length > 0;

/**
 * Events between two reads of tasks.json's card list. Either side unreadable -> no events.
 * `transitions` holds each card's last observed transition, kept by the caller
 * in memory. msInState is the time since that transition, and only when it was
 * seen ending in this row's old status and the move did not skip a status;
 * otherwise it is left out rather than guessed (updatedAt moves on any edit, so
 * it does not say when the status last changed).
 */
export function diffTasks(prev: unknown, next: unknown, now: number, transitions?: Map<string, SeenTransition>): TaskEvent[] {
  if (!Array.isArray(prev) || !Array.isArray(next)) return [];
  const before = new Map<string, Card>();
  for (const c of prev as Card[]) { const id = str(c?.id); if (id) before.set(id, c); }
  const out: TaskEvent[] = [];
  for (const c of next as Card[]) {
    const key = str(c?.id);
    const to = str(c?.status);
    if (!key || !to) continue;
    const cardId = asId(key);
    const old = before.get(key);
    const from = old ? str(old.status) : null;
    if (from !== to) {
      const ev: TaskEvent = { kind: 'card-transition', sampled: true };
      if (cardId) ev.cardId = cardId;
      if (from === null) ev.from = null; else { const f = asStatus(from); if (f) ev.from = f; }
      const t = asStatus(to); if (t) ev.to = t;
      const seen = transitions?.get(key);
      if (from && seen && seen.to === from && !skipsAStatus(from, to) && now >= seen.ts) ev.msInState = now - seen.ts;
      transitions?.set(key, { ts: now, to });
      out.push(ev);
    }
    const oldAsks = new Map<string, Ask>();
    for (const q of asks(old)) { const k = str(q.askedAt); if (k) oldAsks.set(k, q); }
    for (const q of asks(c)) {
      const askedAt = str(q.askedAt);
      if (!askedAt) continue;
      // The key the owner's side also uses: card id @ canonical ask time. Left
      // out when either part is not a valid id or timestamp.
      const iso = asIso(askedAt);
      const askKey = cardId && iso ? `${cardId}@${iso}` : undefined;
      const ids = { ...(cardId ? { cardId } : {}), ...(askKey ? { askKey } : {}) };
      const was = oldAsks.get(askedAt);
      if (!was) out.push({ kind: 'ask-filed', sampled: true, ...ids });
      if (answered(q) && !(was && answered(was))) {
        const a = String(q.a);
        const asked = time(askedAt);
        const at = time(q.answeredAt) ?? now;
        out.push({
          kind: 'ask-answered', sampled: true, ...ids,
          ...(asked !== null && at >= asked ? { msSinceAsked: at - asked } : {}),
          answerLen: a.trim().length, answerShape: answerShape(a)
        });
      }
    }
  }
  return out;
}

// ── oversized hook messages ──────────────────────────────────────────────────

/**
 * String values of the wanted keys at the top level of a JSON object, read from
 * a prefix that may be cut off anywhere. Values inside nested objects or arrays
 * (tool input, tool output) are never read.
 */
function topLevelStrings(text: string, want: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  let depth = 0;
  let key: string | null = null;
  let afterColon = false;
  let i = 0;
  const readString = (): string | null => {
    let v = '';
    for (i++; i < text.length; i++) {
      const ch = text[i];
      if (ch === '\\') { v += text.slice(i, i + 2); i++; continue; }
      if (ch === '"') { i++; return v; }
      v += ch;
    }
    return null; // cut off inside the string
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      const v = readString();
      if (v === null) break;
      if (depth === 1) {
        if (afterColon) { if (key !== null && want.includes(key) && !out.has(key)) out.set(key, v); key = null; afterColon = false; }
        else key = v;
      }
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') { depth--; if (depth === 1) { key = null; afterColon = false; } }
    else if (depth === 1 && ch === ':') afterColon = key !== null;
    else if (depth === 1 && ch === ',') { key = null; afterColon = false; }
    i++;
  }
  return out;
}

/** agent_id, hook_event_name and tool_name from the top level of the first 4 KB
 *  of a raw hook message, each kept only if id-shaped. */
export function frameIds(head: Buffer): { agentId?: string; hookEvent?: string; toolName?: string } {
  const top = topLevelStrings(head.subarray(0, 4096).toString('utf8'), ['agent_id', 'hook_event_name', 'tool_name']);
  const out: { agentId?: string; hookEvent?: string; toolName?: string } = {};
  const agentId = asId(top.get('agent_id')); if (agentId) out.agentId = agentId;
  const hookEvent = asId(top.get('hook_event_name')); if (hookEvent) out.hookEvent = hookEvent;
  const toolName = asId(top.get('tool_name')); if (toolName) out.toolName = toolName;
  return out;
}
