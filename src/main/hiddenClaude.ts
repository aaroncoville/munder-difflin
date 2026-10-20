import * as pty from 'node-pty';
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { resolveCommand, userShellPath } from './shellEnv';
import { buildPtyEnv } from './ptyEnv';
import { expandTilde } from './fs';
import { projectDir } from './transcript';
import { ensureKilled } from './procKill';

/**
 * Shared helper: run a HIDDEN interactive claude session (ephemeral PTY) and
 * return the assistant's final text response.
 *
 * "Hidden" means: not added to the PtyManager, not emitted to the renderer,
 * not visible in the agent list or OfficeFloor scene. Each call spawns its own
 * session and kills it after capture — no /clear needed, no context bleed.
 *
 * Uses an interactive PTY (not `claude -p`) so calls draw from the user's
 * normal interactive plan quota, not the Agent SDK credit that moves to a
 * separate claim-required pool from 2026-06-15.
 *
 * Session lifecycle:
 *   spawn → boot-quiet detect → bracketed-paste prompt + \r → idle-settle →
 *   transcript JSONL extract (last assistant text block) → kill
 */

/** ms of PTY silence that signals the TUI is ready for input (boot complete). */
const BOOT_QUIET_MS = 1500;

export interface HiddenClaudeOptions {
  /** Model to use (e.g. 'claude-haiku-4-5'). */
  model: string;
  /** Working directory for the claude session. */
  cwd: string;
  /** Base claude command/binary. Defaults to 'claude'. */
  command?: string;
  /** Tools the session is forbidden to use. Defaults to ['Edit','Write','NotebookEdit']. */
  disallowedTools?: string[];
  /** Directories added via --add-dir (for context gathering). */
  addDirs?: string[];
  /** Hard cap ms before forcing prompt send regardless of boot activity. Default 7000. */
  bootCapMs?: number;
  /** ms of PTY silence after the prompt that signals response is complete. Default 3500. */
  idleMs?: number;
  /** Total timeout ms. Default 180000. */
  timeoutMs?: number;
  /** Extra env merged over the resolved shell env (e.g. the shared MemPalace). */
  env?: Record<string, string>;
}

export interface HiddenClaudeResult {
  ok: boolean;
  /** The assistant's final text response (stripped of any TUI framing). */
  text?: string;
  error?: string;
}

/**
 * Does the raw PTY output look like the first-run workspace-trust dialog
 * ("Is this a project you created or one you trust? ... Yes, I trust this
 * folder")? The TUI positions this text with absolute-column cursor moves
 * (`\x1b[<n>G`) between words rather than spaces, so a plain substring match
 * against the raw bytes never fires — CSI sequences are stripped first, then
 * ALL whitespace, before the compacted text is checked. Exported for the
 * regression test; not meant for use outside this module. */
export function looksLikeTrustDialog(rawOutput: string): boolean {
  const stripped = rawOutput
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
  const compact = stripped.replace(/\s+/g, '').toLowerCase();
  return compact.includes('trustthisfolder');
}

/**
 * The transcript file a hidden session writes: `<project dir>/<session id>.jsonl`.
 * The session id is OURS (passed as `--session-id`), so the lookup is exact.
 * The previous "newest .jsonl in the project dir" scan could pick up a
 * DIFFERENT session running in the same cwd — the god agent runs in the
 * harness home, the very cwd the reflect loop uses — and hand its last reply
 * back as the hidden session's answer. Exported for the regression test. */
export function hiddenTranscriptPath(cwd: string, sessionId: string): string {
  return path.join(projectDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Extract the last assistant text block from the hidden session's own
 * transcript. Null when the file was never written or holds no assistant text.
 */
function extractLastAssistantText(cwd: string, sessionId: string): string | null {
  try {
    const file = hiddenTranscriptPath(cwd, sessionId);
    if (!existsSync(file)) return null;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue;
      let rec: { type?: unknown; message?: { content?: unknown[] } };
      try { rec = JSON.parse(trimmed); } catch { continue; }
      if (rec.type !== 'assistant') continue;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const block = content[j] as { type?: unknown; text?: unknown };
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          return block.text.trim();
        }
      }
    }
    return null;
  } catch { return null; }
}

export function runHiddenClaude(prompt: string, opts: HiddenClaudeOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    // Defense-in-depth: `~` is shell syntax, not a path Node understands.
    const cwd = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    if (!cwd || !existsSync(cwd)) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    opts = { ...opts, cwd };

    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
    const addDirs = (opts.addDirs ?? []).filter((d) => d && existsSync(d));

    // Our own session id pins the transcript file name (see hiddenTranscriptPath).
    const sessionId = randomUUID();
    const args: string[] = [
      '--model', opts.model,
      '--permission-mode', 'bypassPermissions',
      '--session-id', sessionId,
      '--disallowedTools', ...disallowed,
    ];
    for (const d of addDirs) { args.push('--add-dir', d); }

    const bootCapMs = opts.bootCapMs ?? 7000;
    const idleMs = opts.idleMs ?? 3500;
    const timeoutMs = opts.timeoutMs ?? 180_000;

    // Windows: node-pty's CreateProcess can't exec the npm `.cmd`/extensionless
    // `claude` shim directly (ERROR_BAD_EXE_FORMAT, error 193) — route non-.exe
    // targets through cmd.exe. A real claude.exe (WinGet) launches directly. (#22)
    const winWrap = process.platform === 'win32' && !/\.(exe|com)$/i.test(exe);
    const spawnFile = winWrap ? (process.env.ComSpec || 'cmd.exe') : exe;
    const spawnArgs = winWrap ? ['/c', exe, ...args] : args;
    let ptyProc: pty.IPty;
    try {
      ptyProc = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-color',
        cols: 220,
        rows: 50,
        cwd: opts.cwd,
        // The SAME layering agent PTYs get (ptyEnv.ts): the inherited env minus
        // the parent Claude session's identity markers, then PATH, then ours.
        // The app is routinely launched from inside a Claude Code terminal, and
        // a hidden session that inherits that session's CLAUDE_CODE_CHILD_SESSION
        // marker runs with transcript saving OFF — it answers the prompt (a full
        // model call, ~75 s for a memory condense) and writes nothing to disk, so
        // every capture ends in 'no assistant response found in transcript'.
        // That was the whole of god's six-in-a-row condense-abort run on
        // 2026-10-20; agent PTYs had been given this strip in 7049fac1, hidden
        // sessions never were.
        env: buildPtyEnv(process.env, userShellPath(), opts.env),
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let settled = false;
    let promptSent = false;
    // Accumulated for the workspace-trust-dialog check only — capped so a
    // long-running or chatty boot sequence can't grow this unbounded.
    let rawOutput = '';
    const RAW_OUTPUT_CAP = 8192;
    let bootTimer: NodeJS.Timeout | null = null;
    let idleTimer: NodeJS.Timeout | null = null;
    let bootMaxTimer: NodeJS.Timeout;
    let globalTimer: NodeJS.Timeout;

    // Hidden sessions are ephemeral CHECKS — nothing they spawn (MCP servers,
    // helpers) may outlive them. Kill politely, then sweep the process group so
    // every check releases its PIDs even if `claude` shrugs off the SIGHUP.
    const kill = () => {
      const pid = ptyProc.pid;
      try { ptyProc.kill(); } catch { /* noop */ }
      ensureKilled(pid);
    };

    const finish = (r: HiddenClaudeResult) => {
      if (settled) return;
      settled = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      clearTimeout(bootMaxTimer);
      clearTimeout(globalTimer);
      kill();
      resolve(r);
    };

    const captureAndFinish = () => {
      const text = extractLastAssistantText(opts.cwd, sessionId);
      if (text) { finish({ ok: true, text }); return; }
      // A cwd the CLI has never been trusted in blocks on the workspace-trust
      // dialog forever — it renders as ordinary boot output, so the boot-quiet
      // heuristic reads it as "ready" and sends the prompt into a menu that
      // doesn't consume pasted text, never producing a transcript. That is a
      // DIFFERENT failure from a genuine transient no-response race (retrying
      // hits the identical dialog and fails identically), so it gets its own,
      // actionable error instead of the generic one.
      // The generic message keeps its leading phrase (reflect.ts keys its
      // one-shot retry on it) and says which of the two shapes it was: a
      // transcript that was never written at all (transcript saving off, the
      // CLI never got past boot) or one with no assistant text in it (the
      // session died mid-turn). No path in it: the session id is fresh per
      // call, and reflect.ts counts identical failures by this text.
      const written = existsSync(hiddenTranscriptPath(opts.cwd, sessionId));
      const error = looksLikeTrustDialog(rawOutput)
        ? 'workspace trust dialog blocked the session (cwd is not a trusted Claude Code directory)'
        : `no assistant response found in transcript (${written ? 'transcript has no assistant text' : 'transcript file was never written'})`;
      finish({ ok: false, error });
    };

    const sendPrompt = () => {
      if (settled || promptSent) return;
      promptSent = true;
      if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
      // Bracketed paste + enter — same mechanism as submitToPty in useHive.ts.
      ptyProc.write(`\x1b[200~${prompt}\x1b[201~`);
      setTimeout(() => { if (!settled) ptyProc.write('\r'); }, 140);
    };

    bootMaxTimer = setTimeout(sendPrompt, bootCapMs);
    globalTimer = setTimeout(
      () => finish({ ok: false, error: 'hidden session timed out' }),
      timeoutMs,
    );

    ptyProc.onData((data) => {
      if (rawOutput.length < RAW_OUTPUT_CAP) rawOutput = (rawOutput + data).slice(0, RAW_OUTPUT_CAP);
      if (!promptSent) {
        // Boot phase: reset quiet timer; send prompt once output goes quiet.
        if (bootTimer) clearTimeout(bootTimer);
        bootTimer = setTimeout(sendPrompt, BOOT_QUIET_MS);
      } else {
        // Response phase: reset idle timer; capture when output settles.
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(captureAndFinish, idleMs);
      }
    });

    // Session exited cleanly before idle — try to capture the transcript anyway.
    ptyProc.onExit(() => { if (!settled) captureAndFinish(); });
  });
}
