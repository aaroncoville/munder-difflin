/**
 * The merge-request pipeline's per-card transition log (spec 12.3 and 11).
 *
 * One file per card, one JSON object per line, opened for append and flushed per
 * line, never rewritten. The authoritative copy lives in the app's own data
 * directory, where agents cannot write. A mirror under hive/pipeline/ is there for
 * people and agents to read; it is compared with the authoritative copy and never
 * trusted over it.
 *
 * Each line carries `prev`, the sha256 of the line before it exactly as written,
 * so an edited, removed or reordered line breaks the chain where it happened. The
 * chain check is shared with the agent-side `hive-mr verify-log` (mr-core.cjs).
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as {
  CARD_RE: RegExp;
  GENESIS: string;
  hashLine(text: string): string;
  verifyLogText(text: string): { ok: true; count: number; last?: string } | { ok: false; line: number; reason: string };
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

export type MirrorStatus = 'same' | 'missing' | 'differs';

export class CardLog {
  readonly card: string;
  private readonly authFile: string;
  private readonly mirrorFile: string;
  private readonly now: () => Date;
  private seq: number;
  private last: string;

  constructor(opts: { authRoot: string; mirrorRoot: string; card: string; now?: () => Date }) {
    if (!core.CARD_RE.test(opts.card)) throw new Error(`not a card id: ${JSON.stringify(opts.card).slice(0, 80)}`);
    this.card = opts.card;
    this.authFile = join(opts.authRoot, opts.card, 'log.jsonl');
    this.mirrorFile = join(opts.mirrorRoot, opts.card, 'log.jsonl');
    this.now = opts.now ?? (() => new Date());
    mkdirSync(join(opts.authRoot, opts.card), { recursive: true });
    const text = existsSync(this.authFile) ? readFileSync(this.authFile, 'utf8') : '';
    const checked = core.verifyLogText(text);
    if (!checked.ok) throw new LogTamperError(this.card, checked.line, checked.reason);
    this.seq = checked.count;
    this.last = checked.count === 0 ? core.GENESIS : (checked.last as string);
  }

  /** Appends one line to the authoritative log, flushed to disk, then to the mirror. */
  append(entry: LogEntry): LogLine {
    const line: LogLine = { ...entry, v: 1, seq: this.seq + 1, at: this.now().toISOString(), card: this.card, prev: this.last };
    const text = JSON.stringify(line);
    const fd = openSync(this.authFile, 'a');
    try {
      writeSync(fd, `${text}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.seq = line.seq;
    this.last = core.hashLine(text);
    // The mirror is for reading. Failing to write it never loses a line: the next
    // mirror check finds the difference and restores it from this copy.
    try {
      mkdirSync(join(this.mirrorFile, '..'), { recursive: true });
      const mfd = openSync(this.mirrorFile, 'a');
      try { writeSync(mfd, `${text}\n`); } finally { closeSync(mfd); }
    } catch { /* restored on the next check */ }
    return line;
  }

  /** Every line of the authoritative log, checked again on the way. */
  lines(): LogLine[] {
    const text = this.authText();
    const checked = core.verifyLogText(text);
    if (!checked.ok) throw new LogTamperError(this.card, checked.line, checked.reason);
    return text === '' ? [] : text.slice(0, -1).split('\n').map((l) => JSON.parse(l) as LogLine);
  }

  /** Whether the mirror still says exactly what the authoritative log says. */
  mirrorStatus(): MirrorStatus {
    if (!existsSync(this.mirrorFile)) return 'missing';
    return readFileSync(this.mirrorFile, 'utf8') === this.authText() ? 'same' : 'differs';
  }

  /** Rewrites the mirror from the authoritative log, whole, in one rename. */
  restoreMirror(): void {
    mkdirSync(join(this.mirrorFile, '..'), { recursive: true });
    const tmp = `${this.mirrorFile}.tmp`;
    writeFileSync(tmp, this.authText());
    renameSync(tmp, this.mirrorFile);
  }

  private authText(): string {
    return existsSync(this.authFile) ? readFileSync(this.authFile, 'utf8') : '';
  }
}
