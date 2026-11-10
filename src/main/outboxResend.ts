import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long after routing a message an identical one from the same sender is taken as a repeat. */
export const RESEND_WINDOW_MS = 10 * 60_000;

/** The fields a recipient reads. Ids and timestamps are left out: a sender writes new ones each time. The
 *  conversation is the sender's own, or absent: one the router minted for a sender that left it out is new each time. */
interface Sendable {
  from?: unknown; to?: unknown; act?: unknown; subject?: unknown; body?: unknown; conversation?: unknown; in_reply_to?: unknown;
}

/** The shape of a conversation the router mints for a message that has none. */
const MINTED_CONVERSATION = /^conv-[0-9a-f]{6}$/;

function sendKey(m: Sendable): string {
  const fields = [m.from, m.to, m.act, m.subject, m.body, m.conversation, m.in_reply_to].map((v) => (v === undefined ? null : v));
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

/**
 * Remembers what each sender had routed recently, so a message written again is delivered once.
 *
 * An agent that looks in its outbox to confirm a send finds it empty, because the router has
 * already filed the message under outbox/.sent, and may write it again. Each copy gets a new id
 * and timestamp, so repeats are matched on what the recipient reads. A message is remembered only
 * once it has been routed, so a refused one never holds back its correction.
 *
 * Memory starts empty when the app starts, so the first time a sender is seen its recently filed
 * messages are read back from outbox/.sent, each as routed at its file's modification time. That
 * folder belongs to the sender, so only regular files are read, and what is read only ever matches
 * that sender's own messages. Copies set aside as undelivered (bad-) or as repeats (dup-) are not
 * read: neither was routed. The routed copy carries a conversation the router may have minted, so
 * one of that shape is read as absent. A time in the future is taken as now; a copy whose time was
 * moved forward (touched, or copied without keeping times) can still hold back that one message
 * for the rest of the window.
 */
export class RecentSends {
  private readonly routedAt = new Map<string, number>();
  private readonly loaded = new Set<string>();

  constructor(private readonly windowMs = RESEND_WINDOW_MS) {}

  isRepeat(msg: Sendable & { from: string }, sentDir: string, now: number): boolean {
    this.load(msg.from, sentDir, now);
    for (const [key, at] of this.routedAt) if (now - at >= this.windowMs) this.routedAt.delete(key);
    return this.routedAt.has(sendKey(msg));
  }

  routed(msg: Sendable, now: number): void {
    this.routedAt.set(sendKey(msg), now);
  }

  private load(sender: string, sentDir: string, now: number): void {
    if (this.loaded.has(sender)) return;
    this.loaded.add(sender);
    let names: string[];
    try { names = readdirSync(sentDir); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.') || name.startsWith('bad-') || name.startsWith('dup-')) continue;
      const file = join(sentDir, name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > 1_000_000 || now - st.mtimeMs >= this.windowMs) continue;
        const m = JSON.parse(readFileSync(file, 'utf8')) as Sendable | null;
        if (!m || typeof m !== 'object') continue;
        const conversation = typeof m.conversation === 'string' && MINTED_CONVERSATION.test(m.conversation) ? undefined : m.conversation;
        const key = sendKey({ ...m, from: sender, conversation });
        this.routedAt.set(key, Math.max(this.routedAt.get(key) ?? 0, Math.min(st.mtimeMs, now)));
      } catch { /* an unreadable copy is simply not remembered */ }
    }
  }
}
