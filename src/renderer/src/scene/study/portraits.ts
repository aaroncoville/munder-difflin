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
 * Reserved in both directions: the god always wears it, and it is held out of
 * both halves of every other assignment — the pool the hash deals from and the
 * names a worker may be matched against — so no worker ever ends up wearing the
 * face of the person running the House, by luck or by being named after it.
 */
export const GOD_PORTRAIT = 'fascination';

/** The pack minus the reserved faces — what an assistant other than the god may
 *  be dealt *or* named for. Both halves of the assignment go through this list,
 *  which is what makes the reservation hold: matching a name against the whole
 *  pack would hand the god's face to anybody who typed its name into the summon
 *  form, walking straight past the hash's exclusion. */
const DEALABLE = PORTRAIT_FILES.filter((_, i) => PORTRAIT_NAMES[i] !== GOD_PORTRAIT);

/** Their names, in step with `DEALABLE` — filtered by the same predicate, so
 *  index `i` of one is index `i` of the other. */
const DEALABLE_NAMES = PORTRAIT_NAMES.filter((n) => n !== GOD_PORTRAIT);

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
export function portraitNamed(
  name: string | undefined,
  names: readonly string[] = PORTRAIT_NAMES,
  files: readonly string[] = PORTRAIT_FILES
): string | undefined {
  const key = (name ?? '').trim().toLowerCase();
  if (!key) return undefined;
  const i = names.indexOf(key);
  return i === -1 ? undefined : files[i];
}

/**
 * A portrait's name, written the way a person's name is written.
 *
 * The pack is named in lower case because its files are, and a file name is
 * not a name: an assistant summoned from the wall of faces goes into the same
 * roster as one summoned from the pixel cast, where the names are Jim and
 * Michael. Only the first letter, because every face in the pack is one word.
 *
 * Display only. `portraitNamed` lower-cases what it is given before it looks,
 * so capitalising here cannot cost an assistant its face — including the ones
 * already on the floor, summoned in lower case before this existed.
 */
export function portraitLabel(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}

/** The portrait for one assistant, from the shipped pack. */
export function portraitFor(
  agent: { id: string; name: string; role?: string; isGod?: boolean }
): string | undefined {
  if (agent.isGod) return portraitNamed(GOD_PORTRAIT) ?? assignPortrait(agent.id, DEALABLE);
  // Searched against the dealable pack, not the whole one: an assistant named
  // for the reserved face falls through to the hash like any other stranger.
  return portraitNamed(agent.name, DEALABLE_NAMES, DEALABLE)
    ?? assignPortrait(agent.id, DEALABLE);
}
