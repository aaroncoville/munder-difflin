import { readdirSync } from 'node:fs';

/** The names routing resolves to god. */
const GOD_NAMES = new Set(['god', 'human']);
// The app's own message senders. None has an inbox, but agents reply to them, and routing surfaces such a reply to god.
const APP_SENDERS = new Set(['heartbeat', 'scheduler', 'breaker', 'system', 'router', 'ephemeral-worker', 'webhook']);
// What cannot be part of one folder name. A roster is a file on disk, so being listed there is not enough. Ids are
// otherwise free-form: they can come from an agent's name, in any alphabet.
const NOT_A_FOLDER_NAME = /[/\\:\u0000-\u001f]|^\.\.?$|^\s*$/;
const MAX_ID_LENGTH = 200;
// Further names a new agent cannot take, because Windows would change or refuse the folder.
const UNSTABLE_FOLDER_NAME = /[. ]$|^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** One spelling for every id a disk that ignores case or Unicode form would treat as the same folder. */
function folderKey(id: string): string {
  return id.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

function isAppSender(id: string): boolean {
  return APP_SENDERS.has(folderKey(id));
}

function isFolderName(id: unknown): id is string {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && !NOT_A_FOLDER_NAME.test(id);
}

/** Whether `id` is an agent on `agents` that can receive mail: safe as a folder name, and not one of the app's names. */
export function isRosterId(agents: Record<string, unknown>, id: unknown): id is string {
  return isFolderName(id) && !isAppSender(id) && Object.prototype.hasOwnProperty.call(agents, id);
}

/** Whether `id` is the exact name of an entry in `agentsDir`. A disk that ignores case or form would open a different agent's folder for a near match. */
export function hasExactFolder(agentsDir: string, id: string): boolean {
  try {
    return readdirSync(agentsDir).includes(id);
  } catch {
    return false;
  }
}

/** The roster id `to` means: itself, or the one entry it matches ignoring case and Unicode form. */
export function rosterIdFor(agents: Record<string, unknown>, to: unknown): string | null {
  if (isRosterId(agents, to)) return to;
  if (!isFolderName(to) || isAppSender(to)) return null;
  const key = folderKey(to);
  const matches = Object.keys(agents).filter((id) => folderKey(id) === key && isRosterId(agents, id));
  return matches.length === 1 ? matches[0] : null;
}

/** Whether `to` may go on to routing: a roster id, a name for god, `broadcast`, or one of the app's own senders. */
export function isKnownTarget(agents: Record<string, unknown>, to: unknown): to is string {
  if (typeof to !== 'string') return false;
  return to === 'broadcast' || GOD_NAMES.has(to) || isAppSender(to) || rosterIdFor(agents, to) !== null;
}

/**
 * Why a new agent cannot have the id `id`, or null if it can. An agent already on `agents` keeps its id. A new one
 * cannot take a name the app uses, or one that a disk ignoring case or form would make the same folder as another's.
 */
export function newRosterIdRefusal(agents: Record<string, unknown>, id: unknown, isGod = false): string | null {
  if (!isFolderName(id) || UNSTABLE_FOLDER_NAME.test(id)) return 'it cannot be a folder name';
  if (Object.prototype.hasOwnProperty.call(agents, id)) return null;
  const key = folderKey(id);
  if (isAppSender(id) || key === 'broadcast' || key === 'human' || (key === 'god' && !isGod)) return 'that name is reserved';
  const twin = Object.keys(agents).find((other) => folderKey(other) === key);
  return twin === undefined ? null : `an agent named ${JSON.stringify(twin)} already has that folder`;
}

/** A refused target as it may appear in a log row or a notice: one line, and short. */
export function shortTarget(to: unknown): string {
  return String(typeof to === 'string' ? JSON.stringify(to) : typeof to).slice(0, 64);
}
