import { closeSync, existsSync, linkSync, openSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

// Letters, digits, dot, underscore and hyphen, starting with a letter or digit: no separators, no
// traversal, nothing a directory listing would hide. 128 leaves room for ".json" and a temp suffix.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Names Windows reserves whatever their extension, so "con.json" cannot be created there.
const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
// Far more than colliding random ids can need; past it, something is wrong with the folder.
const MAX_ATTEMPTS = 100;

/** Whether an agent-written message id may be used as an inbox file name. */
export function isSafeMessageId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id) && !RESERVED_ON_WINDOWS.test(id);
}

/** Publishes without a hard link: a claim all publishers honour, then a rename, so the name only ever shows a whole file. */
function publishByClaim(source: string, target: string): void {
  const claim = join(dirname(target), `.${basename(target)}.claim`);
  closeSync(openSync(claim, 'wx'));
  try {
    if (existsSync(target)) throw Object.assign(new Error('name taken'), { code: 'EEXIST' });
    renameSync(source, target);
  } finally {
    rmSync(claim, { force: true });
  }
}

/** Makes `target` appear with `source`'s whole content, or throws EEXIST. A hard link does that atomically. */
function publishWithoutReplacing(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    publishByClaim(source, target);
  }
}

function inodeOf(path: string): bigint | null {
  try {
    return statSync(path, { bigint: true }).ino;
  } catch {
    return null;
  }
}

/**
 * Writes `msg` into `inbox` as `<id>.json` and returns the id used. It keeps `msg.id` if that is safe and free;
 * otherwise, or if the name is taken by the time it publishes, it uses `mint()`. Nothing in the inbox is ever replaced,
 * and the stored id always names its own file.
 *
 * An id must stay unique across `inbox` and `inbox/.done`, because filing a message there with a plain move replaces
 * any twin. A message can move to `.done` at any moment, so `.done` is checked after publishing: if publishing
 * succeeded, an earlier message of that name had already left the inbox, and is found there.
 */
export function publishMessage<T extends object>(inbox: string, msg: T & { id?: unknown }, mint: () => string): string {
  const filed = (id: string): string => join(inbox, '.done', `${id}.json`);
  let id = isSafeMessageId(msg.id) && !existsSync(filed(msg.id)) ? msg.id : mint();
  const temp = join(inbox, `.publish-${randomBytes(6).toString('hex')}.tmp`);
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      writeFileSync(temp, JSON.stringify({ ...msg, id }, null, 2), 'utf8');
      const own = inodeOf(temp);
      const target = join(inbox, `${id}.json`);
      try {
        publishWithoutReplacing(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        id = mint();
        continue;
      }
      const twin = inodeOf(filed(id));
      if (twin === null || twin === own) return id;
      // Another message holds this id in .done. Take ours back, unless the recipient has already filed it.
      if (inodeOf(target) === own) rmSync(target, { force: true });
      id = mint();
    }
  } finally {
    rmSync(temp, { force: true });
  }
  throw new Error('no free message id');
}
