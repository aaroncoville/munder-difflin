/**
 * Which painted face goes on which assistant's card.
 *
 * There are two rules, and the order between them is the whole design.
 *
 * **A name matches a face.** Workers are summoned with a name taken from the
 * pack itself — that is what `hive/config/worker-name-pool.txt` is for — so an
 * assistant called `leo` should wear `leo.png` and not whichever face a hash
 * happened to land on. This has to come first, or the name pool is decoration.
 * It is why the generated index carries `PORTRAIT_NAMES` beside the imported
 * files at all: an import yields a fingerprinted URL and the filename is gone
 * by the time the app sees it.
 *
 * **Anything else is hashed.** An assistant named something outside the pack —
 * renamed by hand, imported from a hire manifest, spawned before the pool
 * existed — still gets a face, deterministically, from its id. Two properties
 * pull against each other there and both are wanted:
 *
 *   - The SAME assistant gets the SAME face on every render, or the room
 *     reshuffles its cast whenever anything re-renders. Hence a hash of the id
 *     rather than a counter or an index into the roster, both of which move
 *     when somebody else is summoned or archived.
 *   - Adding portraits must actually use them. The pack size is part of the
 *     assignment, so growing the pack redistributes faces — a one-time
 *     reshuffle in exchange for every new portrait being seen at all.
 *
 * An empty pack yields `undefined` and the card falls back to a monogram, so
 * the Study was complete before a single portrait existed and still is if the
 * directory is emptied.
 */
import { PORTRAIT_FILES, PORTRAIT_NAMES } from './portraits.index';

export { PORTRAIT_FILES, PORTRAIT_NAMES };

/**
 * The orchestrator's own face, reserved by name.
 *
 * Aaron's pick, and it is reserved in both directions: the god always wears it,
 * and it is held out of the pool the hash deals from so no worker is ever dealt
 * the face of the person running the House.
 */
export const GOD_PORTRAIT = 'fascination';

/** The pack minus the reserved faces — what an unnamed assistant is dealt. */
const DEALABLE = PORTRAIT_FILES.filter((_, i) => PORTRAIT_NAMES[i] !== GOD_PORTRAIT);

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

/**
 * The portrait with this exact name, if the pack holds one.
 *
 * Trimmed and lower-cased, because neither surrounding space nor the case
 * somebody typed is part of who they are — the pack's files are lower-case and
 * the name in the roster is whatever was entered.
 */
export function portraitNamed(name: string | undefined): string | undefined {
  const key = (name ?? '').trim().toLowerCase();
  if (!key) return undefined;
  const i = PORTRAIT_NAMES.indexOf(key);
  return i === -1 ? undefined : PORTRAIT_FILES[i];
}

/** The portrait for one assistant, from the shipped pack. */
export function portraitFor(
  agent: { id: string; name: string; role?: string; isGod?: boolean }
): string | undefined {
  if (agent.isGod) return portraitNamed(GOD_PORTRAIT) ?? assignPortrait(agent.id, DEALABLE);
  return portraitNamed(agent.name) ?? assignPortrait(agent.id, DEALABLE);
}
