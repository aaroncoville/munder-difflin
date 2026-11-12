/**
 * The merge-request pipeline's per-card transition log (spec 12.3 and 11).
 *
 * One file per card, one JSON object per line, opened for append and flushed per
 * line. The copy in the app's own data directory is the only source of truth:
 * agents cannot write there. A mirror under hive/pipeline/ is output for people and
 * agents to read. It is never read back for a decision, only compared, and since
 * agents can write under hive/, every write to it refuses to follow a link.
 *
 * What the chain proves. Each line carries `prev`, the sha256 of the line before it
 * exactly as written, so a line edited or removed in the middle breaks the chain
 * where it happened. The chain alone cannot see the newest lines removed or edited,
 * or a whole file rewritten by someone who knows the algorithm, so a head anchor
 * (`head.json`: the last line's seq and hash) is kept beside the log in app data
 * and checked on every open and before every append. The mirror has no anchor:
 * `hive-mr verify-log` on it proves the chain is whole, and the conductor's
 * comparison with the authoritative copy proves the rest.
 *
 * A crash can leave a torn last line, or a line whose anchor update did not land.
 * Neither is tampering: a torn tail is dropped and the repair logged when the anchor
 * points at the line before it; a complete line one past the anchor is kept.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeSync,
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

/** `behind`: the mirror is a whole-line prefix of the log (a crash between the two writes). */
export type MirrorStatus = 'same' | 'behind' | 'missing' | 'differs';

interface Anchor { seq: number; hash: string }

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

export class CardLog {
  readonly card: string;
  private readonly authDir: string;
  private readonly authFile: string;
  private readonly anchorFile: string;
  private readonly mirrorRoot: string;
  private readonly now: () => Date;
  private seq = 0;
  private last = core.GENESIS;

  constructor(opts: { authRoot: string; mirrorRoot: string; card: string; now?: () => Date }) {
    if (!core.CARD_RE.test(opts.card)) throw new Error(`not a card id: ${JSON.stringify(opts.card).slice(0, 80)}`);
    this.card = opts.card;
    this.authDir = join(opts.authRoot, opts.card);
    this.authFile = join(this.authDir, 'log.jsonl');
    this.anchorFile = join(this.authDir, 'head.json');
    this.mirrorRoot = opts.mirrorRoot;
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.authDir, { recursive: true });
    this.open();
  }

  /** Appends one line to the authoritative log, flushed to disk, moves the anchor, then mirrors it. */
  append(entry: LogEntry): LogLine {
    const anchor = this.readAnchor();
    const expected = this.seq === 0 ? null : { seq: this.seq, hash: this.last };
    if (JSON.stringify(anchor) !== JSON.stringify(expected)) {
      throw new LogTamperError(this.card, this.seq + 1, 'the log moved under this writer (another writer, or an edit)');
    }
    const line: LogLine = { ...entry, v: 1, seq: this.seq + 1, at: this.now().toISOString(), card: this.card, prev: this.last };
    const text = JSON.stringify(line);
    const fd = openSync(this.authFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    try {
      writeSync(fd, `${text}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
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

  /** How the mirror compares with the authoritative log. A link or non-file anywhere in its path reads `differs`. */
  mirrorStatus(): MirrorStatus {
    const dir = this.mirrorDir(false);
    if (dir === 'missing') return 'missing';
    if (dir === null) return 'differs';
    const file = join(dir, 'log.jsonl');
    let st;
    try { st = lstatSync(file); } catch { return 'missing'; }
    if (!st.isFile()) return 'differs';
    let mirror: string;
    try {
      const fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
      try { mirror = readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
    } catch {
      return 'differs';
    }
    const auth = this.authText();
    if (mirror === auth) return 'same';
    if (auth.startsWith(mirror) && (mirror === '' || mirror.endsWith('\n'))) return 'behind';
    return 'differs';
  }

  /**
   * Rewrites the mirror from the authoritative log: written whole to a fresh,
   * randomly named file opened exclusively without following links, then renamed
   * over the mirror (which replaces a planted link rather than writing through it).
   * Does nothing when a folder on the way is not a real folder.
   */
  restoreMirror(): void {
    const dir = this.mirrorDir(true);
    if (typeof dir !== 'string') return;
    const tmp = join(dir, `.log.jsonl.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o644);
    try {
      writeSync(fd, this.authText());
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (this.mirrorDir(false) !== dir) { rmSync(tmp, { force: true }); return; }
    renameSync(tmp, join(dir, 'log.jsonl'));
  }

  // — the authoritative copy —

  /** Reads the log on opening: checks it against the anchor, and repairs what a crash leaves. */
  private open(): void {
    let text = this.authText();
    const anchor = this.readAnchor();
    // A torn last line: everything before it verifies and the anchor points at the line before it.
    if (text !== '' && !text.endsWith('\n')) {
      const cut = text.lastIndexOf('\n') + 1;
      const prefix = text.slice(0, cut);
      const checked = core.verifyLogText(prefix, { card: this.card });
      const at = checked.ok ? (checked.count === 0 ? null : { seq: checked.count, hash: checked.last }) : undefined;
      if (!checked.ok || JSON.stringify(at) !== JSON.stringify(anchor)) {
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
    const head = checked.count === 0 ? null : { seq: checked.count, hash: checked.last };
    if (JSON.stringify(head) === JSON.stringify(anchor)) return;
    if (fixAnchor && head && anchor && head.seq === anchor.seq + 1) {
      const lines = text.slice(0, -1).split('\n');
      if (core.hashLine(lines[lines.length - 2]) === anchor.hash) { this.writeAnchor(head); return; }
    }
    throw new LogTamperError(this.card, checked.count, anchor === null
      ? 'the head anchor is missing'
      : `the log ends at line ${checked.count}, the head anchor at line ${anchor.seq}`);
  }

  private adopt(text: string): void {
    const checked = core.verifyLogText(text, { card: this.card });
    if (!checked.ok) throw new LogTamperError(this.card, checked.line, checked.reason);
    this.seq = checked.count;
    this.last = checked.count === 0 ? core.GENESIS : checked.last;
  }

  private readAnchor(): Anchor | null {
    if (!existsSync(this.anchorFile)) return null;
    try {
      const a = JSON.parse(readFileSync(this.anchorFile, 'utf8')) as Anchor;
      if (Number.isInteger(a.seq) && a.seq > 0 && typeof a.hash === 'string') return { seq: a.seq, hash: a.hash };
    } catch { /* fall through */ }
    throw new LogTamperError(this.card, 0, 'the head anchor is not readable');
  }

  private writeAnchor(a: Anchor): void {
    const tmp = join(this.authDir, `.head.${randomBytes(8).toString('hex')}.tmp`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
    try { writeSync(fd, JSON.stringify(a)); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, this.anchorFile);
  }

  private authText(): string {
    return existsSync(this.authFile) ? readFileSync(this.authFile, 'utf8') : '';
  }

  // — the mirror —

  /**
   * The card's mirror folder, only if the mirror root and the card folder are real
   * folders (not links). With [create], missing ones are made, one level at a time.
   * 'missing' when they do not exist and were not to be made; null when unsafe.
   */
  private mirrorDir(create: boolean): string | null | 'missing' {
    const cardDir = join(this.mirrorRoot, this.card);
    for (const [dir, parentOk] of [[this.mirrorRoot, true], [cardDir, false]] as const) {
      let st;
      try { st = lstatSync(dir); } catch {
        if (!create) return 'missing';
        try { mkdirSync(dir, { recursive: parentOk }); st = lstatSync(dir); } catch { return null; }
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return null;
    }
    return cardDir;
  }

  /** Appends to the mirror without following a link; a planted link or non-file is left alone. */
  private mirrorAppend(text: string): void {
    const dir = this.mirrorDir(true);
    if (typeof dir !== 'string') return;
    let fd: number;
    try {
      fd = openSync(join(dir, 'log.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW, 0o644);
    } catch {
      return; // a link (ELOOP) or anything else: the mirror check reports it and a restore replaces it
    }
    try {
      if (fstatSync(fd).isFile()) writeSync(fd, text);
    } catch { /* the next mirror check restores it */ } finally {
      closeSync(fd);
    }
  }
}
