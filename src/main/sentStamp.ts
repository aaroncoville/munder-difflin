import { randomBytes } from 'node:crypto';
import { closeSync, constants, lstatSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export type SentStamp = 'stamped' | 'refused' | 'failed';

/**
 * Replaces a routed message's copy under outbox/.sent with the message as it was routed.
 *
 * The router files the sender's own file as sent. Left as it is, that copy keeps the sender's
 * clock and any field the sender wrote that the router owns (from, hops), while the inbox copy
 * carries the routed values, and a reader that meets the archived copy first reports the sender's.
 * So the archive holds the same message the recipient got, with the sender's created_at kept as
 * client_created_at.
 *
 * The .sent folder belongs to the sending agent, so every name in it is treated as hostile: the
 * folder and the archived copy must be a real directory and a regular file (not links), and the
 * new copy is written to a temporary name nobody can predict, created exclusively without
 * following a link, then renamed over the copy. A rename replaces a link rather than writing
 * through it. Anything else is refused and the copy is left as it was.
 */
export function stampSentCopy(sentDir: string, name: string, routed: object): SentStamp {
  const target = join(sentDir, name);
  try {
    if (!lstatSync(sentDir).isDirectory() || !lstatSync(target).isFile()) return 'refused';
  } catch {
    return 'failed';
  }
  const tmp = join(sentDir, `.stamp-${randomBytes(12).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    writeSync(fd, JSON.stringify(routed, null, 2));
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, target);
    return 'stamped';
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    return 'failed';
  }
}
