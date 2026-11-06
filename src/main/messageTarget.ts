/** The names routing resolves to god. */
const GOD_NAMES = new Set(['god', 'human']);
// The app's own message senders. None has an inbox, but agents reply to them, and routing surfaces such a reply to god.
const APP_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system', 'router', 'ephemeral-worker', 'webhook']);
// What cannot be part of one folder name. A roster is a file on disk, so being listed there is not enough. Ids are
// otherwise free-form: they can come from an agent's name, in any alphabet.
const NOT_A_FOLDER_NAME = /[/\\:\u0000-\u001f]|^\.\.?$|^\s*$/;
const MAX_ID_LENGTH = 200;

/** Whether `id` is an agent on `agents` whose id is safe to use as a folder name. */
export function isRosterId(agents: Record<string, unknown>, id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && !NOT_A_FOLDER_NAME.test(id)
    && Object.prototype.hasOwnProperty.call(agents, id);
}

/** Whether `to` may go on to routing: a roster id, a name for god, `broadcast`, or one of the app's own senders. */
export function isKnownTarget(agents: Record<string, unknown>, to: unknown): to is string {
  if (typeof to !== 'string') return false;
  return to === 'broadcast' || GOD_NAMES.has(to) || APP_SENDERS.has(to) || isRosterId(agents, to);
}

/** A refused target as it may appear in a log row or a notice: one line, and short. */
export function shortTarget(to: unknown): string {
  return String(typeof to === 'string' ? JSON.stringify(to) : typeof to).slice(0, 64);
}
