/**
 * Keyed digests for the usage log. A value an agent or sender chose (a
 * conversation name, a message id it picked) is written as usageRef(): rows can
 * still be grouped by it, but the text cannot be read back, and without this
 * install's secret it cannot be confirmed by guessing.
 *
 * The secret lives in the app's own data folder, never in the hive folder.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs';
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

/** This install's secret, created (0600) on first use. If it cannot be stored,
 *  a key for this run only is returned, so refs are then stable within a run. */
export function loadUsageSecret(dir: string): Buffer {
  const path = join(dir, FILE);
  const existing = readKey(path);
  if (existing) return existing;
  const key = randomBytes(32);
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(path, 'wx', 0o600);
    try { writeSync(fd, key.toString('hex')); } finally { closeSync(fd); }
    return key;
  } catch {
    return readKey(path) ?? key;
  }
}

/** The first 12 hex of HMAC-SHA-256(secret, value). */
export function usageRef(secret: Buffer, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12);
}
