/**
 * What the Hindsight miner has handed to one server and bank, and the one retain
 * it may have in flight there.
 *
 * The file lives in a folder of the app's own (userData), never in the hive that
 * every agent can write: a stored document id is sent back to the server as is,
 * and a forged one would overwrite another document. The folder must be a real
 * folder owned by this user with mode 0700, as the hook runtime's is.
 * Reads and writes are async and bounded, writes go to an unpredictable temp file
 * opened without following links and are then renamed over the ledger, and a
 * ledger that fails any check is treated as empty rather than trusted.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

/** Big enough for ~20k sections; anything larger is refused, not parsed. */
export const LEDGER_MAX_BYTES = 4 * 1024 * 1024;
export const LEDGER_MAX_SECTIONS = 20_000;
export const CLAIM_MAX_ITEMS = 8;

export interface RetainedSection { id: string; hash: string }
/** One section as it was sent, so the same request can be sent again word for word. */
export interface ClaimItem extends RetainedSection { key: string; agent: string; heading: string; content: string }
export interface RetainClaim {
  /** Client-chosen operation id: re-sending it to Hindsight creates no new work. */
  op: string;
  since: number;
  items: ClaimItem[];
  /** The server answered the POST, so it registered the operation. */
  acked: boolean;
  /** The operation's last reported `status|updated_at`. */
  seen: string;
  /** How long the server has answered without the operation moving. Only time between
   *  answered polls counts, so an outage or a sleeping app does not run this clock. */
  idle: number;
  /** When a poll was last answered (any HTTP response). */
  answeredAt: number;
}
export interface LedgerState {
  v: 1;
  /** `url\nbank` this ledger belongs to; a ledger for any other pair is not used. */
  server: string;
  /** No new retain may start before this time. */
  busyUntil: number;
  /** `agent\nheading\noccurrence` → the id the section is retained under and a hash of the text the server confirmed. */
  sections: Record<string, RetainedSection>;
  claim: RetainClaim | null;
  /** A claim set aside because the settings moved to another server while this one
   *  stopped answering. Nothing from it is recorded; if this server is configured
   *  again, it is settled like an open claim before anything is resent. */
  aside: { claim: RetainClaim; reason: string; at: number } | null;
}

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The longest section key (`agent\nheading\noccurrence`) a ledger may hold. */
export const MAX_KEY_LENGTH = 1024;
/** The longest section text a claim may carry; the miner leaves longer sections out. */
export const CLAIM_ITEM_MAX_CHARS = 256 * 1024;
const MAX_SEEN_LENGTH = 256;
const MAX_REASON_LENGTH = 512;

export const emptyLedger = (server: string): LedgerState => ({ v: 1, server, busyUntil: 0, sections: {}, claim: null, aside: null });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const hasOnly = (v: Record<string, unknown>, keys: string[]): boolean => Object.keys(v).every((k) => keys.includes(k));
const isSection = (v: unknown): v is RetainedSection =>
  isRecord(v) && hasOnly(v, ['id', 'hash']) && typeof v.id === 'string' && HEX32.test(v.id) && typeof v.hash === 'string' && HEX64.test(v.hash);
const isKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && k.length <= MAX_KEY_LENGTH;
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The parsed ledger if every field checks out for this server, else a reason it was refused. */
export function parseLedger(text: string, server: string): LedgerState | string {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return 'it is not JSON'; }
  if (!isRecord(raw) || !hasOnly(raw, ['v', 'server', 'busyUntil', 'sections', 'claim', 'aside'])) return 'its shape is wrong';
  if (!('aside' in raw)) raw.aside = null;
  if (raw.v !== 1) return 'its version is unknown';
  if (raw.server !== server) return 'it belongs to another server or bank';
  if (!isTime(raw.busyUntil)) return 'busyUntil is not a time';
  if (!isRecord(raw.sections)) return 'sections is not an object';
  const entries = Object.entries(raw.sections);
  if (entries.length > LEDGER_MAX_SECTIONS) return 'it holds too many sections';
  for (const [k, s] of entries) if (!isKey(k) || !isSection(s)) return 'a section entry is malformed';
  const claim = raw.claim === null ? null : parseClaim(raw.claim);
  if (typeof claim === 'string') return claim;
  let aside: LedgerState['aside'] = null;
  if (raw.aside !== null) {
    const a = raw.aside;
    if (!isRecord(a) || !hasOnly(a, ['claim', 'reason', 'at']) || typeof a.reason !== 'string' || a.reason.length > MAX_REASON_LENGTH || !isTime(a.at)) return 'the set-aside claim is malformed';
    const c = parseClaim(a.claim);
    if (typeof c === 'string') return `the set-aside claim: ${c}`;
    aside = { claim: c, reason: a.reason, at: a.at };
  }
  return { v: 1, server, busyUntil: raw.busyUntil, sections: raw.sections as Record<string, RetainedSection>, claim, aside };
}

/** A claim if every field checks out, else why not. */
function parseClaim(c: unknown): RetainClaim | string {
  if (!isRecord(c) || !hasOnly(c, ['op', 'since', 'items', 'acked', 'seen', 'idle', 'answeredAt'])) return 'the claim is malformed';
  if (typeof c.op !== 'string' || !UUID.test(c.op) || !isTime(c.since) || !isTime(c.idle) || !isTime(c.answeredAt)) return 'the claim is malformed';
  if (typeof c.acked !== 'boolean' || typeof c.seen !== 'string' || c.seen.length > MAX_SEEN_LENGTH) return 'the claim is malformed';
  if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > CLAIM_MAX_ITEMS) return 'the claim is malformed';
  for (const it of c.items) {
    if (!isRecord(it) || !hasOnly(it, ['key', 'id', 'hash', 'agent', 'heading', 'content'])) return 'a claim item is malformed';
    if (!isKey(it.key) || !isSection({ id: it.id, hash: it.hash })) return 'a claim item is malformed';
    if (typeof it.agent !== 'string' || typeof it.heading !== 'string' || typeof it.content !== 'string') return 'a claim item is malformed';
    if (!it.key.startsWith(`${it.agent}\n${it.heading}\n`) || it.content.length > CLAIM_ITEM_MAX_CHARS) return 'a claim item is malformed';
    // The text must be the text the hash names, or a resend would carry something else.
    if (createHash('sha256').update(it.content).digest('hex') !== it.hash) return 'a claim item does not match its hash';
  }
  return { op: c.op, since: c.since, items: c.items as ClaimItem[], acked: c.acked, seen: c.seen, idle: c.idle, answeredAt: c.answeredAt };
}

export class RetainLedger {
  private warned = new Set<string>();

  constructor(private dir: string) {}

  private warnOnce(why: string): void {
    if (this.warned.has(why)) return;
    this.warned.add(why);
    console.error(`[memory] hindsight retain ledger: ${why}`);
  }

  private file(server: string): string {
    return join(this.dir, `retained-${createHash('sha256').update(server).digest('hex').slice(0, 24)}.json`);
  }

  /** The folder, made if missing, or null when it is a link, not a folder, or someone else's. */
  private async folder(): Promise<string | null> {
    if (!isAbsolute(this.dir)) { this.warnOnce(`its folder ${this.dir} is not an absolute path`); return null; }
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const st = await lstat(this.dir);
      if (st.isSymbolicLink() || !st.isDirectory()) { this.warnOnce(`its folder ${this.dir} is a link or not a folder`); return null; }
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) { this.warnOnce(`its folder ${this.dir} belongs to another user`); return null; }
      if ((st.mode & 0o077) !== 0) await chmod(this.dir, 0o700);
      return this.dir;
    } catch (e) {
      this.warnOnce(`its folder ${this.dir} is unusable (${(e as Error).message})`);
      return null;
    }
  }

  /** The ledger for this server, or an empty one when there is none or it was refused (logged once). */
  async load(server: string): Promise<LedgerState> {
    if (!(await this.folder())) return emptyLedger(server);
    return (await this.read(this.file(server), server)) ?? emptyLedger(server);
  }

  /**
   * Every ledger in the folder that has a retain open, whatever server it belongs to.
   * A ledger counts only if it parses and its file name is the one its own server
   * would get, so a file copied under another name is not taken for another server's.
   */
  async openClaims(): Promise<LedgerState[]> {
    if (!(await this.folder())) return [];
    let names: string[];
    try { names = await readdir(this.dir); } catch { return []; }
    const open: LedgerState[] = [];
    for (const name of names.filter((n) => /^retained-[0-9a-f]{24}\.json$/.test(n)).slice(0, 64)) {
      const state = await this.read(join(this.dir, name), null);
      if (state?.claim && this.file(state.server) === join(this.dir, name)) open.push(state);
    }
    return open;
  }

  /** One ledger file, checked for `server` (or for the server it names itself, when null); null when absent or refused. */
  private async read(path: string, server: string | null): Promise<LedgerState | null> {
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') this.warnOnce(`${path} was refused (${code === 'ELOOP' ? 'it is a link' : (e as Error).message}); starting empty`);
      return null;
    }
    try {
      const st = await handle.stat();
      if (!st.isFile()) { this.warnOnce(`${path} is not a file; starting empty`); return null; }
      if (st.size > LEDGER_MAX_BYTES) { this.warnOnce(`${path} is over ${LEDGER_MAX_BYTES} bytes; starting empty`); return null; }
      const text = await handle.readFile('utf8');
      let owner = server;
      if (owner === null) {
        try { const raw = JSON.parse(text) as { server?: unknown }; owner = typeof raw?.server === 'string' ? raw.server : null; } catch { owner = null; }
        if (owner === null) { this.warnOnce(`${path} names no server; ignored`); return null; }
      }
      const parsed = parseLedger(text, owner);
      if (typeof parsed === 'string') { this.warnOnce(`${path} was refused (${parsed}); starting empty`); return null; }
      return parsed;
    } catch (e) {
      this.warnOnce(`${path} could not be read (${(e as Error).message}); starting empty`);
      return null;
    } finally {
      await handle.close();
    }
  }

  /** Durably replace the ledger. False means nothing was committed, and the caller must not act as if it was. */
  async save(state: LedgerState): Promise<boolean> {
    if (!(await this.folder())) return false;
    const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > LEDGER_MAX_BYTES) { this.warnOnce(`the ledger would exceed ${LEDGER_MAX_BYTES} bytes; not saved`); return false; }
    // Never write what load would refuse: a refused ledger reads as empty, which would
    // free a claim the server may still be working on. The previous file stays.
    const refused = parseLedger(text, state.server);
    if (typeof refused === 'string') { console.error(`[memory] hindsight retain ledger not saved: ${refused}`); return false; }
    const path = this.file(state.server);
    const temp = join(this.dir, `.${randomUUID()}.tmp`);
    try {
      const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(text, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      const target = await lstat(path).catch(() => null);
      if (target && !target.isFile()) throw new Error('the ledger path is a link or not a file');
      await rename(temp, path);
      return true;
    } catch (e) {
      console.error(`[memory] hindsight retain ledger not saved: ${(e as Error).message}`);
      await unlink(temp).catch(() => undefined);
      return false;
    }
  }
}
