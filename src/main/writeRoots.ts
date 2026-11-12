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
 * What it sees, and what it cannot:
 *  - Edit/Write-style tools, and MCP tools whose name says they write: the target path is in
 *    the tool input, so it is exact.
 *  - A Codex patch: the target files are read from the patch's `*** Add/Update/Delete File:`
 *    lines, in whatever field carries the patch.
 *  - A shell command (a string, or an argv array): paths after a redirect (`>`, `>>`) and the
 *    targets of known writers (`cp`/`ln`/`install`/`rsync` last argument; every argument of
 *    `rm`, `mv`, `touch`, `mkdir`, `tee`, `truncate`, `chmod`, `sed -i`; `dd of=`) count as
 *    writes. Other hive paths it names count apart, as `shell-named` (often a read). The
 *    program a command runs is never counted. `$HIVE_ROOT`, `$AGENT_DIR`, `$HOME` and `~/`
 *    are expanded. Not seen: a path built at run time, a relative path after `cd` (it reads
 *    as the folder it is relative to, usually `hive root`), a write made by a script the
 *    command runs (python, node, a heredoc).
 *  - A command run outside the sandbox is recorded as such, whatever it touches.
 *  - Anything that does not pass through the hook channel (a hookless provider, a process
 *    an agent started in the background) is not seen. The `write-observed` counts per agent,
 *    tool and input shape tell "nothing to refuse" apart from "nothing seen".
 *
 * The roots each session was given are recorded when it starts. For Codex they are read
 * back from its generated config.toml (inherited roots included); for Claude from every
 * settings file the CLI merges (managed, user, project, local and the generated one). A
 * sandbox that is off or absent reads as `unsandboxed`, a form that cannot be read as
 * `unknown`; neither ever reads as scoped. Claude's own built-in writable folders (its temp
 * folders) are outside the hive and not listed. Nothing here enforces anything.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isFolderName } from './messageTarget';
import { TOOL_NAMES } from './usageEvents';

/** Every class a path can be logged as. A name outside this list is never logged. */
export const PATH_CLASSES = [
  'own folder', 'own settings', 'evidence', 'worktree', 'other agent folder', 'agents folder',
  'tasks.json', 'board.md', 'registry.json', 'PROTOCOL.md', 'log.jsonl', 'config', 'bin', 'research',
  'spawn-requests', 'tools', 'skills', 'specs', 'templates', 'hires', 'asks', 'archive', 'backups',
  'assets', '.git', 'hive root', 'hive root (other)', 'contains hive', 'outside hive', 'unsandboxed', 'unknown',
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

export const VIAS = ['edit', 'patch', 'shell-write', 'shell-named', 'shell-unsandboxed'] as const;
export type Via = (typeof VIAS)[number];

/** How a tool call's input was shaped, so a provider whose calls are never read can be spotted. */
export const SHAPES = ['command-string', 'command-array', 'cmd-string', 'cmd-array', 'file-path', 'patch', 'none', 'other'] as const;

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

export interface RootsContext {
  /** The hive root folder. */
  root: string;
  agentId: string;
  isGod: boolean;
  /** The agent's working directory (its worktree). */
  cwd: string;
  /** The user's home, for `~` and `$HOME`; defaults to os.homedir(). */
  home?: string;
}

/** A path with every link in its longest existing prefix resolved, in the disk's own case,
 *  so neither a link nor a case variant can dodge a class. */
export function canonical(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(head), ...tail.reverse()); } catch { /* not on disk yet */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.push(head.slice(up.length).replace(/^[\\/]+/, ''));
    head = up;
  }
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The agent's own folder, or null for an id that is not a plain folder name ('..', 'a/b'). */
function ownFolder(ctx: RootsContext, root: string): string | null {
  return isFolderName(ctx.agentId) ? canonical(join(root, 'agents', ctx.agentId)) : null;
}

/** The folders the role may write under scoped roots. An id that is not a folder name gets none. */
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
  const cwd = ctx.cwd ? canonical(ctx.cwd) : '';
  if (cwd && !within(cwd, root) && !within(root, cwd)) roots.push(cwd);
  return [...new Set(roots)];
}

function absolute(p: string, ctx: RootsContext): string {
  return canonical(isAbsolute(p) ? p : join(ctx.cwd || ctx.root, p));
}

/** The class of one path, relative to this agent. Never throws. */
export function pathClass(p: string, ctx: RootsContext): PathClass {
  if (typeof p !== 'string' || !p) return 'unknown';
  const root = canonical(ctx.root);
  const abs = absolute(p, ctx);
  const cwd = ctx.cwd ? canonical(ctx.cwd) : '';
  if (!within(abs, root)) {
    if (within(root, abs)) return 'contains hive';
    return cwd && !within(root, cwd) && within(abs, cwd) ? 'worktree' : 'outside hive';
  }
  if (abs === root) return 'hive root';
  const own = ownFolder(ctx, root);
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

const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'nice', 'builtin']);
const ALL_ARGS = new Set(['rm', 'rmdir', 'mv', 'touch', 'mkdir', 'tee', 'truncate', 'chmod', 'chown', 'unlink', 'shred']);
const LAST_ARG = new Set(['cp', 'ln', 'install', 'rsync']);

/** Each word's role in one simple command: the program (never counted), a write target, or another argument. */
function roles(words: string[], redirects: string[]): Array<{ word: string; write: boolean }> {
  const out = redirects.map((word) => ({ word, write: true }));
  let i = 0;
  while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || WRAPPERS.has(basename(words[i])))) i++;
  if (i >= words.length) return out;
  const prog = basename(words[i]);
  const args = words.slice(i + 1);
  const plain = args.filter((a) => !a.startsWith('-'));
  const sedInPlace = prog === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'));
  args.forEach((a) => {
    let write = false;
    if (ALL_ARGS.has(prog)) write = !a.startsWith('-');
    else if (LAST_ARG.has(prog)) write = a === plain[plain.length - 1];
    else if (sedInPlace) write = !a.startsWith('-') && a !== plain[0];
    else if (prog === 'dd') write = a.startsWith('of=');
    out.push({ word: a, write });
  });
  return out;
}

/** The hive paths a shell command names, and whether each is a write target. */
export function shellPaths(command: unknown, ctx: RootsContext): Array<{ path: string; write: boolean }> {
  const home = ctx.home ?? homedir();
  const agentDir = join(ctx.root, 'agents', ctx.agentId);
  const expand = (w: string): string => w
    .replace(/\$\{?HIVE_ROOT\}?/g, ctx.root).replace(/\$\{?AGENT_DIR\}?/g, agentDir).replace(/\$\{?HOME\}?/g, home)
    .replace(/^~(?=\/|$)/, home).replace(/^(\w+=|--[\w-]+=)~(?=\/)/, `$1${home}`);
  const segments: Array<{ words: string[]; redirects: string[] }> = [];
  if (Array.isArray(command)) {
    if (!command.every((w) => typeof w === 'string')) return [];
    segments.push({ words: command.map(expand), redirects: [] });
  } else if (typeof command === 'string') {
    let cur = { words: [] as string[], redirects: [] as string[] };
    let redirect = false;
    for (const t of lex(command)) {
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
  const out: Array<{ path: string; write: boolean }> = [];
  for (const s of segments) {
    for (const { word, write } of roles(s.words, s.redirects)) {
      const at = bases.map((b) => word.indexOf(b)).filter((n) => n !== -1).sort((a, b) => a - b)[0];
      if (at !== undefined) out.push({ path: word.slice(at), write });
    }
  }
  return out;
}

/** File paths named by `*** Add File:` / `*** Update File:` / `*** Delete File:` / `*** Move to:` lines. */
export function patchPaths(input: unknown): string[] {
  const out: string[] = [];
  const scan = (v: unknown, depth: number): void => {
    if (depth > 3) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)) out.push(m[1].trim());
    } else if (v && typeof v === 'object') {
      for (const x of Object.values(v as Record<string, unknown>)) scan(x, depth + 1);
    }
  };
  scan(input, 0);
  return out;
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

/** Cheap check, before any lookup: could this call write a file at all? */
export function mayWrite(tool: unknown, input: unknown): boolean {
  if (typeof tool !== 'string') return false;
  if (EDIT_TOOLS.has(tool) || MCP_WRITE.test(tool)) return true;
  const r = rec(input);
  return r.command !== undefined || r.cmd !== undefined || patchPaths(input).length > 0;
}

export interface ToolObservation { via: Via; pathClass: PathClass; refused: boolean }

/** What one tool call would write: the writes scoped roots would refuse, and writes to the
 *  agent's own settings (allowed, but the control plane is to move out of the hive). */
export function observeTool(tool: string, input: unknown, ctx: RootsContext): ToolObservation[] {
  const r = rec(input);
  const out: ToolObservation[] = [];
  const add = (via: Via, p: string): void => {
    if (typeof p !== 'string' || !p) return;
    const refused = wouldRefuse(p, ctx);
    const cls = pathClass(p, ctx);
    if (refused || (cls === 'own settings' && via !== 'shell-named')) out.push({ via, pathClass: cls, refused });
  };
  if (EDIT_TOOLS.has(tool) || MCP_WRITE.test(tool)) {
    for (const k of PATH_FIELDS) if (typeof r[k] === 'string') add('edit', r[k] as string);
    return out;
  }
  const patched = patchPaths(input);
  if (patched.length) {
    for (const p of patched) add('patch', p);
    return out;
  }
  const command = r.command !== undefined ? r.command : r.cmd;
  if (command === undefined) return out;
  if (r.dangerouslyDisableSandbox === true) out.push({ via: 'shell-unsandboxed', pathClass: 'unknown', refused: true });
  for (const { path, write } of shellPaths(command, ctx)) add(write ? 'shell-write' : 'shell-named', path);
  return out;
}

// --- effective roots ---

export type RootsState = 'ok' | 'unsandboxed' | 'unknown';
export interface EffectiveRoots { roots: string[]; state: RootsState; source: 'claude-settings-files' | 'codex-config' }

/** Codex writable_roots and sandbox mode from a config.toml. */
export function codexRoots(toml: string): { roots: string[]; state: RootsState } {
  const lines = toml.split('\n');
  const firstHeader = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = firstHeader === -1 ? lines : lines.slice(0, firstHeader);
  const mode = top.map((l) => /^\s*sandbox_mode\s*=\s*"([^"]*)"/.exec(l)).find(Boolean);
  if (mode && mode[1] === 'danger-full-access') return { roots: [], state: 'unsandboxed' };
  // A table given by a dotted key or inline cannot be read here; never guess it is narrow.
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

function readText(file: string): string | null {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : null; } catch { return null; }
}

/** The roots a session was given, read back from the settings files on disk, plus its cwd. */
export function effectiveRoots(provider: string, agentDir: string, cwd: string, home: string = homedir()): EffectiveRoots {
  const withCwd = (roots: string[]): string[] => [...new Set([...roots, ...(cwd ? [cwd] : [])])];
  if (provider === 'codex') {
    const text = readText(join(agentDir, '.codex', 'config.toml'));
    if (text === null) return { roots: withCwd([]), state: 'unknown', source: 'codex-config' };
    const c = codexRoots(text);
    return { roots: withCwd(c.roots), state: c.state, source: 'codex-config' };
  }
  // Highest precedence first; the generated file is passed with --settings. Directories merge across files.
  const files = [MANAGED, join(agentDir, 'settings.json'), ...(cwd ? [join(cwd, '.claude', 'settings.local.json'), join(cwd, '.claude', 'settings.json')] : []), join(home, '.claude', 'settings.json')];
  const roots: string[] = [];
  let enabled: boolean | undefined;
  let generatedSeen = false;
  for (const f of files) {
    const text = readText(f);
    if (text === null) continue;
    const c = claudeRoots(text);
    if (!c) return { roots: withCwd(roots), state: 'unknown', source: 'claude-settings-files' };
    if (f === join(agentDir, 'settings.json')) generatedSeen = true;
    roots.push(...c.roots);
    if (enabled === undefined && c.enabled !== undefined) enabled = c.enabled;
  }
  if (!generatedSeen) return { roots: withCwd(roots), state: 'unknown', source: 'claude-settings-files' };
  return { roots: withCwd(roots), state: enabled === true ? 'ok' : 'unsandboxed', source: 'claude-settings-files' };
}

/** The classes of the effective roots, and of those the scoped roots would not grant. */
export function rootsReport(eff: EffectiveRoots, ctx: RootsContext): { effective: PathClass[]; excess: PathClass[] } {
  if (eff.state !== 'ok') return { effective: [eff.state], excess: [eff.state] };
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
}

// --- the observer ---

export interface DryRunAgent { ctx: RootsContext; provider: string; agentDir: string }
export interface DryRunDeps {
  /** The agent's roots context, or null for an id the app does not hold. */
  agent(agentId: string): DryRunAgent | null;
  record(event: Record<string, unknown>): void;
}

const MAX_COUNTERS = 2000;

/** Records, from the hook channel, what scoped roots would have refused. Observes only: never throws, never decides. */
export class WriteRootsDryRun {
  /** Tool calls seen per agent, tool and input shape since that agent's last Stop. */
  private seen = new Map<string, number>();

  constructor(private readonly d: DryRunDeps) {}

  onHook(agentId: string | undefined, event: string, p: { tool_name?: unknown; tool_input?: unknown }): void {
    try {
      if (!agentId) return;
      if (event === 'PreToolUse') {
        const key = `${agentId}\u0000${toolClass(p.tool_name)}\u0000${inputShape(p.tool_input)}`;
        if (this.seen.has(key) || this.seen.size < MAX_COUNTERS) this.seen.set(key, (this.seen.get(key) ?? 0) + 1);
        if (!mayWrite(p.tool_name, p.tool_input)) return;
        const a = this.d.agent(agentId);
        if (!a) return;
        const tool = toolClass(p.tool_name);
        for (const o of observeTool(p.tool_name as string, p.tool_input, a.ctx)) {
          if (o.refused) this.d.record({ kind: 'write-would-refuse', agentId, tool, via: o.via, pathClass: o.pathClass });
          else this.d.record({ kind: 'write-own-settings', agentId, tool, via: o.via });
        }
        return;
      }
      if (event === 'Stop' || event === 'SessionEnd') { this.flush(agentId); return; }
      if (event === 'SessionStart') {
        const a = this.d.agent(agentId);
        if (!a) return;
        const eff = effectiveRoots(a.provider, a.agentDir, a.ctx.cwd, a.ctx.home);
        this.d.record({ kind: 'write-roots', agentId, provider: providerClass(a.provider), role: a.ctx.isGod ? 'god' : 'agent', source: eff.source, ...rootsReport(eff, a.ctx) });
      }
    } catch { /* a dry run must never disturb the hook it rides on */ }
  }

  private flush(agentId: string): void {
    const prefix = `${agentId}\u0000`;
    const rows = [...this.seen].filter(([k]) => k.startsWith(prefix));
    for (const [k] of rows) this.seen.delete(k);
    if (!rows.length || !this.d.agent(agentId)) return;
    for (const [k, count] of rows) {
      const [, tool, shape] = k.split('\u0000');
      this.d.record({ kind: 'write-observed', agentId, tool, shape, count });
    }
  }
}
