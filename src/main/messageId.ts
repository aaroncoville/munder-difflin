import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

// Letters, digits, dot, underscore and hyphen, starting with a letter or digit: no separators, no
// traversal, nothing a directory listing would hide. 128 leaves room for ".json" and a temp suffix.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Names Windows reserves whatever their extension, so "con.json" cannot be created there.
const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
// Far more than colliding random ids can need; past it, something is wrong with the folder.
const MAX_ATTEMPTS = 100;
const CLAIMS = '.claims';
// Old enough that no publish can still be running.
const LEFTOVER_AGE_MS = 60 * 60_000;
const CLAIM_AGE_MS = 30 * 24 * 60 * 60_000;

/** Whether an agent-written message id may be used as an inbox file name. */
export function isSafeMessageId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id) && !RESERVED_ON_WINDOWS.test(id);
}

/** Makes `target` appear with `source`'s whole content. A hard link also fails if the name exists; a disk without hard
 *  links gets a rename, which is safe because the id is already reserved. */
function publishWhole(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw error;
    renameSync(source, target);
  }
}

/** Reserves `id` for this inbox for good. Returns false if it was already reserved. */
function reserve(inbox: string, id: string): boolean {
  mkdirSync(join(inbox, CLAIMS), { recursive: true });
  try {
    closeSync(openSync(join(inbox, CLAIMS, id), 'wx'));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Writes `msg` into `inbox` as `<id>.json` and returns the id used. It keeps `msg.id` if that is safe and unused;
 * otherwise it uses `mint()`. The stored id always names its own file.
 *
 * An id can be used once per inbox, however its messages move. Agents file mail with a plain move, which replaces any
 * twin in `.done` and which nothing here can make atomic, so the two folders cannot decide whether an id is free. A
 * claim under `inbox/.claims`, which agents have no reason to touch, decides that: it is made first, only a claimed id
 * is published, and it stays after the message moves. A crash in between only burns the id. The folders are still
 * checked, inbox first because that is the direction mail moves, for messages from before their claims or past pruning.
 */
export function publishMessage<T extends object>(inbox: string, msg: T & { id?: unknown }, mint: () => string): string {
  const temp = join(inbox, `.publish-${randomBytes(6).toString('hex')}.tmp`);
  let id = isSafeMessageId(msg.id) ? msg.id : mint();
  try {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++, id = mint()) {
      if (!reserve(inbox, id)) continue;
      const target = join(inbox, `${id}.json`);
      if (existsSync(target) || existsSync(join(inbox, '.done', `${id}.json`))) continue;
      writeFileSync(temp, JSON.stringify({ ...msg, id }, null, 2), 'utf8');
      try {
        publishWhole(temp, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
        throw error;
      }
      return id;
    }
  } finally {
    rmSync(temp, { force: true });
  }
  throw new Error('no free message id');
}

/** Removes what a stopped publish left, and claims past their use. The folders still protect a message whose claim went. */
export function sweepInboxLeftovers(inbox: string, now = Date.now()): void {
  const olderThan = (path: string, ms: number): boolean => {
    try { return now - statSync(path).mtimeMs > ms; } catch { return false; }
  };
  const has = (id: string): boolean => existsSync(join(inbox, `${id}.json`)) || existsSync(join(inbox, '.done', `${id}.json`));
  try {
    for (const name of readdirSync(inbox)) {
      if (/^\.publish-.*\.tmp$/.test(name) && olderThan(join(inbox, name), LEFTOVER_AGE_MS)) rmSync(join(inbox, name), { force: true });
    }
    for (const id of readdirSync(join(inbox, CLAIMS))) {
      const claim = join(inbox, CLAIMS, id);
      if (olderThan(claim, CLAIM_AGE_MS) || (!has(id) && olderThan(claim, LEFTOVER_AGE_MS))) rmSync(claim, { force: true });
    }
  } catch { /* no inbox or no claims yet */ }
}
