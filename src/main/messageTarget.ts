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

export function isAppSender(id: string): boolean {
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
  return folderNames(agentsDir).includes(id);
}

function folderNames(agentsDir: string): string[] {
  try {
    return readdirSync(agentsDir);
  } catch {
    return [];
  }
}

/**
 * The roster id `to` means: itself, or the one entry it matches ignoring case and Unicode form. A near match counts
 * only when that entry's exact folder is the sole folder in `agentsDir` with its key: a disk can keep two folders the
 * key treats as one, and then `to` may name the other, so it must not be merged into this agent.
 */
export function rosterIdFor(agents: Record<string, unknown>, to: unknown, agentsDir: string): string | null {
  if (isRosterId(agents, to)) return to;
  if (!isFolderName(to) || isAppSender(to)) return null;
  const key = folderKey(to);
  const matches = Object.keys(agents).filter((id) => folderKey(id) === key && isRosterId(agents, id));
  if (matches.length !== 1) return null;
  const folders = folderNames(agentsDir).filter((name) => folderKey(name) === key);
  return folders.length === 1 && folders[0] === matches[0] ? matches[0] : null;
}

/** Whether `to` may go on to routing: a roster id, a name for god, `broadcast`, or one of the app's own senders. */
export function isKnownTarget(agents: Record<string, unknown>, to: unknown, agentsDir: string): to is string {
  if (typeof to !== 'string') return false;
  return to === 'broadcast' || GOD_NAMES.has(to) || isAppSender(to) || rosterIdFor(agents, to, agentsDir) !== null;
}

/**
 * Why an agent cannot have the id `id`, or null if it can. No agent can have a name the app uses, even one already on
 * `agents`, because restoring it would give it a workspace to act under that name. Otherwise an agent on `agents` keeps
 * its id, and a new one cannot take one that a disk ignoring case or form would make the same folder as another's.
 */
export function newRosterIdRefusal(agents: Record<string, unknown>, id: unknown, isGod = false): string | null {
  if (!isFolderName(id) || UNSTABLE_FOLDER_NAME.test(id)) return 'it cannot be a folder name';
  const key = folderKey(id);
  if (isAppSender(id) || key === 'broadcast' || key === 'human' || (key === 'god' && !isGod)) return 'that name is reserved';
  if (Object.prototype.hasOwnProperty.call(agents, id)) return null;
  const twin = Object.keys(agents).find((other) => folderKey(other) === key);
  return twin === undefined ? null : `an agent named ${shortTarget(twin)} already has that folder`;
}

/** Provisioning refused an agent id, which unlike other provisioning errors must stop the spawn. */
export class RefusedRosterId extends Error {}

/** A refused target as it may appear in a log row or a notice: one line, and short. */
export function shortTarget(to: unknown): string {
  return String(typeof to === 'string' ? JSON.stringify(to) : typeof to).slice(0, 64);
}
