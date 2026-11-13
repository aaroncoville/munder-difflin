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
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isFolderName } from './messageTarget';
import { TOOL_NAMES } from './usageEvents';
import { claudeLaunch, claudeRoots, codexLaunchSandbox, codexRoots, launchExecutable, launchPlaces, type RootsState } from './launchLine';
export { claudeLaunch, claudeRoots, codexLaunchSandbox, codexRoots } from './launchLine';

/** Every class a path can be logged as. A name outside this list is never logged. */
export const PATH_CLASSES = [
  'own folder', 'own settings', 'evidence', 'worktree', 'other agent folder', 'agents folder',
  'tasks.json', 'board.md', 'registry.json', 'PROTOCOL.md', 'log.jsonl', 'config', 'bin', 'research',
  'spawn-requests', 'tools', 'skills', 'specs', 'templates', 'hires', 'asks', 'archive', 'backups',
  'assets', '.git', 'hive root', 'hive root (other)', 'contains hive', 'outside hive', 'temp', 'unsandboxed', 'unknown',
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

/** A path is canonicalized and classed only within these bounds; past them it counts as a possible write and the call
 *  gets a truncated row. One check for every path source: edit targets, patch lines, shell words, argv, roots. */
export const MAX_PATH_BYTES = 4096;
export const MAX_PATH_COMPONENTS = 256;
export function admitPath(p: string): boolean {
  if (typeof p !== 'string') return false;
  if (Buffer.byteLength(p, 'utf8') > MAX_PATH_BYTES) return false;
  let n = 1;
  for (let i = 0; i < p.length; i++) if (p[i] === '/' || p[i] === '\\') { if (++n > MAX_PATH_COMPONENTS) return false; }
  return true;
}

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
export function shellPaths(command: unknown, ctx: RootsContext, depth = 0, cut: { truncated: boolean } = { truncated: false }): Array<{ path: string; write: boolean }> {
  const home = ctx.home ?? homedir();
  const agentDir = join(ctx.root, 'agents', ctx.agentId);
  const expand = (w: string): string => w
    .replace(/\$\{?HIVE_ROOT\}?/g, ctx.root).replace(/\$\{?AGENT_DIR\}?/g, agentDir).replace(/\$\{?HOME\}?/g, home)
    .replace(/^~(?=\/|$)/, home).replace(/^(\w+=|--[\w-]+=)~(?=\/)/, `$1${home}`);
  const segments: Array<{ words: string[]; redirects: string[] }> = [];
  if (Array.isArray(command)) {
    if (!command.every((w) => typeof w === 'string')) return [];
    if (command.some((w) => w.length > MAX_COMMAND)) cut.truncated = true;
    segments.push({ words: command.map((w) => expand(w.slice(0, MAX_COMMAND))), redirects: [] });
  } else if (typeof command === 'string') {
    let cur = { words: [] as string[], redirects: [] as string[] };
    let redirect = false;
    if (command.length > MAX_COMMAND) cut.truncated = true;
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
        if (depth < 2) for (const x of shellPaths(r.script, ctx, depth + 1, cut)) seen.set(x.path, (seen.get(x.path) ?? false) || x.write);
        else cut.truncated = true; // a script nested deeper than this is not read
        continue;
      }
      const at = bases.map((b) => r.word.indexOf(b)).filter((n) => n !== -1).sort((a, b) => a - b)[0];
      if (at !== undefined) { const p = r.word.slice(at); seen.set(p, (seen.get(p) ?? false) || r.write); }
    }
  }
  return [...seen].map(([path, write]) => ({ path, write }));
}

/** File paths named by `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` lines. */
export function patchPaths(input: unknown, cut: { truncated: boolean } = { truncated: false }): string[] {
  const out: string[] = [];
  const scan = (v: unknown, depth: number): void => {
    if (depth > 3) { cut.truncated = true; return; }
    if (typeof v === 'string') {
      if (v.length > MAX_COMMAND * 4) cut.truncated = true;
      for (const m of v.slice(0, MAX_COMMAND * 4).matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1].trim());
    } else if (v && typeof v === 'object') {
      const vals = Object.values(v as Record<string, unknown>);
      if (vals.length > 32) cut.truncated = true;
      for (const x of vals.slice(0, 32)) scan(x, depth + 1);
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
  const cut = { truncated: false };
  return patchPaths(input, cut).length || cut.truncated ? 'patch' : 'other';
}

/** Cheap check: could this call write a file at all? */
export function mayWrite(tool: unknown, input: unknown): boolean {
  if (typeof tool !== 'string') return false;
  if (EDIT_TOOLS.has(tool) || MCP_WRITE.test(tool)) return true;
  const r = rec(input);
  if (r.command !== undefined || r.cmd !== undefined) return true;
  // A patch scan cut short is a possible write: it goes on to observeTool, which records it as truncated.
  const cut = { truncated: false };
  return patchPaths(input, cut).length > 0 || cut.truncated;
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
    const cut = { truncated: false };
    if (EDIT_TOOLS.has(tool) || MCP_WRITE.test(tool)) {
      for (const k of PATH_FIELDS) {
        if (typeof r[k] !== 'string') continue;
        if (!admitPath(r[k] as string)) { cut.truncated = true; continue; } // past the path bounds: not classed
        paths.push({ via: 'edit', path: r[k] as string });
      }
    } else {
      const patched = patchPaths(input, cut);
      if (patched.length) paths = patched.map((path) => ({ via: 'patch', path }));
      else {
        const command = r.command !== undefined ? r.command : r.cmd;
        if (command === undefined) {
          if (cut.truncated) out.push({ via: 'truncated', pathClass: 'unknown', refused: true }); // a patch scan cut short found nothing
          return out;
        }
        if (r.dangerouslyDisableSandbox === true) out.push({ via: 'shell-unsandboxed', pathClass: 'unknown', refused: true });
        paths = shellPaths(command, ctx, 0, cut).map(({ path, write }) => ({ via: write ? 'shell-write' : 'shell-named', path }));
      }
    }
    let truncated = cut.truncated || paths.length > MAX_PATHS;
    for (const { via, path } of paths.slice(0, MAX_PATHS)) {
      if (now() > deadline) { truncated = true; break; }
      if (!admitPath(path)) { truncated = true; continue; } // patch, shell and argv paths get the same bounds as edits
      if (!agentKnown) { out.push({ via, pathClass: 'unknown', refused: true }); continue; }
      const refused = wouldRefuse(path, ctx);
      const cls = pathClass(path, ctx);
      if (refused || (cls === 'own settings' && via !== 'shell-named')) out.push({ via, pathClass: cls, refused });
      // Checked after the work too: a classification that crossed the deadline ends the call as truncated.
      if (now() > deadline) { truncated = true; break; }
    }
    if (truncated) out.push({ via: 'truncated', pathClass: 'unknown', refused: true });
    return out;
  });
}

// --- effective roots ---

export interface EffectiveRoots { roots: string[]; state: RootsState; source: 'claude-settings-files' | 'codex-config' | 'none'; /** The roots that are the CLI's temp folder (TMPDIR), classed apart. */ temp?: string[] }
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


/** The machine-wide Claude settings file; its drop-in folder managed-settings.d sits beside it. (An object so a test can point it elsewhere.) */
export const MANAGED_SETTINGS = { path: process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json' : '/etc/claude-code/managed-settings.json' };
function managedFiles(): string[] {
  const drop = join(dirname(MANAGED_SETTINGS.path), 'managed-settings.d');
  let names: string[] = [];
  try { names = readdirSync(drop).filter((n) => n.endsWith('.json')).sort(); } catch { names = []; }
  return [MANAGED_SETTINGS.path, ...names.map((n) => join(drop, n))];
}
/** Platforms where the CLIs' OS sandbox exists. Elsewhere "enabled" settings do not sandbox anything. */
const SANDBOXED_PLATFORMS = new Set(['darwin', 'linux']);

/** The roots a session was given, read back from the settings files on disk, plus its cwd. */
export function effectiveRoots(provider: string, agentDir: string, cwd: string, home: string = homedir(), launch: LaunchFacts = {}): EffectiveRoots {
  const abscwd = typeof cwd === 'string' && isAbsolute(cwd) ? cwd : '';
  let anchorHome = home;
  let unanchored = false;
  // Every root is read the way the spawned CLI reads it: ~ against the spawn's home, a relative path against the
  // spawn's cwd (never the app's own). A variable, or a relative root with no cwd to read it against, is not modelled.
  const anchor = (r: string): string | null => {
    const v = r.replace(/^~(?=$|[\\/])/, anchorHome);
    if (/[$%`]/.test(v) || /^~/.test(v)) return null;
    if (isAbsolute(v)) return v;
    return abscwd ? join(abscwd, v) : null;
  };
  const withCwd = (roots: string[]): string[] => {
    const out: string[] = [];
    for (const r of roots) { const a = anchor(r); if (a === null) { unanchored = true; continue; } out.push(a); }
    return [...new Set([...out, ...(abscwd ? [abscwd] : [])])];
  };
  const unknown = (source: EffectiveRoots['source']): EffectiveRoots => ({ roots: withCwd([]), state: 'unknown', source });
  const src: EffectiveRoots['source'] = provider === 'codex' ? 'codex-config' : provider === 'claude' ? 'claude-settings-files' : 'none';
  if (!SANDBOXED_PLATFORMS.has(launch.platform ?? process.platform)) return unknown(src);
  if (provider !== 'codex' && provider !== 'claude') return unknown('none');
  // The launch must be the CLI itself (no env/sh/npx wrapper), and the final environment must say where it reads config.
  if (launchExecutable(launch.args) !== provider) return unknown(src);
  const places = launchPlaces(provider, launch.env, home);
  if ('unknown' in places) return unknown(src);
  anchorHome = places.home;
  if (provider === 'codex') {
    const addDirs: string[] = [];
    const flag = codexLaunchSandbox(launch.args, addDirs);
    if (flag === 'danger-full-access') return { roots: withCwd([]), state: 'unsandboxed', source: 'codex-config' };
    if (flag === 'unknown') return unknown('codex-config');
    const r = readSettings(join(places.codexHome, 'config.toml'));
    if (r.kind !== 'text') return unknown('codex-config');
    const c = codexRoots(r.text);
    // The command-line mode outranks the config's; the roots still come from the config.
    if (c.state === 'unknown') return unknown('codex-config');
    // Codex also merges a project .codex/config.toml in the working directory or any folder above it.
    const projectRoots: string[] = [];
    // With no -s on the line (auto mode off), the mode is the config's: the nearest project config's, else its own.
    let nearestMode: string | null | undefined;
    if (abscwd) {
      for (let d = resolve(abscwd); ; d = dirname(d)) {
        const pr = readSettings(join(d, '.codex', 'config.toml'));
        if (pr.kind === 'bad') return unknown('codex-config');
        if (pr.kind === 'text') {
          const pc = codexRoots(pr.text);
          if (pc.state === 'unknown') return unknown('codex-config'); // a mode there is outranked by the command line's
          projectRoots.push(...pc.roots);
          if (nearestMode === undefined && pc.mode) nearestMode = pc.mode;
        }
        if (dirname(d) === d) break;
      }
    }
    if (flag === 'none') {
      const mode = nearestMode ?? c.mode ?? null;
      if (mode === 'danger-full-access') return { roots: withCwd([]), state: 'unsandboxed', source: 'codex-config' };
      if (mode !== 'workspace-write' && mode !== 'read-only') return unknown('codex-config'); // Codex's built-in default is not guessed
    }
    const codexRootsOut = withCwd([...c.roots, ...projectRoots, ...addDirs, ...places.tmpDirs]);
    return unanchored ? unknown('codex-config') : { roots: codexRootsOut, state: 'ok', source: 'codex-config', temp: places.tmpDirs };
  }
  // Highest precedence first; the generated file is passed with --settings. Directories merge across files.
  const generated = join(agentDir, 'settings.json');
  const launchDirs: string[] = [];
  if (claudeLaunch(launch.args, generated, launchDirs) === 'unknown') return unknown('claude-settings-files');
  const files = [...managedFiles(), generated, ...(abscwd ? [join(abscwd, '.claude', 'settings.local.json'), join(abscwd, '.claude', 'settings.json')] : []), join(places.claudeUserDir, 'settings.json')];
  const roots: string[] = [];
  let enabled: boolean | undefined;
  const managed = new Set(managedFiles());
  let managedEnabled: boolean | undefined;
  for (const f of files) {
    const r = readSettings(f);
    if (r.kind === 'missing') { if (f === generated) return unknown('claude-settings-files'); continue; }
    if (r.kind === 'bad') return unknown('claude-settings-files');
    const c = claudeRoots(r.text);
    if (!c) return unknown('claude-settings-files');
    roots.push(...c.roots);
    // Claude's order among the managed file and its drop-ins is not modelled: two that disagree are unknown.
    if (managed.has(f) && c.enabled !== undefined) {
      if (managedEnabled !== undefined && managedEnabled !== c.enabled) return unknown('claude-settings-files');
      managedEnabled = c.enabled;
    }
    if (enabled === undefined && c.enabled !== undefined) enabled = c.enabled;
  }
  const claudeRootsOut = withCwd([...roots, ...launchDirs, ...places.tmpDirs]);
  if (unanchored) return unknown('claude-settings-files');
  return { roots: claudeRootsOut, state: enabled === true ? 'ok' : 'unsandboxed', source: 'claude-settings-files', temp: places.tmpDirs };
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
      if (!admitPath(r)) { effective.add('unknown'); excess.add('unknown'); continue; } // a root past the path bounds is not read
      const abs = canonical(r);
      // A temp folder outside the hive (macOS sets one for every session) is classed 'temp', so it is not read as a
      // real outside-hive grant; one inside the hive keeps its hive class.
      const isTemp = (eff.temp ?? []).some((t) => canonical(t) === abs);
      const base = pathClass(abs, ctx);
      const cls: PathClass = isTemp && (base === 'outside hive' || base === 'worktree') ? 'temp' : base;
      effective.add(cls);
      // A root that CONTAINS a scoped root grants more than it; one inside a scoped root grants nothing extra.
      if (!scoped.some((s) => within(abs, s))) excess.add(cls);
    }
    return { effective: [...effective], excess: [...excess] };
  });
}

// --- the observer ---

export interface DryRunAgent { ctx: RootsContext; provider: string; agentDir: string; launch?: LaunchFacts; /** Which spawn of this agent this is; a session start is counted once per spawn. */ gen?: number }
export interface DryRunDeps {
  /** The agent's roots context from what the app spawned, or null for an id it did not spawn. */
  agent(agentId: string): DryRunAgent | null;
  /** Writes one row; false when the row was not written. */
  record(event: Record<string, unknown>): boolean | void;
  /** Last resort when even the incomplete row saying rows were refused cannot be written (one log.jsonl line). */
  logFallback?(row: Record<string, unknown>): void;
  /** Cheap, in-memory (a Map.has on the spawn record): whether the app spawned this id. Checked before a call is queued. */
  known(agentId: string): boolean;
  /** Cheap, in-memory: which spawn of this agent is current (counts session starts at admission). */
  generation?(agentId: string): number;
  /** Runs work after the hook's answer; defaults to setImmediate. */
  defer?: (fn: () => void) => void;
  now?: () => number;
}

/** Where a session start came from, as the hook reports it. */
export const START_SOURCES = ['startup', 'resume', 'clear', 'compact', 'unknown'] as const;

/** Calls waiting to be read, per agent. Past this the hook sheds that agent's call and counts it: one agent's burst can
 *  only shed its own calls, never another's. Agents are drained in turn, one call per event-loop turn, so a full queue
 *  is at most 8 × 25 ms = 200 ms of main-thread work per spawned agent, in slices with hooks answered between them. */
export const MAX_QUEUE = 8;
/** Distinct tool/shape counters kept per agent per turn; past it the agent's turn is incomplete (reason: cap). */
export const MAX_KEYS_PER_AGENT = 64;

type Pending = { agentId: string; event: string; tool: unknown; input: unknown; source?: string; coalesced?: number };

/** Records, from the hook channel, what scoped roots would have refused. Observes only: never throws, never decides,
 *  and does nothing on the hook's answer path but queue the call. */
export class WriteRootsDryRun {
  private queues = new Map<string, Pending[]>();
  /** The agents with calls waiting, in the order they are drained. */
  private turn: string[] = [];
  private scheduled = false;
  private shed = new Map<string, number>();
  /** Tool calls seen per spawned agent, tool and input shape since that agent's last Stop. */
  private seen = new Map<string, Map<string, number>>();
  /** Calls not counted because the agent's counters were full. */
  private capped = new Map<string, number>();
  /** Session starts admitted per agent: the generation already counted, and duplicates seen for it. */
  /** Session starts admitted since the agent's last turn end, starts past the bound, and the per-spawn ordinal. */
  private startsSinceStop = new Map<string, number>();
  private flood = new Map<string, number>();
  private ordinal = new Map<string, { gen: number; n: number }>();

  /** Rows the log refused, per agent, and calls dropped because the agent was no longer known. */
  private refusedRows = new Map<string, number>();
  private noAgent = new Map<string, number>();

  constructor(private readonly d: DryRunDeps) {}

  /** Every row goes through here: a row the log does not write is counted, and reported at the agent's next flush. */
  private emit(row: Record<string, unknown>): void {
    let ok: boolean | void = false;
    try { ok = this.d.record(row); } catch { ok = false; }
    if (ok === false && typeof row.agentId === 'string') this.refusedRows.set(row.agentId, (this.refusedRows.get(row.agentId) ?? 0) + 1);
  }

  /** Called inside the hook handler: O(1), never throws, never reads the disk. */
  onHook(agentId: string | undefined, event: string, p: { tool_name?: unknown; tool_input?: unknown; source?: unknown }): void {
    try {
      if (typeof agentId !== 'string' || !agentId) return;
      if (event !== 'PreToolUse' && event !== 'Stop' && event !== 'SessionEnd' && event !== 'SessionStart') return;
      // Admission: an id the app did not spawn never takes a queue slot, so made-up ids cannot crowd out a real call.
      if (this.d.known(agentId) !== true) return;
      let q = this.queues.get(agentId);
      if (!q) { q = []; this.queues.set(agentId, q); this.turn.push(agentId); }
      if (event === 'SessionStart') {
        // Every start is recorded (its roots are re-read), bounded per agent like tool calls; past the bound the turn
        // reads incomplete. Starts waiting together are recorded once, with how many they were.
        const n = (this.startsSinceStop.get(agentId) ?? 0) + 1;
        this.startsSinceStop.set(agentId, n);
        if (n > MAX_QUEUE) { this.flood.set(agentId, (this.flood.get(agentId) ?? 0) + 1); return; }
        const waiting = q.find((j) => j.event === 'SessionStart');
        const source = typeof p?.source === 'string' ? p.source : undefined;
        if (waiting) { waiting.coalesced = (waiting.coalesced ?? 1) + 1; waiting.source = source ?? waiting.source; this.schedule(); return; }
        q.push({ agentId, event, tool: undefined, input: undefined, source, coalesced: 1 });
        this.schedule();
        return;
      }
      if (event === 'PreToolUse') {
        if (q.filter((j) => j.event === 'PreToolUse').length >= MAX_QUEUE) { this.shed.set(agentId, (this.shed.get(agentId) ?? 0) + 1); return; }
      } else if (q.some((j) => j.event === event)) return; // a second Stop waiting is the same flush: nothing is lost by merging it
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
    // Admitted (the app spawned it) but no longer resolvable, e.g. the hive root went away mid-run: counted, not silent.
    if (!a) { if (j.event === 'PreToolUse' || j.event === 'SessionStart') this.noAgent.set(j.agentId, (this.noAgent.get(j.agentId) ?? 0) + 1); return; }
    const now = this.d.now ?? Date.now;
    if (j.event === 'PreToolUse') {
      const key = `${toolClass(j.tool)}\u0000${inputShape(j.input)}`;
      let mine = this.seen.get(j.agentId);
      if (!mine) { mine = new Map(); this.seen.set(j.agentId, mine); }
      if (mine.has(key) || mine.size < MAX_KEYS_PER_AGENT) mine.set(key, (mine.get(key) ?? 0) + 1);
      else this.capped.set(j.agentId, (this.capped.get(j.agentId) ?? 0) + 1);
      if (!mayWrite(j.tool, j.input)) return;
      const tool = toolClass(j.tool);
      for (const o of observeTool(j.tool as string, j.input, a.ctx, BUDGET_MS, now)) {
        if (o.refused) this.emit({ kind: 'write-would-refuse', agentId: j.agentId, tool, via: o.via, pathClass: o.pathClass });
        else this.emit({ kind: 'write-own-settings', agentId: j.agentId, tool, via: o.via });
      }
      return;
    }
    if (j.event === 'Stop' || j.event === 'SessionEnd') { this.flush(j.agentId); return; }
    // A session start: the roots are re-read now, so a settings change between two starts shows as two rows.
    const gen = this.d.generation?.(j.agentId) ?? 0;
    const o = this.ordinal.get(j.agentId);
    const ordinal = o && o.gen === gen ? o.n + 1 : 1;
    this.ordinal.set(j.agentId, { gen, n: ordinal });
    const eff = effectiveRoots(a.provider, a.agentDir, a.ctx.cwd, a.ctx.home, a.launch);
    const start = START_SOURCES.includes(j.source as (typeof START_SOURCES)[number]) ? j.source : 'unknown';
    this.emit({ kind: 'write-roots', agentId: j.agentId, provider: providerClass(a.provider), role: a.ctx.isGod ? 'god' : 'agent', source: eff.source, start, ordinal, coalesced: j.coalesced ?? 1, ...rootsReport(eff, a.ctx) });
  }

  /** The agent's terminal is gone: what it left counted or incomplete is written now, not at a turn end that will not come. */
  agentGone(agentId: string): void {
    try {
      // Its waiting calls (at most a few) are read now, before the flush, so none is lost silently.
      const q = this.queues.get(agentId) ?? [];
      this.queues.delete(agentId);
      this.turn = this.turn.filter((id) => id !== agentId);
      for (const job of q) { try { this.process(job); } catch { /* never let one call stop the rest */ } }
      this.flush(agentId);
    } catch { /* best effort */ }
  }
  /** The app is quitting: calls still waiting are not read now; each agent with some gets an incomplete row saying how
   *  many (reason quit), then everything counted is written. */
  flushAll(): void {
    for (const [agentId, q] of this.queues) {
      const left = q.filter((j) => j.event === 'PreToolUse' || j.event === 'SessionStart').length;
      if (left) this.emit({ kind: 'write-incomplete', agentId, state: 'incomplete', reason: 'quit', shed: left, burst: false });
    }
    const ids = new Set([...this.seen.keys(), ...this.shed.keys(), ...this.capped.keys(), ...this.flood.keys(), ...this.refusedRows.keys(), ...this.noAgent.keys()]);
    this.queues.clear();
    this.turn = [];
    for (const id of ids) { try { this.flush(id); } catch { /* best effort */ } }
  }

  private flush(agentId: string): void {
    this.startsSinceStop.delete(agentId);
    const lost = this.noAgent.get(agentId);
    if (lost) { this.noAgent.delete(agentId); this.emit({ kind: 'write-incomplete', agentId, state: 'incomplete', reason: 'no-agent', shed: lost, burst: false }); }
    const flooded = this.flood.get(agentId);
    if (flooded) {
      this.flood.delete(agentId);
      this.emit({ kind: 'write-incomplete', agentId, state: 'incomplete', reason: 'session-start-flood', shed: flooded, burst: true });
    }
    const mine = this.seen.get(agentId);
    this.seen.delete(agentId);
    for (const [k, count] of mine ?? []) {
      const [tool, shape] = k.split('\u0000');
      this.emit({ kind: 'write-observed', agentId, tool, shape, count });
    }
    const shed = this.shed.get(agentId);
    if (shed) {
      this.shed.delete(agentId);
      this.emit({ kind: 'write-observed', agentId, tool: 'other', shape: 'shed', count: shed });
      // An agent that lost calls is incomplete for this turn, never clean: its burst filled its queue.
      this.emit({ kind: 'write-incomplete', agentId, state: 'incomplete', reason: 'queue', shed, burst: true });
    }
    const capped = this.capped.get(agentId);
    if (capped) {
      this.capped.delete(agentId);
      this.emit({ kind: 'write-incomplete', agentId, state: 'incomplete', reason: 'cap', shed: capped, burst: false });
    }
    const refused = this.refusedRows.get(agentId);
    if (refused) {
      this.refusedRows.delete(agentId);
      const row = { kind: 'write-incomplete', agentId, state: 'incomplete', reason: 'log-refused', shed: refused, burst: false };
      let ok: boolean | void = false;
      try { ok = this.d.record(row); } catch { ok = false; }
      if (ok === false) { try { this.d.logFallback?.({ kind: 'write-rows-refused', agentId, count: refused }); } catch { /* nothing further */ } }
    }
  }
}

/** Every input the dry run reads, who can write it today, and what a planted value does. The test suite runs one case
 *  per row and fails when a row has none; the PR's table is this list. */
export const READ_SITES = [
  { id: 'payload-agent-id', read: 'hook payload agent_id', writer: 'any process that reaches the hook socket', planted: 'an id the app did not spawn, thousands of them', outcome: 'never queued (checked against the spawn record before admission); nothing allocated or recorded' },
  { id: 'attribution', read: 'which agent a call is filed under', writer: 'any process that reaches the hook socket', planted: 'another spawned agent\'s id', outcome: 'filed under that id: attribution is self-reported and this dry run cannot authenticate it (an enforcement-phase item); a flood under a forged id can only shed that id\'s own calls, and shows as incomplete' },
  { id: 'incomplete', read: 'an agent\'s shed calls', writer: 'spawned agents, or a process forging their id', planted: 'a burst past the agent\'s queue', outcome: 'a write-incomplete row (reason queue, shed count, burst) at the turn\'s end: the agent reads incomplete, never clean' },
  { id: 'seen-cap', read: 'the per-agent tool/shape counters', writer: 'spawned agents, or a process forging their id', planted: 'more than 64 distinct tool/shape pairs in one turn', outcome: 'counted per agent (one agent cannot fill another\'s); calls past it give a write-incomplete row (reason cap, count)' },
  { id: 'stop-merge', read: 'a second Stop or SessionEnd waiting in the queue', writer: 'spawned agents', planted: 'repeated turn ends', outcome: 'merged with the one waiting: they flush the same counters, so nothing is lost' },
  { id: 'command-cap', read: 'a command or argv element over 64 KB', writer: 'the agent', planted: 'a very long command', outcome: 'read up to 64 KB, plus one truncated row' },
  { id: 'nested-script-cap', read: 'a shell script nested more than two levels (sh -c inside sh -c inside sh -c)', writer: 'the agent', planted: 'deep nesting', outcome: 'not read past two levels, plus one truncated row' },
  { id: 'patch-cap', read: 'a patch input larger than 256 KB, deeper than 3 levels, or with more than 32 fields', writer: 'the agent', planted: 'an oversized or deeply nested patch input', outcome: 'read up to those limits, plus one truncated row' },
  { id: 'path-length-cap', read: 'any path (edit target, patch line, shell word, argv element) over 4,096 bytes or 256 components', writer: 'the agent', planted: 'an absurdly long or deep path (e.g. 25,000 components)', outcome: 'not canonicalized or classed: counts as a possible write, one truncated row' },
  { id: 'root-path-cap', read: 'a write root (settings, config, --add-dir) over the same bounds', writer: 'whoever wrote that source', planted: 'an absurdly long or deep root', outcome: 'not read: the report is unknown' },
  { id: 'deadline-after-work', read: 'the per-call time budget', writer: 'the agent', planted: 'paths each slow to classify', outcome: 'checked before and after each path; crossing it ends the call with one truncated row' },
  { id: 'session-start', read: 'SessionStart', writer: 'the CLI, or any process that reaches the hook socket', planted: 'repeated starts; a settings change between two starts', outcome: 'every start re-reads the roots and writes a write-roots row (start source, per-spawn ordinal); starts waiting together give one row with coalesced = n; more than 8 between turn ends give write-incomplete (reason session-start-flood)' },
  { id: 'log-identity', read: 'whether a write-* row\'s agent is known to the usage log', writer: 'held in main\'s memory from the spawn', planted: 'the agent removed from registry.json, or the file made unreadable', outcome: 'no effect: write-* rows check the spawn record, never registry.json' },
  { id: 'log-refused', read: 'a row the usage log did not write', writer: 'the app', planted: 'a log that refuses or fails to write', outcome: 'counted per agent and reported as write-incomplete (reason log-refused) at the next flush; if that row too cannot be written, one log.jsonl line (write-rows-refused)' },
  { id: 'no-agent', read: 'an admitted call whose agent can no longer be resolved', writer: 'the app (the hive root going away)', planted: 'a hive root unset mid-run', outcome: 'counted and reported as write-incomplete (reason no-agent)' },
  { id: 'agent-exit-flush', read: 'an agent whose terminal ends, or the app quitting', writer: 'the app', planted: 'a victim that never reaches another turn end; calls still waiting', outcome: 'at exit its waiting calls are read and its counts and incomplete rows written; at quit calls still waiting give write-incomplete (reason quit, count) and counts are written' },
  { id: 'managed-conflict', read: 'sandbox.enabled across the managed file and its drop-ins', writer: 'root only', planted: 'two managed files disagreeing', outcome: 'unknown: Claude\'s order among them is not modelled' },
  { id: 'claude-managed-drop-ins', read: 'managed-settings.d/*.json beside the managed file', writer: 'root only', planted: '—', outcome: 'read like the managed file' },
  { id: 'payload-tool-name', read: 'hook payload tool_name', writer: 'same', planted: 'free text, non-string', outcome: 'logged as a fixed name or other' },
  { id: 'payload-tool-input', read: 'hook payload tool_input', writer: 'same', planted: 'huge command, thousands or deep missing paths, wrong types', outcome: 'answer not delayed; at most 64 paths, 25 ms, 64 KB per call, then one truncated row; wrong types record nothing' },
  { id: 'queue', read: 'the deferred queue, one per agent', writer: 'spawned agents, by calling tools', planted: 'one agent flooding calls', outcome: 'at most 8 tool calls waiting per agent, drained in turn; more are shed and counted for that agent only (see incomplete); Stop and session start are never shed' },
  { id: 'own-folder', read: '<hive>/agents/<id>', writer: 'every agent', planted: 'a link, a file, missing, an id that is not a plain name', outcome: 'no roots; every observation and the report unknown' },
  { id: 'claude-generated-settings', read: 'agents/<id>/settings.json', writer: 'the agent itself', planted: 'link, folder, unreadable, oversized, named pipe, parent is a file, missing', outcome: 'unknown' },
  { id: 'claude-project-settings', read: '<cwd>/.claude/settings(.local).json', writer: 'agents working in that cwd', planted: 'same kinds', outcome: 'unknown; missing is skipped' },
  { id: 'claude-user-settings', read: '~/.claude/settings.json', writer: 'an unsandboxed command', planted: 'same kinds', outcome: 'unknown; missing is skipped' },
  { id: 'claude-managed-settings', read: 'managed-settings.json', writer: 'root only (not plantable by an agent)', planted: '—', outcome: 'read like the others' },
  { id: 'codex-config', read: 'agents/<id>/.codex/config.toml', writer: 'the agent (read-only under Codex\'s own sandbox)', planted: 'same kinds; a profile or unknown sandbox_mode; dotted or inline roots', outcome: 'unknown (full access: unsandboxed)' },
  { id: 'spawn-record', read: 'cwd, provider, role, launch line', writer: 'held in main\'s memory from the spawn', planted: 'not writable from the hive', outcome: 'a relative cwd is none; a provider other than Claude or Codex, or a platform without a sandbox, is unknown' },
  { id: 'codex-prompt', read: 'Codex launch line: the prompt', writer: 'the spawn request', planted: 'flags inside the prompt text', outcome: 'never read: options stop at the first positional' },
  { id: 'codex-sandbox-flag', read: 'Codex -s/--sandbox, --full-auto; with none (auto mode off), the configs\' sandbox_mode', writer: 'the spawn request', planted: 'any mode', outcome: 'workspace-write/read-only ok; danger-full-access unsandboxed; no -s reads the nearest config\'s sandbox_mode the same way, and no mode anywhere is unknown (Codex\'s default is not guessed)' },
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
  { id: 'env-tmpdir', read: 'TMPDIR (both), CLAUDE_CODE_TMPDIR (Claude)', writer: 'the operator\'s environment, or a per-agent override', planted: 'a temp folder inside the hive', outcome: 'counted as a root (the sandbox lets the CLI write its temp folder), classed \'temp\' when outside the hive and by its hive class when inside; relative = unknown' },
  { id: 'launch-executable-name', read: 'the executable\'s name', writer: 'the spawn request', planted: 'another program installed under the name claude or codex', outcome: 'taken to be the CLI: judged by name, the path is not resolved (stated limit)' },
  { id: 'relative-roots', read: 'a relative or ~ root in settings, config or --add-dir', writer: 'whoever wrote that source', planted: 'a relative path, ~/x, a $VAR', outcome: 'resolved the way the spawned CLI resolves it: against the spawn\'s cwd and home, never the app\'s; no cwd or a variable = unknown' },
  { id: 'strict-decoders', read: 'the JSON and TOML decoders', writer: 'whoever wrote the file', planted: 'quoted, dotted, escaped or inline keys, profiles, wrong types, dates and times, non-finite numbers', outcome: 'JSON: JSON.parse and an exact shape check of the keys read; TOML: parsed with smol-toml, then the same exact shape check, and any date, time or non-finite value anywhere is unknown (stricter than Codex on purpose); any other type = unknown' },
  { id: 'launch-wrapper', read: 'the launch line\'s executable', writer: 'the spawn request', planted: 'a wrapper: env X=Y claude, sh -c "...", npx codex', outcome: 'unknown (not a plain provider invocation)' },
  { id: 'env-missing', read: 'the spawn\'s final environment', writer: 'held in main\'s memory from the spawn', planted: 'none recorded', outcome: 'unknown' },
  { id: 'env-home', read: 'HOME in the spawn environment', writer: 'the operator\'s environment, or a per-agent override', planted: 'another home', outcome: 'honoured: user config is read from that home' },
  { id: 'env-claude-config-dir', read: 'CLAUDE_CONFIG_DIR', writer: 'same', planted: 'another folder', outcome: 'honoured: Claude\'s user settings are read from there; not absolute = unknown' },
  { id: 'env-other-provider', read: 'the other provider\'s relocation variables', writer: 'the operator\'s environment', planted: 'CODEX_HOME on a Claude seat; CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME or CLAUDE_CODE_* on a Codex seat', outcome: 'ignored: the launched CLI does not read them' },
  { id: 'env-codex-home', read: 'CODEX_HOME', writer: 'the app (one per Codex agent)', planted: 'another folder', outcome: 'honoured: Codex\'s config is read from there; not absolute = unknown' },
  { id: 'env-xdg-config-home', read: 'XDG_CONFIG_HOME (Claude)', writer: 'the operator\'s environment', planted: 'any value', outcome: 'unknown (Claude reads it; not modelled)' },
  { id: 'env-claude-unmodelled', read: 'CLAUDE_CODE_*SETTINGS/CONFIG/MANAGED/PLUGIN* variables', writer: 'a per-agent override', planted: 'any value', outcome: 'unknown' },
  { id: 'claude-unknown-option', read: 'any other Claude option, or no launch line', writer: 'the spawn request', planted: 'an option not in the grammar', outcome: 'unknown' },
] as const;
