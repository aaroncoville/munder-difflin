/**
 * Floor-side usage events for the local usage log (docs/usage-log.md).
 *
 * Measure only, and ids, counts and durations only: these events never carry
 * message, question or answer text. They let a weekly review answer what the
 * hive log alone cannot: what starts each agent turn and how long it runs,
 * how long cards sit in each state, and how fast the owner's asks are answered.
 */

/** A delivery older than this when a prompt starts is not what started it. */
export const TRIGGER_WINDOW_MS = 10 * 60_000;

export type TurnTrigger = 'mail' | 'heartbeat' | 'scheduler' | 'breaker' | 'system' | 'direct';

export interface TurnEvent {
  kind: 'turn';
  agentId: string;
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
      kind: 'turn', agentId, startTs: o.startTs, durationMs: ts - o.startTs,
      trigger: c ? (SENDER_TRIGGERS[c.from] ?? 'mail') : 'direct'
    };
    if (c) {
      ev.from = c.from;
      if (c.id) ev.triggerId = c.id;
      // Chosen by the sender, so kept only when it is id-shaped, never as free text.
      if (c.conversation && ID_SHAPED.test(c.conversation)) ev.conversation = c.conversation;
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

export type TaskEvent =
  | { kind: 'card-transition'; cardId: string; from: string | null; to: string; msInState?: number }
  | { kind: 'ask-filed'; cardId: string; askKey: string }
  | { kind: 'ask-answered'; cardId: string; askKey: string; msSinceAsked?: number; answerLen: number; answerShape: AnswerShape };

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const time = (v: unknown): number | null => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };
const asks = (c: Card | undefined): Ask[] => (Array.isArray(c?.humanQA) ? (c!.humanQA as Ask[]) : []);
const answered = (q: Ask): boolean => typeof q.a === 'string' && q.a.trim().length > 0;

/**
 * Events between two reads of tasks.json's card list. Either side unreadable -> no events.
 * `transitions` holds each card's last transition time, kept by the caller in
 * memory: msInState is the time since that card's previous transition, and is
 * absent for a card's first transition after start (its updatedAt moves on any
 * edit, so it does not say when the status last changed).
 */
export function diffTasks(prev: unknown, next: unknown, now: number, transitions?: Map<string, number>): TaskEvent[] {
  if (!Array.isArray(prev) || !Array.isArray(next)) return [];
  const before = new Map<string, Card>();
  for (const c of prev as Card[]) { const id = str(c?.id); if (id) before.set(id, c); }
  const out: TaskEvent[] = [];
  for (const c of next as Card[]) {
    const id = str(c?.id);
    const to = str(c?.status);
    if (!id || !to) continue;
    const old = before.get(id);
    const from = old ? str(old.status) : null;
    if (from !== to) {
      const since = transitions?.get(id);
      out.push({ kind: 'card-transition', cardId: id, from, to, ...(from && since !== undefined ? { msInState: now - since } : {}) });
      transitions?.set(id, now);
    }
    const oldAsks = new Map<string, Ask>();
    for (const q of asks(old)) { const k = str(q.askedAt); if (k) oldAsks.set(k, q); }
    for (const q of asks(c)) {
      const askedAt = str(q.askedAt);
      if (!askedAt) continue;
      const askKey = `${id}@${askedAt}`;
      const was = oldAsks.get(askedAt);
      if (!was) out.push({ kind: 'ask-filed', cardId: id, askKey });
      if (answered(q) && !(was && answered(was))) {
        const a = String(q.a);
        const asked = time(askedAt);
        const at = time(q.answeredAt) ?? now;
        out.push({
          kind: 'ask-answered', cardId: id, askKey,
          ...(asked !== null && at >= asked ? { msSinceAsked: at - asked } : {}),
          answerLen: a.trim().length, answerShape: answerShape(a)
        });
      }
    }
  }
  return out;
}

// ── oversized hook messages ──────────────────────────────────────────────────

const ID_SHAPED = /^[\w.:-]{1,80}$/;

/** agent_id, hook_event_name and tool_name from the first 4 KB of a raw hook message, if id-shaped. */
export function frameIds(head: Buffer): { agentId?: string; hookEvent?: string; toolName?: string } {
  const text = head.subarray(0, 4096).toString('utf8');
  const pick = (key: string): string | undefined => {
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"]{1,80})"`).exec(text);
    return m && ID_SHAPED.test(m[1]) ? m[1] : undefined;
  };
  const out: { agentId?: string; hookEvent?: string; toolName?: string } = {};
  const agentId = pick('agent_id'); if (agentId) out.agentId = agentId;
  const hookEvent = pick('hook_event_name'); if (hookEvent) out.hookEvent = hookEvent;
  const toolName = pick('tool_name'); if (toolName) out.toolName = toolName;
  return out;
}
