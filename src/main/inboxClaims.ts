/**
 * Splits an agent's undrained inbox into mail it has claimed and mail it has not.
 *
 * A message stays in `inbox/` until the agent has handled it and filed it under
 * `inbox/.done`. An agent working a message therefore shows the same inbox as
 * one that never looked, and a digest that lists both as "undrained" reads as a
 * stall when there is none.
 *
 * A message counts as claimed while the agent has a turn open whose latest hook
 * came after the message was delivered. A turn opens on a prompt, a tool call or
 * a subagent, and closes on Stop or on the CLI saying it is waiting for input;
 * past WORKER_WAKE_TURN_CEILING_MS without a hook it no longer counts as open.
 * So once the turn ends, mail it did not file reads as unclaimed again: an agent
 * left idle with unfiled mail is never shown as working it.
 *
 * Telemetry is not used. It cannot tell an open turn from one that has ended,
 * and the Claude transcript fallback stamps its sample with the time it was
 * read, not the time of any activity.
 *
 * Delivery is the file's mtime: the router writes the file when it delivers,
 * whereas `created_at` is whatever the sender put there.
 *
 * Claimed still means only that the agent was working after the mail arrived,
 * not that it read that message: an agent busy with other work when mail lands
 * reads as claimed until that turn ends.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isFolderName } from './messageTarget';
import { WORKER_WAKE_TURN_CEILING_MS } from './workerWake';

/**
 * Delivery times (file mtimes, ms) of the messages waiting in an agent's inbox.
 * Counts the files the hive's own inbox reader returns: `*.json` that parse.
 */
export function inboxDeliveredAt(hiveRoot: string | null, agentId: string): number[] {
  if (!hiveRoot || !isFolderName(agentId)) return [];
  const dir = join(hiveRoot, 'agents', agentId, 'inbox');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const times: number[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = join(dir, name);
    try {
      const st = statSync(file);
      if (!st.isFile()) continue;
      JSON.parse(readFileSync(file, 'utf8'));
      times.push(st.mtimeMs);
    } catch { /* unreadable, not JSON, or filed while listing */ }
  }
  return times;
}

/** The time an open turn can claim mail delivered before, or 0 when no turn is open. */
export function openTurnClaimAt(openTurnLastAt: number, now: number): number {
  return openTurnLastAt > 0 && now - openTurnLastAt < WORKER_WAKE_TURN_CEILING_MS ? openTurnLastAt : 0;
}

export interface InboxSplit { claimed: number; unclaimed: number }

/** Counts the messages delivered before `claimAt` (claimed) and the rest. */
export function splitInbox(deliveredAt: number[], claimAt: number): InboxSplit {
  let claimed = 0;
  for (const t of deliveredAt) if (claimAt > t) claimed += 1;
  return { claimed, unclaimed: deliveredAt.length - claimed };
}

/** The digest's inbox line. Keeps the "Undrained inbox" lead so readers of the old line still find it. */
export function inboxLine(rows: Array<{ name: string } & InboxSplit>): string {
  const list = (key: keyof InboxSplit) =>
    rows.filter((r) => r[key] > 0).map((r) => `${r.name} ×${r[key]}`).join(', ') || 'none';
  if (!rows.some((r) => r.claimed + r.unclaimed > 0)) return 'No undrained inboxes.';
  return `Undrained inbox: unclaimed (no turn open since delivery): ${list('unclaimed')}; `
    + `claimed (a turn open since delivery, not yet filed): ${list('claimed')}.`;
}
