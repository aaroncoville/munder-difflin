/**
 * Where a Claude seat's generated settings file lives.
 *
 * The app passes each Claude seat one settings file with --settings. That file decides the seat's hooks (which run
 * outside its sandbox), its MCP servers and its sandbox roots, so whoever can write it controls the seat. Every agent
 * can write the hive, so the file is never kept there: it is written to a private folder of the app's own
 * (<userData>/seat-settings), registered as one no agent may reach, as <digest>.json.
 *
 * The digest is sha256 of the hive root's real path, a NUL, and the agent id. It is derived from those two values
 * only, never from anything read under the hive, so nothing a seat writes can choose or redirect the file. The file is
 * written from the JSON the app holds in memory, through an exclusive temporary file renamed into place, never through
 * a link. A link or anything other than a regular file at the target refuses the spawn, as does a folder that is not
 * set or not private: there is no fallback into the hive.
 */
import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { ensurePrivateDir, writeNoFollow } from './hookRuntime';

/** A Claude spawn refused because its settings file cannot be kept where no agent can write it. */
export class SeatSettingsRefused extends Error {
  constructor(reason: string) {
    super(`Seat settings unavailable: ${reason}. Claude agents cannot start until it is fixed.`);
    this.name = 'SeatSettingsRefused';
  }
}

/** The file name's digest: sha256 of the hive root's real path, NUL, and the agent id, in hex. */
export function seatSettingsDigest(hiveRoot: string, agentId: string): string {
  let real: string;
  try { real = realpathSync(hiveRoot); } catch (e) { throw new SeatSettingsRefused(`the hive folder ${hiveRoot} could not be resolved (${(e as Error).message})`); }
  return createHash('sha256').update(`${real}\0${agentId}`).digest('hex');
}

/** The seat's settings file in `dir`; refuses when no folder is set. */
export function seatSettingsFile(dir: string | null, hiveRoot: string, agentId: string): string {
  if (!dir) throw new SeatSettingsRefused('no seat settings folder is set, and the file is never written into the hive');
  return join(dir, `${seatSettingsDigest(hiveRoot, agentId)}.json`);
}

/** Refuses unless the target is absent or a regular file (never a link, a folder or a pipe). */
export function checkSeatSettingsTarget(file: string): void {
  let st;
  try { st = lstatSync(file); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new SeatSettingsRefused(`${file} could not be checked (${(e as Error).message})`);
  }
  if (st.isSymbolicLink()) throw new SeatSettingsRefused(`${file} is a link`);
  if (!st.isFile()) throw new SeatSettingsRefused(`${file} is not a regular file`);
}

/** Make the folder private, check the target, and write `content` there without following a link. Returns the path. */
export function writeSeatSettings(dir: string | null, hiveRoot: string, agentId: string, content: string): string {
  const file = seatSettingsFile(dir, hiveRoot, agentId);
  const folder = dir as string;
  try { ensurePrivateDir(folder, hiveRoot); } catch (e) { throw new SeatSettingsRefused(`the seat settings folder ${folder}: ${(e as Error).message}`); }
  checkSeatSettingsTarget(file);
  const name = file.slice(folder.length).replace(/^[\\/]+/, '');
  try { writeNoFollow(folder, { name, content, mode: 0o600 }); } catch (e) { throw new SeatSettingsRefused(`${file} could not be written (${(e as Error).message})`); }
  return file;
}
