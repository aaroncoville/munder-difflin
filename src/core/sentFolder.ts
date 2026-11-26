import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * Throws unless `folder` is a real directory. A link is refused even when it points to one: an
 * agent owns the folders the router files its messages into, and a link there would make the
 * router create files wherever it points.
 *
 * This is a check, not a lock: a folder swapped for a link between this check and the move that
 * follows is not caught. Closing that needs operations relative to an open directory handle,
 * which Node's fs does not offer. The window is between two back-to-back synchronous calls.
 */
export function assertRealFolder(folder: string): void {
  if (!lstatSync(folder).isDirectory()) {
    throw Object.assign(new Error('not a real folder'), { code: 'ENOTDIR' });
  }
}

/**
 * Makes sure `folder` is a real directory before messages are filed into it. Anything else there,
 * a link or a file, is renamed aside in the same parent (a rename moves the link itself, never
 * what it points to) and an empty folder made in its place, so the message is still filed and
 * nothing is lost. `setAside` is told the name it was moved to. A missing folder is left missing.
 * Never throws: if this fails, the move that follows refuses the folder.
 */
export function setAsideUnlessFolder(folder: string, setAside: (name: string) => void): void {
  try {
    if (lstatSync(folder).isDirectory()) return;
    const name = `${basename(folder)}.set-aside-${randomBytes(6).toString('hex')}`;
    renameSync(folder, join(dirname(folder), name));
    mkdirSync(folder);
    setAside(name);
  } catch { /* missing, or could not be set aside */ }
}
