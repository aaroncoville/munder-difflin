/**
 * The merge-request pipeline's per-card transition log (spec 12.3 and 11).
 *
 * One file per card, one JSON object per line, opened for append and flushed per
 * line. Everything this store writes lives under its `authRoot`, in the app's own
 * data directory, which agents can read but not write. The log there is the only
 * source of truth. An export copy of each card's log is kept beside it, at
 * `<authRoot>/_export/<card>/log.jsonl`, for people and `hive-mr verify-log` to
 * read. It is never read back for a decision, only compared. (`_export` cannot be
 * a card id: card ids start with a letter or a digit.)
 *
 * Nothing is written under the hive folder. Agents can write there, and Node has
 * no `openat`: a write by path into a folder an agent can write can be redirected
 * by swapping a folder on the way for a link between any check and the open. No
 * number of checks closes that, so the store does not write there at all.
 *
 * What the chain proves. Each line carries `prev`, the sha256 of the line before it
 * exactly as written, so a line edited or removed in the middle breaks the chain
 * where it happened. The chain alone cannot see the newest lines removed or edited,
 * or a whole file rewritten by someone who knows the algorithm, so a head anchor
 * (`head.json`: the last line's seq and hash) is kept beside the log and checked on
 * every open and before every append. A new log gets a genesis anchor (seq 0) on
 * disk before its first line, so a missing anchor always means tampering.
 *
 * A crash can leave a torn last line, or a complete line whose anchor update did
 * not land. Neither is tampering: a torn tail is dropped and the repair logged when
 * the anchor points at the line before it; a complete line exactly one past the
 * anchor is kept, the first line included. That also means a single well-formed
 * line added while the app is closed is adopted, which needs write access to the
 * app's data directory, where the anchor could be rewritten as well; a transition
 * line is a record, not evidence on its own.
 */
import { randomBytes } from 'node:crypto';
import {
  appendFileSync, closeSync, constants, existsSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as {
  CARD_RE: RegExp;
  GENESIS: string;
  hashLine(text: string): string;
  verifyLogText(text: string, opts?: { card?: string }): { ok: true; count: number; last: string } | { ok: false; line: number; reason: string };
};

export type LogType = 'transition' | 'fact' | 'effect' | 'hold';

/** What a caller appends. The store adds `v`, `seq`, `at`, `card` and `prev`, and they override the caller's. */
export interface LogEntry {
  type: LogType;
  [field: string]: unknown;
}

export interface LogLine extends LogEntry {
  v: 1;
  seq: number;
  at: string;
  card: string;
  prev: string;
}

/** The authoritative log does not verify. The conductor treats this as TAMPER and stops the card. */
export class LogTamperError extends Error {
  constructor(readonly card: string, readonly line: number, readonly reason: string) {
    super(`pipeline log for ${card} fails at line ${line}: ${reason}`);
    this.name = 'LogTamperError';
  }
}

/** `behind`: the export copy is a whole-line prefix of the log (a crash between the two writes). */
export type MirrorStatus = 'same' | 'behind' | 'missing' | 'differs';

interface Anchor { seq: number; hash: string }

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

/** The folder under the store's root that holds the export copies. Not a valid card id. */
const EXPORT_DIR = '_export';

const headOf = (count: number, last: string): Anchor => (count === 0 ? { seq: 0, hash: core.GENESIS } : { seq: count, hash: last });
const sameAnchor = (a: Anchor | null | undefined, b: Anchor | null | undefined): boolean => !!a && !!b && a.seq === b.seq && a.hash === b.hash;

/** Makes a new or renamed entry in [dir] durable. Best effort where a folder cannot be opened (Windows). */
function fsyncDir(dir: string): void {
  let fd: number;
  try { fd = openSync(dir, constants.O_RDONLY); } catch { return; }
  try { fsyncSync(fd); } catch { /* not supported for folders here */ } finally { closeSync(fd); }
}

export class CardLog {
  readonly card: string;
  private readonly authDir: string;
  private readonly authFile: string;
  private readonly anchorFile: string;
  private readonly exportDir: string;
  private readonly exportFile: string;
  private readonly now: () => Date;
  private seq = 0;
  private last = core.GENESIS;

  /** [authRoot] must be in the app's data directory: the store writes nowhere else. */
  constructor(opts: { authRoot: string; card: string; now?: () => Date }) {
    if (!core.CARD_RE.test(opts.card)) throw new Error(`not a card id: ${JSON.stringify(opts.card).slice(0, 80)}`);
    this.card = opts.card;
    this.authDir = join(opts.authRoot, opts.card);
    this.authFile = join(this.authDir, 'log.jsonl');
    this.anchorFile = join(this.authDir, 'head.json');
    this.exportDir = join(opts.authRoot, EXPORT_DIR, opts.card);
    this.exportFile = join(this.exportDir, 'log.jsonl');
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.authDir, { recursive: true });
    this.open();
  }

  /**
   * Appends one line to the authoritative log, flushed to disk, moves the anchor,
   * then copies the line to the export.
   *
   * An error does not mean the line is absent. If the line reached disk and the
   * anchor update then failed (a full disk, say), this throws, the line stays, and
   * this writer refuses every further append. Reopen the log and read it before
   * deciding anything: retrying the same entry would record it twice.
   */
  append(entry: LogEntry): LogLine {
    if (!sameAnchor(this.readAnchor(), headOf(this.seq, this.last))) {
      throw new LogTamperError(this.card, this.seq + 1, 'the log moved under this writer (another writer, an edit, or an earlier failed append)');
    }
    const line: LogLine = { ...entry, v: 1, seq: this.seq + 1, at: this.now().toISOString(), card: this.card, prev: this.last };
    const text = JSON.stringify(line);
    const created = !existsSync(this.authFile);
    const fd = openSync(this.authFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      writeSync(fd, `${text}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (created) fsyncDir(this.authDir);
    this.seq = line.seq;
    this.last = core.hashLine(text);
    this.writeAnchor({ seq: this.seq, hash: this.last });
    this.mirrorAppend(`${text}\n`);
    return line;
  }

  /** Every line of the authoritative log, checked against the chain and the anchor on the way. */
  lines(): LogLine[] {
    const text = this.authText();
    this.check(text);
    return text === '' ? [] : text.slice(0, -1).split('\n').map((l) => JSON.parse(l) as LogLine);
  }

  /** How the export copy compares with the authoritative log. */
  mirrorStatus(): MirrorStatus {
    let mirror: string;
    try {
      mirror = readFileSync(this.exportFile, 'utf8');
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'differs';
    }
    const auth = this.authText();
    if (mirror === auth) return 'same';
    if (auth.startsWith(mirror) && (mirror === '' || mirror.endsWith('\n'))) return 'behind';
    return 'differs';
  }

  /** Rewrites the export copy from the authoritative log: written whole to a temp file, then renamed over it. */
  restoreMirror(): void {
    mkdirSync(this.exportDir, { recursive: true });
    const tmp = join(this.exportDir, `.log.jsonl.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
    try {
      writeSync(fd, this.authText());
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.exportFile);
  }

  // — the authoritative copy —

  /** Reads the log on opening: checks it against the anchor, and repairs what a crash leaves. */
  private open(): void {
    let text = this.authText();
    let anchor = this.readAnchor();
    if (text === '' && anchor === null) {
      // A new card: the genesis anchor is on disk before any line can be.
      this.writeAnchor(headOf(0, core.GENESIS));
      anchor = this.readAnchor();
    }
    // A torn last line: everything before it verifies and the anchor points at the line before it.
    if (text !== '' && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n') + 1;
      const prefix = text.slice(0, cut);
      const checked = core.verifyLogText(prefix, { card: this.card });
      if (!checked.ok || !sameAnchor(headOf(checked.count, checked.last), anchor)) {
        throw new LogTamperError(this.card, prefix.split('\n').length, 'the last line is incomplete and the head anchor does not point at the line before it');
      }
      const dropped = text.length - cut;
      const fd = openSync(this.authFile, constants.O_WRONLY);
      try { ftruncateSync(fd, Buffer.byteLength(prefix)); fsyncSync(fd); } finally { closeSync(fd); }
      text = prefix;
      this.adopt(text);
      this.append({ type: 'fact', fact: 'log-repaired', dropped_bytes: dropped });
      return;
    }
    this.check(text, true);
    this.adopt(text);
  }

  /** Throws unless [text] verifies and ends at the anchor. With [fixAnchor], a complete line one past the anchor is kept. */
  private check(text: string, fixAnchor = false): void {
    const checked = core.verifyLogText(text, { card: this.card });
    if (!checked.ok) throw new LogTamperError(this.card, checked.line, checked.reason);
    const anchor = this.readAnchor();
    const head = headOf(checked.count, checked.last);
    if (sameAnchor(head, anchor)) return;
    if (fixAnchor && anchor && head.seq === anchor.seq + 1) {
      const lines = text.slice(0, -1).split('\n');
      const before = lines.length >= 2 ? core.hashLine(lines[lines.length - 2]) : core.GENESIS;
      if (before === anchor.hash) { this.writeAnchor(head); return; }
    }
    throw new LogTamperError(this.card, checked.count, anchor === null
      ? 'the head anchor is missing'
      : `the log ends at line ${checked.count}, the head anchor at line ${anchor.seq}`);
  }

  private adopt(text: string): void {
    const checked = core.verifyLogText(text, { card: this.card });
    if (!checked.ok) throw new LogTamperError(this.card, checked.line, checked.reason);
    this.seq = checked.count;
    this.last = headOf(checked.count, checked.last).hash;
  }

  private readAnchor(): Anchor | null {
    if (!existsSync(this.anchorFile)) return null;
    try {
      const a = JSON.parse(readFileSync(this.anchorFile, 'utf8')) as Anchor;
      if (a.seq === 0 && a.hash === core.GENESIS) return { seq: 0, hash: core.GENESIS };
      if (Number.isInteger(a.seq) && a.seq > 0 && typeof a.hash === 'string') return { seq: a.seq, hash: a.hash };
    } catch { /* fall through */ }
    throw new LogTamperError(this.card, 0, 'the head anchor is not readable');
  }

  private writeAnchor(a: Anchor): void {
    const tmp = join(this.authDir, `.head.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(a)); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      renameSync(tmp, this.anchorFile);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    fsyncDir(this.authDir);
  }

  private authText(): string {
    return existsSync(this.authFile) ? readFileSync(this.authFile, 'utf8') : '';
  }

  // — the export copy —

  /** Appends to the export copy. A failure is left for the next check to report and a restore to repair. */
  private mirrorAppend(text: string): void {
    try {
      mkdirSync(this.exportDir, { recursive: true });
      appendFileSync(this.exportFile, text, { mode: 0o644 });
    } catch { /* reported by mirrorStatus */ }
  }
}
