import * as pty from 'node-pty';
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { agentEnabledPlugins, claudeUserDir, knownPluginIds } from './agentPlugins';
import { ensurePrivateDir, writeNoFollow } from '../core/hookRuntime';
import { registerPrivateDir } from './privateDirs';
import { resolveCommand, userShellPath } from './shellEnv';
import { expandTilde } from './fs';
import { projectKey } from '../core/transcript';
import { ensureKilled } from './procKill';

/**
 * Shared helper: run a HIDDEN interactive claude session (ephemeral PTY) and
 * return the assistant's final text response.
 *
 * "Hidden" means: not added to the PtyManager, not emitted to the renderer,
 * not visible in the agent list or on the floor. Each call spawns its own
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
  /** Plugins this helper loads, by name or full id. Default none: every plugin the owner has is off for the session. */
  plugins?: string[];
  /** MCP config files this helper loads (--mcp-config). Default none: with --strict-mcp-config no other server starts. */
  mcpConfigs?: string[];
}

/** Where helper sessions' --settings files are written: an app-owned private folder (under userData), and how to find
 *  the hive folder it must stay outside. Never the temp folder: Codex seats can write $TMPDIR, and a settings file is
 *  authority (a `hooks` entry there runs as the owner, outside any sandbox). Unset, no helper runs. */
let helperSettings: { dir: string; hiveRoot: () => string | null; log: (event: Record<string, unknown>) => void } | null = null;
/** Removes the folder's registration as one of the app's private folders. */
let unregisterHelperDir: (() => void) | null = null;
/** A per-call folder's name: `helper-` plus mkdtemp's six characters. Only these are ever swept. */
const HELPER_FOLDER = /^helper-[A-Za-z0-9]{6}$/;
export function setHelperSettingsDir(dir: string | null, hiveRoot: () => string | null, log: (event: Record<string, unknown>) => void = () => {}): void {
  helperSettings = dir ? { dir, hiveRoot, log } : null;
  unregisterHelperDir?.();
  unregisterHelperDir = null;
  if (!helperSettings) return;
  // No agent's write roots may reach it (privateDirs.ts): a settings file planted there would be a helper's settings.
  unregisterHelperDir = registerPrivateDir(helperSettings.dir, 'the helper sessions folder');
  // Sweep what a crashed run left: only per-call folders by their exact name shape, never through a link, and only
  // once the parent passes the private-folder checks. A folder that will not go is logged with its path.
  try {
    ensurePrivateDir(helperSettings.dir, hiveRoot());
    for (const name of readdirSync(helperSettings.dir)) {
      if (!HELPER_FOLDER.test(name)) continue;
      const p = path.join(helperSettings.dir, name);
      try { if (lstatSync(p).isDirectory()) removeHelperFolder(p); } catch { /* gone meanwhile */ }
    }
  } catch { /* not usable yet: every helper call checks again and refuses with the reason */ }
}

/** Remove one per-call folder; if anything of it remains, log once with its path. Returns whether it is gone. */
function removeHelperFolder(folder: string): boolean {
  let why: string | null = null;
  try { rmSync(folder, { recursive: true, force: true }); } catch (e) { why = e instanceof Error ? e.message : String(e); }
  if (!why && !existsSync(folder)) return true;
  try { helperSettings?.log({ kind: 'helper-settings-left', path: folder, why: why ?? 'still present after removal' }); } catch { /* the log is best effort */ }
  return false;
}

/** A fresh folder for one helper's settings, inside the private folder: the parent is checked (absolute, outside the
 *  hive, owner-only, not a link) on every call, the child is unique and 0700. Throws with the reason. */
export function helperSettingsFolder(): string {
  if (!helperSettings) throw new Error('no private folder is set for helper settings');
  ensurePrivateDir(helperSettings.dir, helperSettings.hiveRoot());
  const child = mkdtempSync(path.join(helperSettings.dir, 'helper-'));
  const st = lstatSync(child);
  if (st.isSymbolicLink() || !st.isDirectory()) { rmSync(child, { recursive: true, force: true }); throw new Error('its folder is a link or not a folder'); }
  return child;
}

/**
 * The settings a helper session gets with --settings. The owner's ~/.claude/settings.json enables plugins for every
 * session, so each helper started every plugin's MCP servers (a container, for one) and carried every skill list. As
 * for hive agents (agentPlugins.ts), a session-level enabledPlugins map outranks the owner's user-level `true` for this
 * session only; it names every plugin the owner has, with only `keep` on.
 */
export function hiddenClaudeSettings(ids: readonly string[], keep: readonly string[] = []): { enabledPlugins: Record<string, boolean> } {
  return { enabledPlugins: agentEnabledPlugins(ids, keep) };
}

/** The CLI arguments for a helper session. `settingsPath` is the file holding hiddenClaudeSettings(). Exported for the
 *  regression test. --strict-mcp-config starts only the servers named with --mcp-config (none by default), so no user,
 *  project or plugin server runs. --bare and --restricted are not used: --bare refuses OAuth (helpers draw on the
 *  owner's plan) and --restricted refuses bypassPermissions. */
export function hiddenClaudeArgs(opts: HiddenClaudeOptions, settingsPath: string, sessionId: string): string[] {
  const disallowed = opts.disallowedTools ?? ['Edit', 'Write', 'NotebookEdit'];
  const addDirs = (opts.addDirs ?? []).filter((d) => d && existsSync(d));
  const args: string[] = [
    '--model', opts.model,
    '--session-id', sessionId,
    '--permission-mode', 'bypassPermissions',
    '--disallowedTools', ...disallowed,
  ];
  for (const d of addDirs) { args.push('--add-dir', d); }
  args.push('--settings', settingsPath, '--strict-mcp-config');
  for (const c of opts.mcpConfigs ?? []) { if (c) args.push('--mcp-config', c); }
  return args;
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
 * Where the CLI writes the transcript of session `sessionId` started in `realCwd`: the session-history root of the
 * child's own environment (CLAUDE_CONFIG_DIR when it is an absolute path, else ~/.claude), `projects/`, the project key
 * of the physical cwd the process runs in, then `<sessionId>.jsonl`. Every other session started in the same folder
 * writes there too, so only this one file is this helper's.
 */
/** Whether anything, a dangling link included, is at `p`. */
function pathTaken(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

export function helperTranscriptPath(realCwd: string, sessionId: string, env: Record<string, string | undefined>): string {
  const configDir = env.CLAUDE_CONFIG_DIR;
  const root = configDir && path.isAbsolute(configDir) ? configDir : path.join(os.homedir(), '.claude');
  return path.join(root, 'projects', projectKey(realCwd), `${sessionId}.jsonl`);
}

/**
 * The reply in this helper's own transcript. The file did not exist before the spawn (checked there), so only a
 * regular file that is not a link is read: a link, or anything else at that path, is not something the CLI wrote.
 */
function extractLastAssistantText(file: string): { text: string } | { error: string } | null {
  let fd: number | null = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    return lastAssistantReply(readFileSync(fd, 'utf8'));
  } catch { return null; }
  finally { if (fd !== null) { try { closeSync(fd); } catch { /* already closed */ } } }
}

/**
 * The last assistant text in a transcript, or the CLI's own error. When the CLI cannot reach the model (signed out,
 * login expired, an API error) it still writes an assistant record, marked isApiErrorMessage, whose text is its own
 * message: returned as a reply, a caller would judge it as model output and report a misleading cause.
 */
/** The longest CLI error text passed on: it is logged, and a runaway message must not flood the log. */
const CLI_ERROR_MAX = 500;

export function lastAssistantReply(jsonl: string): { text: string } | { error: string } | null {
  const lines = jsonl.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim();
    if (!trimmed) continue;
    let rec: { type?: unknown; isApiErrorMessage?: unknown; error?: unknown; message?: { content?: unknown[] } };
    try { rec = JSON.parse(trimmed); } catch { continue; }
    if (rec.type !== 'assistant') continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j] as { type?: unknown; text?: unknown };
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (rec.isApiErrorMessage === true) {
          const code = typeof rec.error === 'string' && rec.error ? `${rec.error}: ` : '';
          return { error: `the CLI answered with an error instead of the model: ${code}${block.text.trim()}`.slice(0, CLI_ERROR_MAX) };
        }
        return { text: block.text.trim() };
      }
    }
  }
  return null;
}

export function runHiddenClaude(prompt: string, opts: HiddenClaudeOptions): Promise<HiddenClaudeResult> {
  return new Promise((resolve) => {
    if (!prompt.trim()) { resolve({ ok: false, error: 'empty prompt' }); return; }
    // Defense-in-depth: `~` is shell syntax, not a path Node understands.
    const given = opts.cwd ? expandTilde(opts.cwd) : opts.cwd;
    // The physical path, used for both the spawn and the transcript lookup: the CLI keys its transcript by the cwd
    // its process runs in, which for a path through a link is the link's target.
    let cwd: string;
    try { cwd = given ? realpathSync(given) : ''; } catch { cwd = ''; }
    if (!cwd) {
      resolve({ ok: false, error: `cwd does not exist: ${opts.cwd}` });
      return;
    }
    opts = { ...opts, cwd };

    const binary = (opts.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    // A file, not inline JSON: on Windows the args pass through cmd.exe, which mangles quotes. In the app's private
    // folder, never the temp folder (see setHelperSettingsDir). Removed on every exit path below.
    // From the moment the folder exists, every exit (a failed write, a failed spawn, finish) goes through dropSettings.
    let settingsDir: string | null = null;
    const dropSettings = () => { if (settingsDir) { removeHelperFolder(settingsDir); settingsDir = null; } };
    try {
      settingsDir = helperSettingsFolder();
      writeNoFollow(settingsDir, { name: 'settings.json', content: JSON.stringify(hiddenClaudeSettings(knownPluginIds(claudeUserDir()), opts.plugins ?? [])), mode: 0o600 });
    } catch (e) {
      dropSettings();
      resolve({ ok: false, error: `helper settings: ${e instanceof Error ? e.message : String(e)}` });
      return;
    }
    const env = { ...process.env, PATH: userShellPath(), ...(opts.env ?? {}) } as Record<string, string>;
    // The helper's own session id, so its reply is read from its own transcript and no other session's. Its file must
    // not exist yet: anything already there was not written by this run.
    let sessionId = '';
    let transcript = '';
    for (let tries = 0; tries < 3 && !transcript; tries++) {
      const id = randomUUID();
      const file = helperTranscriptPath(cwd, id, env);
      if (!pathTaken(file)) { sessionId = id; transcript = file; }
    }
    if (!transcript) {
      dropSettings();
      resolve({ ok: false, error: 'helper transcript: every session id tried already has a transcript' });
      return;
    }
    const args = hiddenClaudeArgs(opts, path.join(settingsDir, 'settings.json'), sessionId);

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
        cwd,
        env,
      });
    } catch (e) {
      dropSettings();
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
      dropSettings();
      resolve(r);
    };

    const captureAndFinish = () => {
      const reply = extractLastAssistantText(transcript);
      if (reply && 'text' in reply) { finish({ ok: true, text: reply.text }); return; }
      if (reply) { finish({ ok: false, error: reply.error }); return; }
      // A cwd the CLI has never been trusted in blocks on the workspace-trust
      // dialog forever — it renders as ordinary boot output, so the boot-quiet
      // heuristic reads it as "ready" and sends the prompt into a menu that
      // doesn't consume pasted text, never producing a transcript. That is a
      // DIFFERENT failure from a genuine transient no-response race (retrying
      // hits the identical dialog and fails identically), so it gets its own,
      // actionable error instead of the generic one.
      const error = looksLikeTrustDialog(rawOutput)
        ? 'workspace trust dialog blocked the session (cwd is not a trusted Claude Code directory)'
        : 'no assistant response found in transcript';
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
