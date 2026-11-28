/**
 * A random id for this installation, made once and kept in the app's data folder, so that a lock or a record can
 * say which machine wrote it whatever the host is called at the time. macOS renames a host when another machine on
 * the network has its name (Mac.local becomes Mac-2.local), so a host name alone cannot tell this machine from
 * another one that shares a folder with it.
 *
 * The file is `<app data folder>/machine-id`: 32 lowercase hex digits, a regular file owned by this user with no
 * access for anyone else. It is created exclusively (a new file written in full, then hard-linked into place), so
 * two processes starting at once settle on one id and no reader sees a half-written one. An id file that is not
 * like that (a link, another owner, group or other access, other content), or one that cannot be read or made,
 * gives no id: callers then judge as they did before there was one, and never guess.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { appDataDir } from './appDataDir';

export const MACHINE_ID_FILE = 'machine-id';
const ID = /^[0-9a-f]{32}$/;

/** Where this installation's id is kept. */
export function machineIdFile(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, home: string = homedir()): string {
  return join(appDataDir(platform, env, home), MACHINE_ID_FILE);
}

/** The id in `file`, or null if the file is missing or is not a private regular file holding one id. */
function readId(file: string): string | null {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return null;
    if (st.size > 64) return null;
    const id = readFileSync(fd, 'utf8').trim();
    return ID.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Reads the id in `file`, making it first if there is none yet. Null if it can be neither read nor made. The app
 *  calls this once as it starts; everything else only reads the id (machineId). */
export function ensureMachineId(file: string = machineIdFile()): string | null {
  const found = readId(file);
  if (found) return found;
  try { lstatSync(file); return null; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null; }
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${randomBytes(16).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    try { linkSync(tmp, file); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return null; }
  } catch {
    return null;
  } finally {
    try { unlinkSync(tmp); } catch { /* not made, or already gone */ }
  }
  // Whoever linked first, this one or another process, the file now holds the one id.
  return readId(file);
}

let known: { file: string; id: string } | null = null;

/** This installation's id (see the header), or null when there is none yet or it cannot be read. Never makes
 *  one. Kept once found; a missing one is looked for again on the next call. */
export function machineId(file: string = machineIdFile()): string | null {
  if (known && known.file === file) return known.id;
  const id = readId(file);
  if (id) known = { file, id };
  return id;
}
