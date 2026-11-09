import { renameSync, rmSync, writeFileSync } from 'node:fs';

/**
 * Gives a routed message's copy under outbox/.sent the time the router stamped on it.
 *
 * The router files the sender's own file as sent, so without this the archive keeps the sender's
 * clock while every inbox copy carries the router's, and a reader that meets the archived copy
 * first orders the message by a time that was never routed. Every other field stays as the sender
 * wrote it, and the sender's created_at is kept as client_created_at, as in the inbox copy.
 * The copy is replaced in one rename. Returns false, leaving the copy as it was, if it cannot be.
 */
export function stampSentCopy(path: string, sent: Record<string, unknown>, routedAt: string): boolean {
  const copy = { ...sent, created_at: routedAt, ...(typeof sent.created_at === 'string' ? { client_created_at: sent.created_at } : {}) };
  const tmp = `${path}.${process.pid}.stamp.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(copy, null, 2));
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
    return false;
  }
}
