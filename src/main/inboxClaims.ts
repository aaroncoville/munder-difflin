/**
 * Splits an agent's undrained inbox into mail it has claimed and mail it has not.
 *
 * A message stays in `inbox/` until the agent has handled it and filed it under
 * `inbox/.done`. An agent working a message therefore shows the same inbox as
 * one that never looked, and a digest that lists both as "undrained" reads as a
 * stall when there is none.
 *
 * A message counts as claimed when the agent has taken a turn since it was
 * delivered. Delivery is the file's mtime: the router writes the file when it
 * delivers, whereas `created_at` is whatever the sender put there. A turn is a
 * hook event that proves one, a tool span, or a usage sample with tokens; the
 * zero-token sample written when a session starts is not a turn.
 *
 * This says the agent was active after the mail arrived, not that it read that
 * message. An agent busy with other work when mail lands reads as claimed until
 * its turn ends; the next beat then shows whether it filed the message.
 */
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { activityEvidenceAt, type ActivityEvidence } from './workerWake';

/** Delivery times (file mtimes, ms) of the messages waiting in an agent's inbox. */
export function inboxDeliveredAt(hiveRoot: string | null, agentId: string): number[] {
  if (!hiveRoot || !/^[A-Za-z0-9_-]+$/.test(agentId)) return [];
  const dir = join(hiveRoot, 'agents', agentId, 'inbox');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const times: number[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const st = lstatSync(join(dir, name));
      if (st.isFile()) times.push(st.mtimeMs);
    } catch { /* filed or removed while listing */ }
  }
  return times;
}

/** When the agent last demonstrably took a turn, or 0 when it never has. */
export function lastTurnAt(turnHookAt: number, usage: ActivityEvidence['usage'], spans: ActivityEvidence['spans']): number {
  return Math.max(turnHookAt || 0, activityEvidenceAt({ usage, spans }));
}

export interface InboxSplit { claimed: number; unclaimed: number }

/** Counts the messages delivered before the agent's last turn (claimed) and the rest. */
export function splitInbox(deliveredAt: number[], lastTurn: number): InboxSplit {
  let claimed = 0;
  for (const t of deliveredAt) if (lastTurn > t) claimed += 1;
  return { claimed, unclaimed: deliveredAt.length - claimed };
}

/** The digest's inbox line. Keeps the "Undrained inbox" lead so readers of the old line still find it. */
export function inboxLine(rows: Array<{ name: string } & InboxSplit>): string {
  const list = (key: keyof InboxSplit) =>
    rows.filter((r) => r[key] > 0).map((r) => `${r.name} ×${r[key]}`).join(', ') || 'none';
  if (!rows.some((r) => r.claimed + r.unclaimed > 0)) return 'No undrained inboxes.';
  return `Undrained inbox: unclaimed (no turn since delivery): ${list('unclaimed')}; `
    + `claimed (a turn since delivery, not yet filed): ${list('claimed')}.`;
}
