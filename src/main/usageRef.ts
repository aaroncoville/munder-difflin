/**
 * Keyed digests for the usage log. A value an agent or sender chose (a
 * conversation name, a message id it picked) is written as usageRef(): rows can
 * still be grouped by it, but the text cannot be read back, and without this
 * install's secret it cannot be confirmed by guessing.
 *
 * The secret lives in the app's own data folder, never in the hive folder.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

const FILE = 'usage-ref-secret';
const HEX_KEY = /^[0-9a-f]{64}$/;

function readKey(path: string): Buffer | null {
  try {
    if (!lstatSync(path).isFile()) return null;
    const hex = readFileSync(path, 'utf8').trim();
    return HEX_KEY.test(hex) ? Buffer.from(hex, 'hex') : null;
  } catch { return null; }
}

/** Write the key to a temp file and rename it into place, so an interrupted
 *  write never leaves a partial secret behind. */
function storeKey(dir: string, path: string, key: Buffer): boolean {
  const tmp = join(dir, `.${FILE}-${process.pid}-${randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      // writeSync may write fewer bytes than asked; finish before the rename.
      const data = Buffer.from(key.toString('hex'), 'utf8');
      for (let off = 0; off < data.length;) {
        const n = writeSync(fd, data, off, data.length - off);
        if (n <= 0) throw new Error('secret write made no progress');
        off += n;
      }
    } finally { closeSync(fd); }
    renameSync(tmp, path);
    return true;
  } catch {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return false;
  }
}

/**
 * This install's 32-byte secret, created (0600) on first use. A file that is
 * there but unreadable, short or malformed is replaced once, and `onReset` is
 * called so the break in ref continuity can be recorded. If the secret cannot
 * be stored, a key for this run only is returned.
 */
export function loadUsageSecret(dir: string, onReset?: () => void): Buffer {
  const path = join(dir, FILE);
  const existing = readKey(path);
  if (existing) return existing;
  let present = false;
  try { lstatSync(path); present = true; } catch { /* first use */ }
  const key = randomBytes(32);
  if (!storeKey(dir, path, key)) return readKey(path) ?? key;
  if (present) onReset?.();
  return key;
}

/** The first 12 hex of HMAC-SHA-256(secret, value). */
export function usageRef(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12);
}
