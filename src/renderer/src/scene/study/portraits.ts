/**
 * Which painted face goes on which assistant's card.
 *
 * The pack is a drop-in directory that starts empty and fills up as art lands,
 * so the mapping cannot be a table of names — it has to work for an assistant
 * spawned five minutes ago against a pack of however many portraits happen to
 * exist. It hashes the agent's id into the pack instead.
 *
 * Two properties matter, and they pull in opposite directions:
 *
 *   - The SAME assistant must get the SAME face on every render, or the room
 *     reshuffles its cast whenever anything re-renders. Hence a hash of the id
 *     rather than a counter or an index into the roster, both of which move when
 *     somebody else is summoned or archived.
 *   - Adding portraits must actually use them. The pack size is therefore part
 *     of the assignment: growing the pack redistributes faces, which is a
 *     one-time reshuffle in exchange for every new portrait being seen at all.
 *
 * An empty pack yields `undefined`, and AgentCard falls back to a monogram — so
 * the Study is complete before a single portrait exists.
 */
import { PORTRAIT_FILES } from './portraits.index';

export { PORTRAIT_FILES };

/** FNV-1a, 32-bit. Small, dependency-free, and spreads short ids like `w-1`
 *  and `w-2` — which the obvious "sum the char codes" does not. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Pick one file for `id` out of `files`. Pure, so the assignment is testable
 *  without a bundler anywhere near it. */
export function assignPortrait(id: string, files: readonly string[]): string | undefined {
  if (!id || files.length === 0) return undefined;
  return files[hash(id) % files.length];
}

/** The portrait for one assistant, from the shipped pack. */
export function portraitFor(agent: { id: string; name: string; role?: string }): string | undefined {
  return assignPortrait(agent.id, PORTRAIT_FILES);
}
