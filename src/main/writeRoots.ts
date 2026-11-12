/**
 * Scoped write roots, in dry run.
 *
 * Every sandboxed agent may write the whole hive folder today, so any agent can rewrite
 * another agent's mail, settings, or the hook shim every session runs. The fix is to give
 * each agent only the folders its role needs: god keeps the hive root (it alone writes the
 * task list, the board and the hive config); every other agent gets its own folder, the
 * shared `evidence/` folder and a working directory outside the hive.
 *
 * Narrowing the roots blind would break agents that write shared files today, so this
 * runs first as a dry run: the real sandbox settings are left exactly as they are, and
 * every write the scoped roots WOULD have refused is recorded, as an agent id, a tool and
 * a path CLASS (`tasks.json`, `other agent folder`, `bin` ...), never a path or contents.
 *
 * It never changes a hook's answer, and never delays it: the hook only queues the call
 * (bounded; a full queue sheds and counts what it shed), and the work runs after the answer,
 * one call per event-loop turn, each under a time and path budget past which the rest of
 * that call is recorded as truncated.
 *
 * What it sees, and what it cannot:
 *  - Edit/Write-style tools, and MCP tools whose name says they write: the target path is in
 *    the tool input, so it is exact.
 *  - A Codex patch: the target files are read from the patch's `*** Add/Update/Delete File:`
 *    lines, in whatever field carries the patch.
 *  - A shell command (a string, or an argv array; a script given to `bash -c`/`sh -lc` is read
 *    as a command too): paths after a redirect and the targets of known writers (`cp`/`ln`/
 *    `install`/`rsync` last argument; every argument of `rm`, `mv`, `touch`, `mkdir`, `tee`,
 *    `truncate`, `chmod`, `sed -i`; `dd of=`; `find ... -delete`; the command `xargs` runs)
 *    count as writes. Other hive paths it names count apart, as `shell-named` (often a read).
 *    The program a command runs is never counted. `$HIVE_ROOT`, `$AGENT_DIR`, `$HOME` and `~/`
 *    are expanded. Not seen: a path built at run time, a relative path after `cd` (it reads as
 *    the folder it is relative to, usually `hive root`), a write made by a script the command
 *    runs (python, node, a heredoc).
 *  - A command run outside the sandbox is recorded as such, whatever it touches.
 *  - Anything that does not pass through the hook channel is not seen. The `write-observed`
 *    counts per agent, tool and input shape tell "nothing to refuse" from "nothing seen".
 *
 * Anything an agent can plant in the hive (a link, a file where a folder should be, an
 * unreadable or oversized file, an id the app did not spawn) reads as `unknown` or is not
 * recorded; it never reads as scoped or as the agent's own. These are checks at the time of
 * the read: an enforcing version must re-check at use, since a folder can be swapped after.
 */
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isFolderName } from './messageTarget';
import { TOOL_NAMES } from './usageEvents';
import { claudeLaunch, codexLaunchSandbox, launchExecutable, launchPlaces } from './launchLine';
export { claudeLaunch, codexLaunchSandbox } from './launchLine';

/** Every class a path can be logged as. A name outside this list is never logged. */
export const PATH_CLASSES = [
  'own folder', 'own settings', 'evidence', 'worktree', 'other agent folder', 'agents folder',
  'tasks.json', 'board.md', 'registry.json', 'PROTOCOL.md', 'log.jsonl', 'config', 'bin', 'research',
  'spawn-requests', 'tools', 'skills', 'specs', 'templates', 'hires', 'asks', 'archive', 'backups',
  'assets', '.git', 'hive root', 'hive root (other)', 'contains hive', 'outside hive', 'unsandboxed', 'unknown',
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

export const VIAS = ['edit', 'patch', 'shell-write', 'shell-named', 'shell-unsandboxed', 'truncated'] as const;
export type Via = (typeof VIAS)[number];

/** How a tool call's input was shaped, so a provider whose calls are never read can be spotted. */
export const SHAPES = ['command-string', 'command-array', 'cmd-string', 'cmd-array', 'file-path', 'patch', 'none', 'other', 'shed'] as const;

/** Tool names as logged: the built-in names, Codex's own, `mcp` for any MCP tool, else `other`. */
export const LOG_TOOLS = [...TOOL_NAMES, 'apply_patch', 'shell', 'exec_command', 'mcp', 'other'] as const;
export function toolClass(name: unknown): string {
  if (typeof name !== 'string') return 'other';
  if ((LOG_TOOLS as readonly string[]).includes(name)) return name;
  return name.startsWith('mcp__') ? 'mcp' : 'other';
}

export const PROVIDERS = ['claude', 'codex', 'grok', 'kimi', 'gemini', 'antigravity', 'qwen', 'opencode', 'crush', 'pi', 'copilot', 'cursor', 'custom', 'other'] as const;
export const providerClass = (p: unknown): string => (typeof p === 'string' && (PROVIDERS as readonly string[]).includes(p) ? p : 'other');

const TOP: Record<string, PathClass> = {
  'tasks.json': 'tasks.json', 'board.md': 'board.md', 'registry.json': 'registry.json', 'PROTOCOL.md': 'PROTOCOL.md',
  'log.jsonl': 'log.jsonl', config: 'config', bin: 'bin', research: 'research', 'spawn-requests': 'spawn-requests',
  tools: 'tools', skills: 'skills', specs: 'specs', templates: 'templates', hires: 'hires', asks: 'asks',
  archive: 'archive', backups: 'backups', assets: 'assets', '.git': '.git', evidence: 'evidence',
};

/** Per call: at most this many distinct paths are classed, and work stops at this many ms. */
export const MAX_PATHS = 64;
export const BUDGET_MS = 25;
/** A command longer than this is read only up to it. */
export const MAX_COMMAND = 64 * 1024;
/** Settings files larger than this are not read (and read as unknown). */
export const MAX_SETTINGS = 1024 * 1024;

export interface RootsContext {
  /** The hive root folder. */
  root: string;
  agentId: string;
  isGod: boolean;
  /** The agent's working directory (its worktree). Not absolute = none. */
  cwd: string;
  /** The user's home, for `~` and `$HOME`; defaults to os.homedir(). */
  home?: string;
}

// A per-call memo, so the root, own folder and cwd are resolved once, and repeats cost nothing.
let memo: Map<string, string> | null = null;

/** A path with every link in its longest existing prefix resolved, in the disk's own case,
 *  so neither a link nor a case variant can dodge a class. */
export function canonical(p: string): string {
  const hit = memo?.get(p);
  if (hit !== undefined) return hit;
  let head = resolve(p);
  const tail: string[] = [];
  let out: string;
  for (;;) {
    try { out = join(realpathSync.native(head), ...tail.reverse()); break; } catch { /* not on disk yet */ }
    const up = dirname(head);
    if (up === head) { out = resolve(p); break; }
    tail.push(head.slice(up.length).replace(/^[\\/]+/, ''));
    head = up;
  }
  memo?.set(p, out);
  return out;
}

function withMemo<T>(fn: () => T): T {
  const outer = memo;
  memo = outer ?? new Map();
  try { return fn(); } finally { memo = outer; }
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

const cwdOf = (ctx: RootsContext): string => (typeof ctx.cwd === 'string' && isAbsolute(ctx.cwd) ? canonical(ctx.cwd) : '');

/** The agent's own folder: a real directory, not a link, directly under <hive>/agents with exactly
 *  the id's name. Anything else (a link planted in its place, a file, an id that is not a folder
 *  name) is null: no roots, and `unknown` in the data. */
export function ownFolder(ctx: RootsContext, root: string = canonical(ctx.root)): string | null {
  if (!isFolderName(ctx.agentId)) return null;
  const p = join(root, 'agents', ctx.agentId);
  const key = `\u0000own:${p}`;
  const hit = memo?.get(key);
  if (hit !== undefined) return hit || null;
  let ok = false;
  try { const st = lstatSync(p); ok = st.isDirectory() && !st.isSymbolicLink(); } catch { ok = false; }
  memo?.set(key, ok ? p : '');
  return ok ? p : null;
}

/** The folders the role may write under scoped roots. An agent with no valid own folder gets none. */
export function scopedRoots(ctx: RootsContext): string[] {
  const root = canonical(ctx.root);
  let roots: string[];
  if (ctx.isGod) roots = [root];
  else {
    const own = ownFolder(ctx, root);
    if (!own) return [];
    roots = [own, join(root, 'evidence')];
  }
  // A working directory counts only outside the hive and not above it. One inside the hive is
  // covered by the own folder or is not the agent's to write (bin, agents/, another agent).
  const cwd = cwdOf(ctx);
  if (cwd && !within(cwd, root) && !within(root, cwd)) roots.push(cwd);
  return [...new Set(roots)];
}

function absolute(p: string, ctx: RootsContext): string {
  const base = cwdOf(ctx) || canonical(ctx.root);
  return canonical(isAbsolute(p) ? p : join(base, p));
}

/** The class of one path, relative to this agent. Never throws. */
export function pathClass(p: string, ctx: RootsContext): PathClass {
  if (typeof p !== 'string' || !p) return 'unknown';
  const root = canonical(ctx.root);
  const abs = absolute(p, ctx);
  const cwd = cwdOf(ctx);
  if (!within(abs, root)) {
    if (within(root, abs)) return 'contains hive';
    return cwd && !within(root, cwd) && within(abs, cwd) ? 'worktree' : 'outside hive';
  }
  if (abs === root) return 'hive root';
  const own = ctx.isGod ? (isFolderName(ctx.agentId) ? join(root, 'agents', ctx.agentId) : null) : ownFolder(ctx, root);
  if (own && within(abs, own)) {
    if (within(abs, join(own, 'settings.json')) || within(abs, join(own, '.codex'))) return 'own settings';
    return cwd && cwd !== own && within(cwd, own) && within(abs, cwd) ? 'worktree' : 'own folder';
  }
  const parts = abs.slice(root.length + 1).split(sep);
  if (parts[0] === 'agents') return parts.length === 1 ? 'agents folder' : 'other agent folder';
  return Object.hasOwn(TOP, parts[0]) ? TOP[parts[0]] : 'hive root (other)';
}

/** True when the scoped roots would refuse a write to this path that today's broad roots allow. */
export function wouldRefuse(p: string, ctx: RootsContext): boolean {
  if (typeof p !== 'string' || !p) return false;
  const abs = absolute(p, ctx);
  if (!within(abs, canonical(ctx.root))) return false; // outside the hive the roots do not change
  return !scopedRoots(ctx).some((r) => within(abs, r));
}

// --- shell commands ---

type Tok = { op: string } | { word: string };

/** Words and operators of a command line: quotes honoured, not a full shell parser. */
function lex(text: string): Tok[] {
  const out: Tok[] = [];
  let word: string | null = null;
  const flush = (): void => { if (word !== null) { out.push({ word }); word = null; } };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") { const j = text.indexOf("'", i + 1); word = (word ?? '') + text.slice(i + 1, j === -1 ? text.length : j); i = j === -1 ? text.length : j; continue; }
    if (c === '"') {
      let s = ''; let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) { if (text[j] === '\\' && j + 1 < text.length) j++; s += text[j]; }
      word = (word ?? '') + s; i = j; continue;
    }
    if (c === '\\' && i + 1 < text.length) { word = (word ?? '') + text[++i]; continue; }
    if (/\s/.test(c)) { flush(); if (c === '\n') out.push({ op: ';' }); continue; }
    const two = text.slice(i, i + 2);
    if (['&&', '||', '>>', '&>'].includes(two)) { if (two === '>>' && word !== null && /^\d$/.test(word)) word = null; flush(); out.push({ op: two === '&>' ? '>' : two }); i++; continue; }
    if (';|&()<>'.includes(c)) { if (c === '>' && word !== null && /^\d$/.test(word)) word = null; flush(); out.push({ op: c }); continue; }
    word = (word ?? '') + c;
  }
  flush();
  return out;
}

const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin', 'xargs']);
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
const ALL_ARGS = new Set(['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'truncate', 'chmod', 'chown', 'unlink', 'shred']);
const LAST_ARG = new Set(['cp', 'ln', 'install', 'rsync']);

type Named = { word: string; write: boolean } | { script: string };

/** Each word's role in one simple command: the program (never counted), a write target, another argument, or a script for a shell. */
function roles(words: string[], redirects: string[]): Named[] {
  const out: Named[] = redirects.map((word) => ({ word, write: true }));
  let i = 0;
  // Skip assignments and wrappers, and a wrapper's own flags (env -i, xargs -0, nice -n 5 is read loosely).
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || WRAPPERS.has(basename(words[i])) || (i > 0 && WRAPPERS.has(basename(words[i - 1])) && words[i].startsWith('-')))) i++;
  if (i >= words.length) return out;
  const prog = basename(words[i]);
  const args = words.slice(i + 1);
  if (SHELLS.has(prog)) {
    const c = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
    if (c !== -1 && c + 1 < args.length) { out.push({ script: args[c + 1] }); return out; }
  }
  const plain = args.filter((a) => !a.startsWith('-'));
  const sedInPlace = prog === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  const findDelete = prog === 'find' && args.includes('-delete');
  args.forEach((a, k) => {
    let write = false;
    if (ALL_ARGS.has(prog)) write = !a.startsWith('-');
    else if (LAST_ARG.has(prog)) write = a === plain[plain.length - 1];
    else if (sedInPlace) write = !a.startsWith('-') && a !== plain[0];
    else if (prog === 'dd') write = a.startsWith('of=');
    else if (findDelete) write = !a.startsWith('-') && args.slice(0, k).every((b) => !b.startsWith('-'));
    out.push({ word: a, write });
  });
  return out;
}

/** The hive paths a shell command names, and whether each is a write target. Deduplicated; a script for a shell is read too (two levels deep). */
export function shellPaths(command: unknown, ctx: RootsContext, depth = 0): Array<{ path: string; write: boolean }> {
  const home = ctx.home ?? homedir();
  const agentDir = join(ctx.root, 'agents', ctx.agentId);
  const expand = (w: string): string => w
    .replace(/\$\{?HIVE_ROOT\}?/g, ctx.root).replace(/\$\{?AGENT_DIR\}?/g, agentDir).replace(/\$\{?HOME\}?/g, home)
    .replace(/^~(?=\/|$)/, home).replace(/^(\w+=|--[\w-]+=)~(?=\/)/, `$1${home}`);
  const segments: Array<{ words: string[]; redirects: string[] }> = [];
  if (Array.isArray(command)) {
    if (!command.every((w) => typeof w === 'string')) return [];
    segments.push({ words: command.map((w) => expand(w.slice(0, MAX_COMMAND))), redirects: [] });
  } else if (typeof command === 'string') {
    let cur = { words: [] as string[], redirects: [] as string[] };
    let redirect = false;
    for (const t of lex(command.slice(0, MAX_COMMAND))) {
      if ('op' in t) {
        if (t.op === '>' || t.op === '>>') { redirect = true; continue; }
        if (t.op === '<') continue;
        segments.push(cur); cur = { words: [], redirects: [] }; redirect = false; continue;
      }
      const w = expand(t.word);
      if (redirect) { cur.redirects.push(w); redirect = false; } else cur.words.push(w);
    }
    segments.push(cur);
  } else return [];
  const bases = [...new Set([ctx.root, canonical(ctx.root)])];
  const seen = new Map<string, boolean>();
  for (const s of segments) {
    for (const r of roles(s.words, s.redirects)) {
      if ('script' in r) {
        if (depth < 2) for (const x of shellPaths(r.script, ctx, depth + 1)) seen.set(x.path, (seen.get(x.path) ?? false) || x.write);
        continue;
      }
      const at = bases.map((b) => r.word.indexOf(b)).filter((n) => n !== -1).sort((a, b) => a - b)[0];
      if (at !== undefined) { const p = r.word.slice(at); seen.set(p, (seen.get(p) ?? false) || r.write); }
    }
  }
  return [...seen].map(([path, write]) => ({ path, write }));
}

/** File paths named by `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` lines. */
export function patchPaths(input: unknown): string[] {
  const out: string[] = [];
  const scan = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === 'string') {
      for (const m of v.slice(0, MAX_COMMAND * 4).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1].trim());
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>).slice(0, 32)) scan(x, depth + 1);
    }
  };
  scan(input, 0);
  return [...new Set(out)];
}

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const MCP_WRITE = /^mcp__.*(write|edit|create|move|rename|delete|remove|patch|append|mkdir)/i;
const PATH_FIELDS = ['file_path', 'notebook_path', 'path', 'destination', 'target', 'new_path'];

const rec = (input: unknown): Record<string, unknown> =>
  (input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {});

export function inputShape(input: unknown): (typeof SHAPES)[number] {
  if (input === undefined || input === null) return 'none';
  const r = rec(input);
  for (const k of ['command', 'cmd'] as const) {
    if (typeof r[k] === 'string') return `${k}-string`;
    if (Array.isArray(r[k])) return `${k}-array`;
  }
  if (typeof r.file_path === 'string' || typeof r.notebook_path === 'string' || typeof r.path === 'string') return 'file-path';
  return patchPaths(input).length ? 'patch' : 'other';
}

/** Cheap check: could this call write a file at all? */
export function mayWrite(tool: unknown, input: unknown): boolean {
  if (typeof tool !== 'string') return false;
  if (EDIT_TOOLS.has(tool) || MCP_WRITE.test(tool)) return true;
  const r = rec(input);
  return r.command !== undefined || r.cmd !== undefined || patchPaths(input).length > 0;
}

export interface ToolObservation { via: Via; pathClass: PathClass; refused: boolean }

/** What one tool call would write: the writes scoped roots would refuse, and writes to the
 *  agent's own settings (allowed, but the control plane is to move out of the hive). At most
 *  MAX_PATHS distinct paths and `budgetMs` of work; past either, one `truncated` row. */
export function observeTool(tool: string, input: unknown, ctx: RootsContext, budgetMs = BUDGET_MS, now: () => number = Date.now): ToolObservation[] {
  return withMemo(() => {
    const deadline = now() + budgetMs;
    const r = rec(input);
    const out: ToolObservation[] = [];
    const agentKnown = ctx.isGod || ownFolder(ctx) !== null;
    let paths: Array<{ via: Via; path: string }> = [];
    if (EDIT_TOOLS.has(tool) || MCP_WRITE.test(tool)) {
      for (const k of PATH_FIELDS) if (typeof r[k] === 'string') paths.push({ via: 'edit', path: (r[k] as string).slice(0, 4096) });
    } else {
      const patched = patchPaths(input);
      if (patched.length) paths = patched.map((path) => ({ via: 'patch', path }));
      else {
        const command = r.command !== undefined ? r.command : r.cmd;
        if (command === undefined) return out;
        if (r.dangerouslyDisableSandbox === true) out.push({ via: 'shell-unsandboxed', pathClass: 'unknown', refused: true });
        paths = shellPaths(command, ctx).map(({ path, write }) => ({ via: write ? 'shell-write' : 'shell-named', path }));
      }
    }
    let truncated = paths.length > MAX_PATHS;
    for (const { via, path } of paths.slice(0, MAX_PATHS)) {
      if (now() > deadline) { truncated = true; break; }
      if (!agentKnown) { out.push({ via, pathClass: 'unknown', refused: true }); continue; }
      const refused = wouldRefuse(path, ctx);
      const cls = pathClass(path, ctx);
      if (refused || (cls === 'own settings' && via !== 'shell-named')) out.push({ via, pathClass: cls, refused });
    }
    if (truncated) out.push({ via: 'truncated', pathClass: 'unknown', refused: true });
    return out;
  });
}

// --- effective roots ---

export type RootsState = 'ok' | 'unsandboxed' | 'unknown';
export interface EffectiveRoots { roots: string[]; state: RootsState; source: 'claude-settings-files' | 'codex-config' | 'none' }
/** What the app launched the session with, as it holds it: how the CLI's sandbox was chosen on its command line. */
export interface LaunchFacts { args?: string[]; platform?: string; /** The spawn's final environment, relocation variables only (relocationEnv). */ env?: Record<string, string> }

type Read = { kind: 'missing' } | { kind: 'bad' } | { kind: 'text'; text: string };

/** A settings file: missing (ENOENT) is not an error; a link, a non-file, an unreadable or oversized file is `bad`. */
export function readSettings(file: string): Read {
  let st;
  try { st = lstatSync(file); } catch (e) { return (e as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'missing' } : { kind: 'bad' }; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_SETTINGS) return { kind: 'bad' };
  let fd: number | null = null;
  try {
    // Non-blocking: a file swapped for a pipe after the lstat must not hold the main process; the handle is judged below.
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const f = fstatSync(fd);
    if (!f.isFile() || f.size > MAX_SETTINGS) return { kind: 'bad' };
    const buf = Buffer.alloc(f.size);
    let off = 0;
    while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (n <= 0) break; off += n; }
    return { kind: 'text', text: buf.subarray(0, off).toString('utf8') };
  } catch { return { kind: 'bad' }; } finally { if (fd !== null) closeSync(fd); }
}

/** Codex writable_roots and sandbox mode from a config.toml. Anything not positively read is unknown. */
export function codexRoots(toml: string): { roots: string[]; state: RootsState } {
  const lines = toml.split('\n');
  const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
  const rest = firstHeader === -1 ? [] : lines.slice(firstHeader);
  // A sandbox mode inside a table (a profile) may be the one in force; it cannot be told from here.
  if (rest.some((l) => /^\s*"?sandbox_mode"?\s*=/.test(l))) return { roots: [], state: 'unknown' };
  const modeLine = top.find((l) => /^\s*"?sandbox_mode"?\s*=/.test(l));
  if (modeLine) {
    const m = /^\s*"?sandbox_mode"?\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(#.*)?$/.exec(modeLine);
    const mode = m ? (m[1] ?? m[2]) : null;
    if (mode === 'danger-full-access') return { roots: [], state: 'unsandboxed' };
    if (mode !== 'workspace-write' && mode !== 'read-only') return { roots: [], state: 'unknown' };
  }
  if (top.some((l) => /^\s*"?sandbox_workspace_write"?\s*[.=]/.test(l))) return { roots: [], state: 'unknown' };
  const header = lines.findIndex((l) => /^\s*\[\s*sandbox_workspace_write\s*\]\s*(#.*)?$/.test(l));
  if (header === -1) return { roots: [], state: 'ok' };
  for (let i = header + 1; i < lines.length && !/^\s*\[[^\]"]*\]\s*(#.*)?$/.test(lines[i]); i++) {
    const m = /^\s*writable_roots\s*=\s*(\[.*)$/.exec(lines[i]);
    if (!m) continue;
    let text = m[1];
    while (!/\]\s*(#.*)?$/.test(text) && i + 1 < lines.length) text += lines[++i];
    try {
      const v = JSON.parse(text.replace(/#.*$/, '').replace(/,\s*\]/, ']')) as unknown;
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? { roots: v as string[], state: 'ok' } : { roots: [], state: 'unknown' };
    } catch { return { roots: [], state: 'unknown' }; }
  }
  return { roots: [], state: 'ok' };
}

/** Writable dirs in one Claude settings file; `enabled` is its sandbox.enabled, if it says. */
export function claudeRoots(json: string): { roots: string[]; enabled: boolean | undefined } | null {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as { sandbox?: unknown; permissions?: unknown };
  const sb = o.sandbox && typeof o.sandbox === 'object' ? (o.sandbox as { enabled?: unknown; filesystem?: { allowWrite?: unknown } }) : undefined;
  if (o.sandbox !== undefined && !sb) return null;
  const pm = o.permissions && typeof o.permissions === 'object' ? (o.permissions as { additionalDirectories?: unknown }) : undefined;
  const a = sb?.filesystem?.allowWrite ?? [];
  const b = pm?.additionalDirectories ?? [];
  if (!Array.isArray(a) || !Array.isArray(b) || ![...a, ...b].every((x) => typeof x === 'string')) return null;
  if (sb && sb.enabled !== undefined && typeof sb.enabled !== 'boolean') return null;
  return { roots: [...a, ...b] as string[], enabled: sb?.enabled as boolean | undefined };
}

const MANAGED = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json';
/** Platforms where the CLIs' OS sandbox exists. Elsewhere "enabled" settings do not sandbox anything. */
const SANDBOXED_PLATFORMS = new Set(['darwin', 'linux']);

/** The roots a session was given, read back from the settings files on disk, plus its cwd. */
export function effectiveRoots(provider: string, agentDir: string, cwd: string, home: string = homedir(), launch: LaunchFacts = {}): EffectiveRoots {
  const abscwd = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : '';
  const withCwd = (roots: string[]): string[] => [...new Set([...roots, ...(abscwd ? [abscwd] : [])])];
  const unknown = (source: EffectiveRoots['source']): EffectiveRoots => ({ roots: withCwd([]), state: 'unknown', source });
  const src: EffectiveRoots['source'] = provider === 'codex' ? 'codex-config' : provider === 'claude' ? 'claude-settings-files' : 'none';
  if (!SANDBOXED_PLATFORMS.has(launch.platform ?? process.platform)) return unknown(src);
  if (provider !== 'codex' && provider !== 'claude') return unknown('none');
  // The launch must be the CLI itself (no env/sh/npx wrapper), and the final environment must say where it reads config.
  if (launchExecutable(launch.args) !== provider) return unknown(src);
  const places = launchPlaces(provider, launch.env, home);
  if ('unknown' in places) return unknown(src);
  if (provider === 'codex') {
    const addDirs: string[] = [];
    const flag = codexLaunchSandbox(launch.args, addDirs);
    if (flag === 'danger-full-access') return { roots: withCwd([]), state: 'unsandboxed', source: 'codex-config' };
    if (flag === 'unknown' || flag === 'none') return unknown('codex-config');
    const r = readSettings(join(places.codexHome, 'config.toml'));
    if (r.kind !== 'text') return unknown('codex-config');
    const c = codexRoots(r.text);
    // The command-line mode outranks the config's; the roots still come from the config.
    if (c.state === 'unknown') return unknown('codex-config');
    // Codex also merges a project .codex/config.toml in the working directory or any folder above it.
    const projectRoots: string[] = [];
    if (abscwd) {
      for (let d = resolve(abscwd); ; d = dirname(d)) {
        const pr = readSettings(join(d, '.codex', 'config.toml'));
        if (pr.kind === 'bad') return unknown('codex-config');
        if (pr.kind === 'text') {
          const pc = codexRoots(pr.text);
          if (pc.state === 'unknown') return unknown('codex-config'); // a mode there is outranked by the command line's
          projectRoots.push(...pc.roots.map((x) => (isAbsolute(x) ? x : join(d, x))));
        }
        if (dirname(d) === d) break;
      }
    }
    return { roots: withCwd([...c.roots, ...projectRoots, ...addDirs, ...places.tmpDirs]), state: 'ok', source: 'codex-config' };
  }
  // Highest precedence first; the generated file is passed with --settings. Directories merge across files.
  const generated = join(agentDir, 'settings.json');
  const launchDirs: string[] = [];
  if (claudeLaunch(launch.args, generated, launchDirs) === 'unknown') return unknown('claude-settings-files');
  const files = [MANAGED, generated, ...(abscwd ? [join(abscwd, '.claude', 'settings.local.json'), join(abscwd, '.claude', 'settings.json')] : []), join(places.claudeUserDir, 'settings.json')];
  const roots: string[] = [];
  let enabled: boolean | undefined;
  for (const f of files) {
    const r = readSettings(f);
    if (r.kind === 'missing') { if (f === generated) return unknown('claude-settings-files'); continue; }
    if (r.kind === 'bad') return unknown('claude-settings-files');
    const c = claudeRoots(r.text);
    if (!c) return unknown('claude-settings-files');
    roots.push(...c.roots);
    if (enabled === undefined && c.enabled !== undefined) enabled = c.enabled;
  }
  return { roots: withCwd([...roots, ...launchDirs, ...places.tmpDirs]), state: enabled === true ? 'ok' : 'unsandboxed', source: 'claude-settings-files' };
}

/** The classes of the effective roots, and of those the scoped roots would not grant. */
export function rootsReport(eff: EffectiveRoots, ctx: RootsContext): { effective: PathClass[]; excess: PathClass[] } {
  return withMemo(() => {
    if (eff.state !== 'ok') return { effective: [eff.state], excess: [eff.state] };
    if (!ctx.isGod && ownFolder(ctx) === null) return { effective: ['unknown'], excess: ['unknown'] };
    const scoped = scopedRoots(ctx);
    const effective = new Set<PathClass>();
    const excess = new Set<PathClass>();
    for (const r of eff.roots) {
      const abs = canonical(r);
      const cls = pathClass(abs, ctx);
      effective.add(cls);
      // A root that CONTAINS a scoped root grants more than it; one inside a scoped root grants nothing extra.
      if (!scoped.some((s) => within(abs, s))) excess.add(cls);
    }
    return { effective: [...effective], excess: [...excess] };
  });
}

// --- the observer ---

export interface DryRunAgent { ctx: RootsContext; provider: string; agentDir: string; launch?: LaunchFacts }
export interface DryRunDeps {
  /** The agent's roots context from what the app spawned, or null for an id it did not spawn. */
  agent(agentId: string): DryRunAgent | null;
  record(event: Record<string, unknown>): void;
  /** Cheap, in-memory (a Map.has on the spawn record): whether the app spawned this id. Checked before a call is queued. */
  known(agentId: string): boolean;
  /** Runs work after the hook's answer; defaults to setImmediate. */
  defer?: (fn: () => void) => void;
  now?: () => number;
}

/** Calls waiting to be read, per agent. Past this the hook sheds that agent's call and counts it: one agent's burst can
 *  only shed its own calls, never another's. Agents are drained in turn, one call per event-loop turn, so a full queue
 *  is at most 8 × 25 ms = 200 ms of main-thread work per spawned agent, in slices with hooks answered between them. */
export const MAX_QUEUE = 8;
const MAX_COUNTERS = 2000;

type Pending = { agentId: string; event: string; tool: unknown; input: unknown };

/** Records, from the hook channel, what scoped roots would have refused. Observes only: never throws, never decides,
 *  and does nothing on the hook's answer path but queue the call. */
export class WriteRootsDryRun {
  private queues = new Map<string, Pending[]>();
  /** The agents with calls waiting, in the order they are drained. */
  private turn: string[] = [];
  private scheduled = false;
  private shed = new Map<string, number>();
  /** Tool calls seen per spawned agent, tool and input shape since that agent's last Stop. */
  private seen = new Map<string, number>();

  constructor(private readonly d: DryRunDeps) {}

  /** Called inside the hook handler: O(1), never throws, never reads the disk. */
  onHook(agentId: string | undefined, event: string, p: { tool_name?: unknown; tool_input?: unknown }): void {
    try {
      if (typeof agentId !== 'string' || !agentId) return;
      if (event !== 'PreToolUse' && event !== 'Stop' && event !== 'SessionEnd' && event !== 'SessionStart') return;
      // Admission: an id the app did not spawn never takes a queue slot, so made-up ids cannot crowd out a real call.
      if (this.d.known(agentId) !== true) return;
      let q = this.queues.get(agentId);
      if (!q) { q = []; this.queues.set(agentId, q); this.turn.push(agentId); }
      if (event === 'PreToolUse') {
        if (q.filter((j) => j.event === 'PreToolUse').length >= MAX_QUEUE) { this.shed.set(agentId, (this.shed.get(agentId) ?? 0) + 1); return; }
      } else if (q.some((j) => j.event === event)) return; // a turn's Stop or a session start is never shed, and never waits twice
      q.push({ agentId, event, tool: p?.tool_name, input: p?.tool_input });
      this.schedule();
    } catch { /* a dry run must never disturb the hook it rides on */ }
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    (this.d.defer ?? setImmediate)(() => this.drainOne());
  }

  /** One call per event-loop turn, so other hooks are answered between them. */
  private drainOne(): void {
    this.scheduled = false;
    // Round robin: the next agent in turn gives one call, and goes to the back if it has more.
    const id = this.turn.shift();
    const q = id === undefined ? undefined : this.queues.get(id);
    const job = q?.shift();
    if (id !== undefined && q) { if (q.length) this.turn.push(id); else this.queues.delete(id); }
    if (job) { try { this.process(job); } catch { /* never let one call stop the rest */ } }
    if (this.turn.length) this.schedule();
  }

  private process(j: Pending): void {
    const a = this.d.agent(j.agentId);
    if (!a) return; // an id the app did not spawn: nothing allocated, nothing recorded
    const now = this.d.now ?? Date.now;
    if (j.event === 'PreToolUse') {
      const key = `${j.agentId}\u0000${toolClass(j.tool)}\u0000${inputShape(j.input)}`;
      if (this.seen.has(key) || this.seen.size < MAX_COUNTERS) this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
      if (!mayWrite(j.tool, j.input)) return;
      const tool = toolClass(j.tool);
      for (const o of observeTool(j.tool as string, j.input, a.ctx, BUDGET_MS, now)) {
        if (o.refused) this.d.record({ kind: 'write-would-refuse', agentId: j.agentId, tool, via: o.via, pathClass: o.pathClass });
        else this.d.record({ kind: 'write-own-settings', agentId: j.agentId, tool, via: o.via });
      }
      return;
    }
    if (j.event === 'Stop' || j.event === 'SessionEnd') { this.flush(j.agentId); return; }
    const eff = effectiveRoots(a.provider, a.agentDir, a.ctx.cwd, a.ctx.home, a.launch);
    this.d.record({ kind: 'write-roots', agentId: j.agentId, provider: providerClass(a.provider), role: a.ctx.isGod ? 'god' : 'agent', source: eff.source, ...rootsReport(eff, a.ctx) });
  }

  private flush(agentId: string): void {
    const prefix = `${agentId}\u0000`;
    const rows = [...this.seen].filter(([k]) => k.startsWith(prefix));
    for (const [k] of rows) this.seen.delete(k);
    for (const [k, count] of rows) {
      const [, tool, shape] = k.split('\u0000');
      this.d.record({ kind: 'write-observed', agentId, tool, shape, count });
    }
    const shed = this.shed.get(agentId);
    if (shed) { this.shed.delete(agentId); this.d.record({ kind: 'write-observed', agentId, tool: 'other', shape: 'shed', count: shed }); }
  }
}

/** Every input the dry run reads, who can write it today, and what a planted value does. The test suite runs one case
 *  per row and fails when a row has none; the PR's table is this list. */
export const READ_SITES = [
  { id: 'payload-agent-id', read: 'hook payload agent_id', writer: 'any process that reaches the hook socket', planted: 'an id the app did not spawn, thousands of them', outcome: 'never queued (checked against the spawn record before admission); nothing allocated or recorded' },
  { id: 'payload-tool-name', read: 'hook payload tool_name', writer: 'same', planted: 'free text, non-string', outcome: 'logged as a fixed name or other' },
  { id: 'payload-tool-input', read: 'hook payload tool_input', writer: 'same', planted: 'huge command, thousands or deep missing paths, wrong types', outcome: 'answer not delayed; at most 64 paths, 25 ms, 64 KB per call, then one truncated row; wrong types record nothing' },
  { id: 'queue', read: 'the deferred queue, one per agent', writer: 'spawned agents, by calling tools', planted: 'one agent flooding calls', outcome: 'at most 8 tool calls waiting per agent, drained in turn; more are shed and counted for that agent only; Stop and session start are never shed' },
  { id: 'own-folder', read: '<hive>/agents/<id>', writer: 'every agent', planted: 'a link, a file, missing, an id that is not a plain name', outcome: 'no roots; every observation and the report unknown' },
  { id: 'claude-generated-settings', read: 'agents/<id>/settings.json', writer: 'the agent itself', planted: 'link, folder, unreadable, oversized, named pipe, parent is a file, missing', outcome: 'unknown' },
  { id: 'claude-project-settings', read: '<cwd>/.claude/settings(.local).json', writer: 'agents working in that cwd', planted: 'same kinds', outcome: 'unknown; missing is skipped' },
  { id: 'claude-user-settings', read: '~/.claude/settings.json', writer: 'an unsandboxed command', planted: 'same kinds', outcome: 'unknown; missing is skipped' },
  { id: 'claude-managed-settings', read: 'managed-settings.json', writer: 'root only (not plantable by an agent)', planted: '—', outcome: 'read like the others' },
  { id: 'codex-config', read: 'agents/<id>/.codex/config.toml', writer: 'the agent (read-only under Codex\'s own sandbox)', planted: 'same kinds; a profile or unknown sandbox_mode; dotted or inline roots', outcome: 'unknown (full access: unsandboxed)' },
  { id: 'spawn-record', read: 'cwd, provider, role, launch line', writer: 'held in main\'s memory from the spawn', planted: 'not writable from the hive', outcome: 'a relative cwd is none; a provider other than Claude or Codex, or a platform without a sandbox, is unknown' },
  { id: 'codex-prompt', read: 'Codex launch line: the prompt', writer: 'the spawn request', planted: 'flags inside the prompt text', outcome: 'never read: options stop at the first positional' },
  { id: 'codex-sandbox-flag', read: 'Codex -s/--sandbox, --full-auto', writer: 'the spawn request', planted: 'any mode', outcome: 'workspace-write/read-only ok; danger-full-access unsandboxed; anything else or none unknown' },
  { id: 'codex-bypass-flag', read: 'Codex --dangerously-bypass-approvals-and-sandbox, --yolo', writer: 'the spawn request', planted: 'the flag', outcome: 'unsandboxed' },
  { id: 'codex-config-flag', read: 'Codex -c/--config on sandbox_mode, sandbox_workspace_write or profile', writer: 'the spawn request', planted: 'any value', outcome: 'unknown' },
  { id: 'codex-profile-flag', read: 'Codex -p/--profile', writer: 'the spawn request', planted: 'any profile', outcome: 'unknown' },
  { id: 'codex-add-dir-flag', read: 'Codex --add-dir', writer: 'the spawn request (the app passes its own roots)', planted: 'any directory', outcome: 'counted as a root' },
  { id: 'codex-remote-flag', read: 'Codex --remote', writer: 'the remote rewrite', planted: 'any server', outcome: 'unknown (the server\'s policy is in force)' },
  { id: 'codex-unknown-option', read: 'any other Codex option', writer: 'the spawn request', planted: 'an option not in the grammar, a missing value', outcome: 'unknown' },
  { id: 'claude-prompt', read: 'Claude launch line: the prompt', writer: 'the spawn request', planted: 'flags inside the prompt text', outcome: 'never read' },
  { id: 'claude-add-dir-flag', read: 'Claude --add-dir (variadic)', writer: 'the spawn request', planted: 'any directories', outcome: 'counted as roots' },
  { id: 'claude-settings-flag', read: 'Claude --settings', writer: 'the app (its generated file)', planted: 'another file or inline JSON', outcome: 'unknown' },
  { id: 'claude-unmodelled-flag', read: 'Claude --setting-sources, --bare, --safe-mode, --restricted, --worktree, ...', writer: 'the spawn request', planted: 'any', outcome: 'unknown' },
  { id: 'option-after-positional', read: 'arguments after the prompt (either CLI)', writer: 'the spawn request', planted: 'codex "prompt" --yolo; claude ... "prompt" --settings x', outcome: 'unknown: both CLIs read options there' },
  { id: 'codex-project-config', read: '.codex/config.toml in the cwd and every folder above', writer: 'agents working in that cwd', planted: 'writable_roots into the hive; an unreadable or unparsed file', outcome: 'its roots count; not understood = unknown' },
  { id: 'claude-plugin-dir', read: 'Claude --plugin-dir, --plugin-url', writer: 'the spawn request', planted: 'any plugin (can carry hooks and settings)', outcome: 'unknown' },
  { id: 'env-tmpdir', read: 'TMPDIR (both), CLAUDE_CODE_TMPDIR (Claude)', writer: 'the operator\'s environment, or a per-agent override', planted: 'a temp folder inside the hive', outcome: 'counted as a root (the sandbox lets the CLI write its temp folder); relative = unknown' },
  { id: 'launch-executable-name', read: 'the executable\'s name', writer: 'the spawn request', planted: 'another program installed under the name claude or codex', outcome: 'taken to be the CLI: judged by name, the path is not resolved (stated limit)' },
  { id: 'launch-wrapper', read: 'the launch line\'s executable', writer: 'the spawn request', planted: 'a wrapper: env X=Y claude, sh -c "...", npx codex', outcome: 'unknown (not a plain provider invocation)' },
  { id: 'env-missing', read: 'the spawn\'s final environment', writer: 'held in main\'s memory from the spawn', planted: 'none recorded', outcome: 'unknown' },
  { id: 'env-home', read: 'HOME in the spawn environment', writer: 'the operator\'s environment, or a per-agent override', planted: 'another home', outcome: 'honoured: user config is read from that home' },
  { id: 'env-claude-config-dir', read: 'CLAUDE_CONFIG_DIR', writer: 'same', planted: 'another folder', outcome: 'honoured: Claude\'s user settings are read from there; not absolute = unknown' },
  { id: 'env-codex-home', read: 'CODEX_HOME', writer: 'the app (one per Codex agent)', planted: 'another folder', outcome: 'honoured: Codex\'s config is read from there; not absolute = unknown' },
  { id: 'env-xdg-config-home', read: 'XDG_CONFIG_HOME (Claude)', writer: 'the operator\'s environment', planted: 'any value', outcome: 'unknown (Claude reads it; not modelled)' },
  { id: 'env-claude-unmodelled', read: 'CLAUDE_CODE_*SETTINGS/CONFIG/MANAGED/PLUGIN* variables', writer: 'a per-agent override', planted: 'any value', outcome: 'unknown' },
  { id: 'claude-unknown-option', read: 'any other Claude option, or no launch line', writer: 'the spawn request', planted: 'an option not in the grammar', outcome: 'unknown' },
] as const;
