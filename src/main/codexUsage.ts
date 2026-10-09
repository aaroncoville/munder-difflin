import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { estimateCostUsd } from './pricing';

/**
 * A Codex session's token totals, read from its rollout.
 *
 * Codex appends an `event_msg` of type `token_count` to the rollout after every
 * model call, carrying `info.total_token_usage`: running totals for the Codex
 * PROCESS, not the session. A resumed session starts them again from zero in
 * the same rollout, and a status update can repeat the previous totals
 * unchanged. So the session's usage is every rise in those totals, with a
 * restart's new totals all new usage. A restart shows as any counter dropping,
 * or as an event whose per-call `last_token_usage` equals its totals: the first
 * call of a fresh counter, which can outgrow the last process's whole run.
 * Summing each event's per-call usage instead would bill every repeated event
 * twice.
 *
 * `input_tokens` INCLUDES `cached_input_tokens` (OpenAI's convention), so the
 * uncached input is the difference.
 */
export interface CodexTotals {
  /** Uncached input tokens. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  /** The model of the latest turn that has totals. */
  model: string;
  /** Each rise priced at the model of the turn it was billed on, so switching
   *  models mid-session does not reprice what came before. */
  usd: number;
  /** When the rollout last changed. Codex appends tool output and messages
   *  between token counts, so this is when the session was last active, the
   *  same reading the Codex activity readers take. */
  ts: number;
}

interface Usage { input: number; cached: number; cacheWrite: number; output: number }

interface FileState {
  /** Bytes consumed so far, always at a line boundary. */
  offset: number;
  /** The previous event's running totals, to tell a rise from a restart. */
  previous: Usage | null;
  sum: Usage;
  usd: number;
  model: string;
  turnModel: string;
}

/** Read in slices so a first read of a several-hundred-MB rollout never holds it
 *  all in memory at once. */
const CHUNK = 4 * 1024 * 1024;

const ZERO: Usage = { input: 0, cached: 0, cacheWrite: 0, output: 0 };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Reads each rollout once, then only what Codex has appended since. A long-lived
 * session's rollout runs to hundreds of MB and the usage beat asks every ~30 s,
 * so after the first read a beat costs only the new lines.
 */
export class CodexUsageReader {
  private readonly files = new Map<string, FileState>();

  /** The session's totals so far, or null when the rollout holds none yet (or cannot be read). */
  read(file: string): CodexTotals | null {
    let fd: number;
    try { fd = openSync(file, 'r'); } catch { return null; }
    try {
      const { size, mtimeMs } = fstatSync(fd);
      let state = this.files.get(file);
      // A shorter file is a different file under the same name: start over.
      if (!state || size < state.offset) {
        state = { offset: 0, previous: null, sum: { ...ZERO }, usd: 0, model: '', turnModel: '' };
        this.files.set(file, state);
      }
      let carry = '';
      while (state.offset + Buffer.byteLength(carry) < size) {
        const at = state.offset + Buffer.byteLength(carry);
        const length = Math.min(CHUNK, size - at);
        const buf = Buffer.alloc(length);
        readSync(fd, buf, 0, length, at);
        const lines = (carry + buf.toString('utf8')).split('\n');
        // The last piece has no newline yet: Codex may still be writing it.
        carry = lines.pop() ?? '';
        for (const text of lines) {
          this.consume(state, text);
          state.offset += Buffer.byteLength(text) + 1;
        }
      }
      if (!state.previous) return null;
      return {
        input: Math.max(0, state.sum.input - state.sum.cached),
        cachedInput: state.sum.cached,
        cacheWrite: state.sum.cacheWrite,
        output: state.sum.output,
        model: state.model,
        usd: state.usd,
        ts: mtimeMs
      };
    } catch {
      return null;
    } finally {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }

  private consume(state: FileState, text: string): void {
    if (text.includes('"turn_context"')) {
      const model = parse(text)?.payload?.model;
      if (typeof model === 'string' && model) state.turnModel = model;
      return;
    }
    if (!text.includes('"token_count"')) return;
    const event = parse(text);
    const info = event?.payload?.info;
    if (!info?.total_token_usage) return; // a rate-limit-only update carries no totals
    const now = usageOf(info.total_token_usage);
    const before = state.previous;
    state.previous = now;
    state.model = state.turnModel;
    // The same totals written again: nothing new, whatever else the event says.
    if (before && same(now, before)) return;
    const firstCall = !!info.last_token_usage && same(usageOf(info.last_token_usage), now);
    const restarted = !before || firstCall || KEYS.some((k) => now[k] < before[k]);
    const rise = { ...ZERO };
    for (const k of KEYS) {
      rise[k] = restarted ? now[k] : now[k] - before![k];
      state.sum[k] += rise[k];
    }
    state.usd += estimateCostUsd(state.turnModel, {
      inputTokens: Math.max(0, rise.input - rise.cached),
      cacheReadTokens: rise.cached,
      cacheWriteTokens: rise.cacheWrite,
      outputTokens: rise.output
    });
  }
}

const KEYS = Object.keys(ZERO) as (keyof Usage)[];

function usageOf(u: any): Usage {
  return {
    input: num(u.input_tokens),
    cached: num(u.cached_input_tokens),
    cacheWrite: num(u.cache_write_input_tokens),
    output: num(u.output_tokens)
  };
}

function same(a: Usage, b: Usage): boolean {
  return KEYS.every((k) => a[k] === b[k]);
}

function parse(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}
