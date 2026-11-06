import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Letters, digits, dot, underscore and hyphen, starting with a letter or digit: no separators, no
// traversal, nothing a directory listing would hide. 128 leaves room for ".json" and a temp suffix.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// Names Windows reserves whatever their extension, so "con.json" cannot be created there.
const RESERVED_ON_WINDOWS = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;

/** Whether an agent-written message id may be used as an inbox file name. */
export function isSafeMessageId(id: unknown): id is string {
  return typeof id === 'string' && SAFE_ID.test(id) && !RESERVED_ON_WINDOWS.test(id);
}

/** `id` if it is safe and names no message in `inbox` or `inbox/.done`, so nothing is overwritten; otherwise `mint()`. */
export function unusedMessageId(id: unknown, inbox: string, mint: () => string): string {
  if (!isSafeMessageId(id)) return mint();
  const file = `${id}.json`;
  return existsSync(join(inbox, file)) || existsSync(join(inbox, '.done', file)) ? mint() : id;
}
