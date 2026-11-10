import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** How long after routing a message an identical one from the same sender is taken as a repeat. */
export const RESEND_WINDOW_MS = 10 * 60_000;

/** The fields a recipient reads. Ids and timestamps are left out: a sender writes new ones each time. */
interface Sendable {
  from?: unknown; to?: unknown; act?: unknown; subject?: unknown; body?: unknown; conversation?: unknown; in_reply_to?: unknown;
}

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
 * messages are read back from outbox/.sent. That folder belongs to the sender, so only regular
 * files are read, and what is read only ever matches that sender's own messages.
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
      if (!name.endsWith('.json') || name.startsWith('.') || name.startsWith('bad-')) continue;
      const file = join(sentDir, name);
      try {
        const st = lstatSync(file);
        if (!st.isFile() || st.size > 1_000_000 || now - st.mtimeMs >= this.windowMs) continue;
        const m = JSON.parse(readFileSync(file, 'utf8')) as Sendable | null;
        if (!m || typeof m !== 'object') continue;
        const key = sendKey({ ...m, from: sender });
        this.routedAt.set(key, Math.max(this.routedAt.get(key) ?? 0, st.mtimeMs));
      } catch { /* an unreadable copy is simply not remembered */ }
    }
  }
}
