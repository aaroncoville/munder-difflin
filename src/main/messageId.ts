import { copyFileSync, constants, existsSync, linkSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

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

/**
 * Makes `target` appear with `source`'s content, or throws EEXIST if `target` exists. A hard link does that atomically
 * with the whole content in place. A disk without hard links gets an exclusive copy, which is equally safe from
 * overwriting but can be seen part-written, and readers already skip a file they cannot parse.
 */
function publishWithoutReplacing(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    copyFileSync(source, target, constants.COPYFILE_EXCL);
  }
}

/**
 * Writes `msg` into `inbox` as `<id>.json` and returns the id used. It keeps `msg.id` if that is safe and names no message
 * in `inbox` or `inbox/.done`; otherwise, or if the name is taken by the time it publishes, it uses `mint()`. Nothing
 * already in the inbox is ever replaced, and the stored id always names its own file.
 */
export function publishMessage<T extends object>(inbox: string, msg: T & { id?: unknown }, mint: () => string): string {
  const unused = (id: string): boolean => !existsSync(join(inbox, '.done', `${id}.json`));
  let id = isSafeMessageId(msg.id) && unused(msg.id) ? msg.id : mint();
  const temp = join(inbox, `.publish-${randomBytes(6).toString('hex')}.tmp`);
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      writeFileSync(temp, JSON.stringify({ ...msg, id }, null, 2), { encoding: 'utf8', flag: 'w' });
      try {
        publishWithoutReplacing(temp, join(inbox, `${id}.json`));
        return id;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        id = mint();
      }
    }
  } finally {
    rmSync(temp, { force: true });
  }
  throw new Error('no free message id');
}
