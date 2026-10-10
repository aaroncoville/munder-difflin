import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * When a Codex worker starts a new thread.
 *
 * A Codex worker runs one interactive thread for as long as its process lives,
 * and a respawn resumes it, so a reviewer that handles a request a day carries
 * every earlier review in its context and pays for it again on every call. The
 * worker instead starts a new thread for each new request it is sent, and keeps
 * its thread for everything that continues the work already in it.
 *
 * The boundary, message by message:
 *  - A thread is made of the mail delivered into it and the mail the worker sent
 *    from it.
 *  - A `request` from another agent opens a new thread, unless its `in_reply_to`
 *    names a message of the current thread: a fix round answering the worker's
 *    own review, or a correction to the request it is working on, continues it.
 *    A request that replies to some other message (another agent's report, say)
 *    is still new work for this worker.
 *  - Nothing else opens one: replies, notices, and mail the app sends itself
 *    (circuit-breaker steers, scheduled jobs) concern the thread already running.
 *
 * And a thread is never replaced mid-task:
 *  - not while any message delivered into it is still in the inbox (the worker
 *    moves mail to inbox/.done/ when it has handled it), and
 *  - not when a follow-up to it is waiting, which is delivered into the current
 *    thread together with anything else pending.
 *  A new process starts its own thread, so its first request needs no other.
 *
 * A request that does not get a new thread is handled in the current one, and
 * from then on belongs to it, so a correction to it continues the thread. That
 * is recorded wherever it shows: the request is routed while the thread still
 * has mail pending, a nudge hands it to the current thread, or the worker
 * replies to it.
 */

export interface ThreadMessage {
  id: string;
  from?: string;
  act?: string;
  in_reply_to?: string | null;
}

export interface ThreadRecord {
  /** No request has reached this thread yet, so the next one belongs in it. */
  fresh: boolean;
  /** The messages delivered into this thread and those sent from it. */
  ids: string[];
}

/** Enough for any one task's back-and-forth; the oldest ids go first. */
const MAX_IDS = 500;

/** Does this message continue the thread? */
export function continuesThread(msg: ThreadMessage, thread: ThreadRecord): boolean {
  return !!msg.in_reply_to && thread.ids.includes(msg.in_reply_to);
}

/** Would this message open a new thread? `isAgent` says whether its sender is
 *  an agent on the floor rather than the app itself. */
export function opensThread(msg: ThreadMessage, thread: ThreadRecord, isAgent: (id: string) => boolean): boolean {
  return msg.act === 'request' && !!msg.from && isAgent(msg.from) && !continuesThread(msg, thread);
}

/** The pending requests a new thread should start with, or none when the
 *  current thread should take what is pending. */
export function newThreadFor(thread: ThreadRecord, inbox: ThreadMessage[], isAgent: (id: string) => boolean): string[] {
  if (thread.fresh) return [];
  if (inbox.some((m) => thread.ids.includes(m.id) || continuesThread(m, thread))) return [];
  return inbox.filter((m) => opensThread(m, thread, isAgent)).map((m) => m.id);
}

/**
 * Each Codex worker's current thread, kept on disk beside its Codex home so a
 * fix round that arrives after an app restart still finds the review it
 * belongs to.
 */
export class CodexThreads {
  private readonly records = new Map<string, ThreadRecord>();

  /** @param pathFor where an agent's record lives, or null with no hive. */
  constructor(private readonly pathFor: (agentId: string) => string | null) {}

  /** A thread the worker has had since before anything was recorded is one
   *  with history, so its next request starts a new one. */
  get(agentId: string): ThreadRecord {
    let record = this.records.get(agentId);
    if (!record) {
      record = { fresh: false, ids: [] };
      const path = this.pathFor(agentId);
      try {
        if (path && existsSync(path)) {
          const raw = JSON.parse(readFileSync(path, 'utf8'));
          if (raw && typeof raw.fresh === 'boolean' && Array.isArray(raw.ids)) {
            record = { fresh: raw.fresh, ids: raw.ids.filter((id: unknown): id is string => typeof id === 'string') };
          }
        }
      } catch { /* unreadable: treat as a thread with history */ }
      this.records.set(agentId, record);
    }
    return record;
  }

  /** The worker's process (re)started: a new process opens its own thread,
   *  while one that resumed its session keeps the record of that thread. */
  spawned(agentId: string, resumed: boolean): void {
    if (!resumed) this.save(agentId, { fresh: true, ids: [] });
  }

  /** A routed message. `isWorker` picks out the agents this applies to;
   *  `inboxOf` is a worker's pending mail. */
  observe(
    msg: ThreadMessage,
    targets: string[],
    isWorker: (id: string) => boolean,
    isAgent: (id: string) => boolean,
    inboxOf: (id: string) => ThreadMessage[]
  ): void {
    if (!msg.id) return;
    if (msg.from && isWorker(msg.from)) {
      // A reply shows the thread took the message it answers.
      const answered = msg.in_reply_to ? [msg.in_reply_to] : [];
      this.join(msg.from, [...answered, msg.id], answered.length > 0);
    }
    for (const to of targets) {
      if (to === msg.from || !isWorker(to)) continue;
      const thread = this.get(to);
      if (!opensThread(msg, thread, isAgent)) this.join(to, [msg.id], false);
      // No new thread can start while the current one has mail pending, so the
      // worker takes this request in the thread it is in.
      else if (thread.fresh || inboxOf(to).some((m) => thread.ids.includes(m.id))) this.join(to, [msg.id], true);
      // Otherwise it waits in the inbox for the new thread it opens.
    }
  }

  /** A nudge is handing this mail to the current thread. */
  adopt(agentId: string, inbox: ThreadMessage[], isAgent: (id: string) => boolean): void {
    const request = inbox.some((m) => m.act === 'request' && !!m.from && isAgent(m.from));
    this.join(agentId, inbox.map((m) => m.id).filter(Boolean), request);
  }

  /** The pending requests a new thread should start with for this worker. */
  due(agentId: string, inbox: ThreadMessage[], isAgent: (id: string) => boolean): string[] {
    return newThreadFor(this.get(agentId), inbox, isAgent);
  }

  /** A new thread was started with these messages delivered into it. */
  opened(agentId: string, ids: string[]): void {
    this.save(agentId, { fresh: false, ids: [...ids] });
  }

  /** Record `ids` as part of the thread; `handled` says it has now had a request. */
  private join(agentId: string, ids: string[], handled: boolean): void {
    const thread = this.get(agentId);
    const added = ids.filter((id) => !thread.ids.includes(id));
    const fresh = thread.fresh && !handled;
    if (!added.length && fresh === thread.fresh) return;
    this.save(agentId, { fresh, ids: [...thread.ids, ...added] });
  }

  private save(agentId: string, record: ThreadRecord): void {
    const kept = { fresh: record.fresh, ids: record.ids.slice(-MAX_IDS) };
    this.records.set(agentId, kept);
    const path = this.pathFor(agentId);
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(kept), 'utf8');
      renameSync(tmp, path);
    } catch { /* the in-memory record still holds for this run */ }
  }
}

/** One keystroke group for the terminal, written `delayMs` after the last. */
export interface PtyWrite {
  data: string;
  delayMs: number;
}

/** Gap between text and the Enter that submits it: a single write would land
 *  the Enter inside the input box. Matches the app's other typed submissions. */
const SUBMIT_DELAY_MS = 140;
/** Codex sets up the new thread before it takes input again. */
const NEW_THREAD_SETTLE_MS = 2_000;

/**
 * What to type to move a Codex worker to a new thread and hand it its mail.
 *
 * `/new` starts a new thread in the running process. Codex refuses it while a
 * turn is running, so it can never cut a turn short; at worst the message after
 * it queues into the current thread, which is where it would have gone anyway.
 * The new thread knows nothing of the hive, so the worker's brief (what its
 * process was started with) goes first, then the inbox nudge, pasted as one
 * message so its newlines do not submit it piecemeal.
 */
export function newThreadWrites(brief: string, nudge: string): PtyWrite[] {
  return [
    { data: '/new', delayMs: 0 },
    { data: '\r', delayMs: SUBMIT_DELAY_MS },
    { data: `\x1b[200~${brief}\n\n${nudge}\x1b[201~`, delayMs: NEW_THREAD_SETTLE_MS },
    { data: '\r', delayMs: SUBMIT_DELAY_MS }
  ];
}

/** Type `writes` in order. `done` hears whether every write reached the terminal;
 *  a failed write stops the rest. */
export function typeWrites(
  writes: PtyWrite[],
  write: (data: string) => boolean,
  done: (ok: boolean) => void,
  schedule: (fn: () => void, ms: number) => void = (fn, ms) => { setTimeout(fn, ms); }
): void {
  const step = (i: number): void => {
    if (i >= writes.length) { done(true); return; }
    schedule(() => {
      let ok = false;
      try { ok = write(writes[i].data); } catch { ok = false; }
      if (!ok) { done(false); return; }
      step(i + 1);
    }, writes[i].delayMs);
  };
  step(0);
}
