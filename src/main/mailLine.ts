/**
 * One line of context that tells an agent in the middle of a turn that new hive mail has arrived.
 *
 * Mail is delivered as files into <agent>/inbox/. An agent otherwise reads it only when its turn ends and the idle
 * wake prompts it, which can be many minutes after a reply that changes what it is building. The hook server adds
 * this line to the next PostToolUse, so the agent hears within one tool call.
 *
 * The line is built from a summary the app keeps as it delivers each message, never from the inbox folder: the hook
 * path reads no directory and opens no file, so no number or kind of files a seat puts in an inbox can slow it. The
 * summary holds a count and a bounded list of sender ids. The sender is the one the app itself routed the message
 * from (the agent whose outbox it took it from, or the app), never a field read from the file, and it is printed only
 * when it is on the roster or is the app; anything else prints as "unknown". Subjects and bodies are free text
 * written by other agents, so they are never copied into a running turn.
 *
 * The summary is emptied when its line is taken and when the agent's turn ends; mail still unread then is the idle
 * wake's to announce. It lives in memory only and starts empty after a restart, for the same reason.
 */

/** Senders listed by id; messages from any other sender are summed up as "+N more". */
export const MAIL_LINE_MAX_SENDERS = 8;
/** The shape of a sender id the line will print: a short plain agent id. */
const PRINTABLE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The id to print for a sender the app routed: `id` itself when the app knows it (on the roster, or the app) and it
 *  is a short plain agent id, else "unknown". */
export function mailSender(id: string, known: boolean): string {
  return known && PRINTABLE_ID.test(id) ? id : 'unknown';
}

/** The line for `count` new messages from `senders` (distinct, in arrival order), `more` of them from senders not
 *  named. */
export function mailLine(count: number, senders: string[], more = 0): string {
  const from = senders.join(', ') + (more > 0 ? `, +${more} more` : '');
  return `[hive] ${count} new inbox message${count === 1 ? '' : 's'} (from: ${from}). Read your inbox at your next stopping point.`;
}

/** Per agent: mail delivered since its line was last taken. Constant space: two counts and at most MAX_SENDERS ids.
 *  The caller keeps entries only for agents that can take a line, and deletes one when its agent goes. */
export class PendingMail {
  private readonly byAgent = new Map<string, { count: number; senders: string[]; more: number }>();

  /** One message delivered to `agentId`, from `sender` as the app routed it (already checked by the caller). */
  delivered(agentId: string, sender: string): void {
    let s = this.byAgent.get(agentId);
    if (!s) { s = { count: 0, senders: [], more: 0 }; this.byAgent.set(agentId, s); }
    s.count++;
    if (s.senders.includes(sender)) return;
    if (s.senders.length < MAIL_LINE_MAX_SENDERS) s.senders.push(sender);
    else s.more++;
  }

  /** The line for this agent's pending summary, or null; the summary is emptied. */
  take(agentId: string): string | null {
    const s = this.byAgent.get(agentId);
    if (!s) return null;
    this.byAgent.delete(agentId);
    return mailLine(s.count, s.senders, s.more);
  }

  /** Forget this agent's summary: its turn ended or a new one began (it reads its inbox then), or it is gone. */
  clear(agentId: string): void {
    this.byAgent.delete(agentId);
  }
}
