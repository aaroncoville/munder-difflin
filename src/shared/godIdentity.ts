/** God's identity before anyone has customized it — the app's own default,
 *  not a magic string sprinkled at every spawn call site. */
export const DEFAULT_GOD_NAME = 'Librarian';

/** The longest name, in characters, that is shown or put into a prompt. */
export const GOD_NAME_MAX = 48;

/**
 * Resolve god's display name for a (re)spawn.
 *
 * `renameAgent()` (`store.ts`) persists a rename straight into `registry.json`
 * via `hive.ts`'s `renameAgent()` — but the god-spawn effect used to rebuild
 * god's agent object from scratch with `name: DEFAULT_GOD_NAME` hardcoded in
 * three places, so a custom name reverted to the default on every app restart
 * even though the registry still had it right. Reading the persisted name
 * back here (instead of hardcoding the default) is what keeps a rename from
 * reverting. Falls back to the default only when nothing has been persisted
 * yet — a fresh hive, or a registry not yet written this run.
 */
export function resolveGodName(persistedName: unknown): string {
  // The registry is a file on disk, so the saved name can be anything JSON
  // holds. It is spoken by the voice and written into prompts, so only text
  // counts, and it is reduced to one short line: control and format characters
  // (newlines, escapes, zero-width marks) become spaces and the length is capped.
  if (typeof persistedName !== 'string') return DEFAULT_GOD_NAME;
  const line = persistedName.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const capped = Array.from(line).slice(0, GOD_NAME_MAX).join('').trim();
  return capped ? capped : DEFAULT_GOD_NAME;
}

const own = (o: unknown, k: string): unknown =>
  o !== null && typeof o === 'object' && !Array.isArray(o) && Object.prototype.hasOwnProperty.call(o, k)
    ? (o as Record<string, unknown>)[k]
    : undefined;

/** God's display name from a parsed `registry.json`, read through the
 *  registry's own entries only: an id such as "constructor" must not resolve
 *  to something inherited from Object. Anything missing or malformed gives
 *  the default. */
export function godNameFromRegistry(registry: unknown): string {
  const agents = own(registry, 'agents');
  const godId = own(registry, 'godId');
  const id = typeof godId === 'string' && godId ? godId : 'god';
  return resolveGodName(own(own(agents, id), 'name'));
}
