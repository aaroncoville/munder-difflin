/**
 * Scoped write roots, in dry run.
 *
 * Every sandboxed agent may write the whole hive folder today, so any agent can rewrite
 * another agent's mail, settings, or the hook shim every session runs. The fix is to give
 * each agent only the folders its role needs: god keeps the hive root (it alone writes the
 * task list, the board and the hive config); every other agent gets its own folder, the
 * shared `evidence/` folder and its working directory.
 *
 * Narrowing the roots blind would break agents that write shared files today, so this
 * runs first as a dry run: the real sandbox settings are left exactly as they are, and
 * every write the scoped roots WOULD have refused is recorded, as an agent id, a tool and
 * a path CLASS (`tasks.json`, `other agent folder`, `bin` ...), never a path or contents.
 *
 * What it sees, and what it cannot:
 *  - Edit/Write-style tools: the target path is in the tool input, so it is exact.
 *  - A Codex patch: the target files are read from the patch's `*** Add/Update/Delete File:`
 *    lines, in whatever field carries the patch.
 *  - A shell command: the path it writes is not knowable from the command line. The dry run
 *    records hive paths the command NAMES outside the scoped roots (absolute, or through
 *    $HIVE_ROOT / $AGENT_DIR), which over-counts (a read names a path too) and misses paths a
 *    command builds at run time or reaches relatively. A command run outside the sandbox
 *    is recorded as such, whatever it touches.
 *  - Anything that does not pass through the hook channel (a hookless provider, a process
 *    an agent started in the background) is not seen at all.
 *
 * The effective roots each session was actually given are also recorded when it starts,
 * read back from the generated settings on disk rather than from what the app meant to
 * write, so roots inherited from user config or added for a working directory show up.
 * Pure apart from the reads in effectiveRoots(); nothing here enforces anything.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

/** Every class a path can be logged as. A name outside this list is never logged. */
export const PATH_CLASSES = [
  'own folder', 'own settings', 'evidence', 'worktree', 'other agent folder', 'agents folder',
  'tasks.json', 'board.md', 'registry.json', 'PROTOCOL.md', 'log.jsonl', 'config', 'bin', 'research',
  'spawn-requests', 'tools', 'skills', 'specs', 'templates', 'hires', 'asks', 'archive', 'backups',
  'assets', '.git', 'hive root', 'hive root (other)', 'contains hive', 'outside hive', 'unknown',
] as const;
export type PathClass = (typeof PATH_CLASSES)[number];

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
}

/** A path with every link in its longest existing prefix resolved, so a link cannot dodge a class. */
export function canonical(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...tail.reverse()); } catch { /* not on disk yet */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    tail.push(head.slice(up.length).replace(/^[\\/]+/, ''));
    head = up;
  }
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** The folders the role may write under scoped roots. */
export function scopedRoots(ctx: RootsContext): string[] {
  const root = canonical(ctx.root);
  const roots = ctx.isGod ? [root] : [join(root, 'agents', ctx.agentId), join(root, 'evidence')];
  // A working directory that holds the hive would grant all of it, so it is never a scoped root.
  if (ctx.cwd && !within(root, canonical(ctx.cwd))) roots.push(canonical(ctx.cwd));
  return [...new Set(roots)];
}

/** The class of one path, relative to this agent. Never throws. */
export function pathClass(p: string, ctx: RootsContext): PathClass {
  if (typeof p !== 'string' || !p) return 'unknown';
  const root = canonical(ctx.root);
  const abs = canonical(isAbsolute(p) ? p : join(ctx.cwd || root, p));
  if (!within(abs, root)) {
    if (within(root, abs)) return 'contains hive';
    return ctx.cwd && within(abs, canonical(ctx.cwd)) ? 'worktree' : 'outside hive';
  }
  if (abs === root) return 'hive root';
  const parts = abs.slice(root.length + 1).split(sep);
  if (parts[0] === 'agents') {
    if (parts.length === 1) return 'agents folder';
    if (parts[1] !== ctx.agentId) return 'other agent folder';
    const own = join(root, 'agents', ctx.agentId);
    const cwd = ctx.cwd ? canonical(ctx.cwd) : '';
    if (cwd && cwd !== own && within(cwd, own) && within(abs, cwd)) return 'worktree';
    return parts[2] === 'settings.json' || parts[2] === '.codex' ? 'own settings' : 'own folder';
  }
  return Object.hasOwn(TOP, parts[0]) ? TOP[parts[0]] : 'hive root (other)';
}

/** True when the scoped roots would refuse a write to this path that today's broad roots allow. */
export function wouldRefuse(p: string, ctx: RootsContext): boolean {
  if (typeof p !== 'string' || !p) return false;
  const abs = canonical(isAbsolute(p) ? p : join(ctx.cwd || ctx.root, p));
  if (!within(abs, canonical(ctx.root))) return false; // outside the hive the roots do not change
  return !scopedRoots(ctx).some((r) => within(abs, r));
}

/** Absolute hive paths a command line names, directly or through $HIVE_ROOT / $AGENT_DIR. */
export function namedHivePaths(command: string, ctx: RootsContext): string[] {
  if (typeof command !== 'string') return [];
  const agentDir = join(ctx.root, 'agents', ctx.agentId);
  const text = command
    .replace(/\$\{?HIVE_ROOT\}?/g, ctx.root)
    .replace(/\$\{?AGENT_DIR\}?/g, agentDir);
  const out: string[] = [];
  for (const base of new Set([ctx.root, canonical(ctx.root)])) {
    let i = text.indexOf(base);
    while (i !== -1) {
      const m = /^[^\s'"`;|&<>()]*/.exec(text.slice(i));
      if (m && m[0]) out.push(m[0]);
      i = text.indexOf(base, i + base.length);
    }
  }
  return [...new Set(out)];
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

export interface ToolObservation { via: 'edit' | 'patch' | 'shell-named' | 'shell-unsandboxed'; pathClass: PathClass }

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** The writes one tool call would have had refused under scoped roots. */
export function observeTool(tool: string, input: unknown, ctx: RootsContext): ToolObservation[] {
  const rec = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: ToolObservation[] = [];
  const add = (via: ToolObservation['via'], p: string): void => {
    if (wouldRefuse(p, ctx)) out.push({ via, pathClass: pathClass(p, ctx) });
  };
  if (EDIT_TOOLS.has(tool)) {
    const p = typeof rec.file_path === 'string' ? rec.file_path : typeof rec.notebook_path === 'string' ? rec.notebook_path : '';
    if (p) add('edit', p);
    return out;
  }
  const patched = patchPaths(input);
  if (patched.length) {
    for (const p of patched) add('patch', p);
    return out;
  }
  const command = typeof rec.command === 'string' ? rec.command : typeof rec.cmd === 'string' ? rec.cmd : null;
  if (command === null) return out;
  if (rec.dangerouslyDisableSandbox === true) out.push({ via: 'shell-unsandboxed', pathClass: 'unknown' });
  for (const p of namedHivePaths(command, ctx)) add('shell-named', p);
  return out;
}

/** writable_roots in a Codex config.toml, or null when the file cannot be read as such. */
export function codexRoots(toml: string): string[] | null {
  const lines = toml.split('\n');
  const header = lines.findIndex((l) => /^\s*\[\s*sandbox_workspace_write\s*\]\s*(#.*)?$/.test(l));
  if (header === -1) return [];
  let i = header + 1;
  for (; i < lines.length && !/^\s*\[[^\]"]*\]\s*(#.*)?$/.test(lines[i]); i++) {
    const m = /^\s*writable_roots\s*=\s*(\[.*)$/.exec(lines[i]);
    if (!m) continue;
    let text = m[1];
    while (!/\]\s*(#.*)?$/.test(text) && i + 1 < lines.length) text += lines[++i];
    try {
      const v = JSON.parse(text.replace(/#.*$/, '').replace(/,\s*\]/, ']')) as unknown;
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
    } catch { return null; }
  }
  return [];
}

/** writable dirs in a Claude settings.json, or null when the file cannot be read as such. */
export function claudeRoots(json: string): string[] | null {
  try {
    const v = JSON.parse(json) as { sandbox?: { filesystem?: { allowWrite?: unknown } }; permissions?: { additionalDirectories?: unknown } };
    const a = v?.sandbox?.filesystem?.allowWrite ?? [];
    const b = v?.permissions?.additionalDirectories ?? [];
    if (!Array.isArray(a) || !Array.isArray(b) || ![...a, ...b].every((x) => typeof x === 'string')) return null;
    return [...a, ...b] as string[];
  } catch { return null; }
}

export interface EffectiveRoots { roots: string[]; readable: boolean }

/** The roots a session was given, read back from its generated settings, plus its cwd. */
export function effectiveRoots(provider: string, agentDir: string, cwd: string): EffectiveRoots {
  const file = provider === 'codex' ? join(agentDir, '.codex', 'config.toml') : join(agentDir, 'settings.json');
  let text: string | null = null;
  try { text = existsSync(file) ? readFileSync(file, 'utf8') : null; } catch { text = null; }
  const parsed = text === null ? null : provider === 'codex' ? codexRoots(text) : claudeRoots(text);
  const roots = [...(parsed ?? []), ...(cwd ? [cwd] : [])];
  return { roots: [...new Set(roots)], readable: parsed !== null };
}

/** The classes of the effective roots, and of those the scoped roots would not grant. */
export function rootsReport(eff: EffectiveRoots, ctx: RootsContext): { effective: PathClass[]; excess: PathClass[] } {
  const scoped = scopedRoots(ctx);
  const effective = new Set<PathClass>(eff.readable ? [] : ['unknown']);
  const excess = new Set<PathClass>(eff.readable ? [] : ['unknown']);
  for (const r of eff.roots) {
    const abs = canonical(r);
    const cls = pathClass(abs, ctx);
    effective.add(cls);
    // A root that CONTAINS a scoped root grants more than it; one inside a scoped root grants nothing extra.
    if (!scoped.some((s) => within(abs, s))) excess.add(cls);
  }
  return { effective: [...effective], excess: [...excess] };
}

export interface DryRunAgent { ctx: RootsContext; provider: string; agentDir: string }
export interface DryRunDeps {
  /** The agent's roots context, or null for an id the app does not hold. */
  agent(agentId: string): DryRunAgent | null;
  record(event: Record<string, unknown>): void;
}

/** Records, from the hook channel, what scoped roots would have refused. Observes only: never throws, never decides. */
export class WriteRootsDryRun {
  constructor(private readonly d: DryRunDeps) {}

  onHook(agentId: string | undefined, event: string, p: { tool_name?: unknown; tool_input?: unknown }): void {
    try {
      if (!agentId || (event !== 'SessionStart' && event !== 'PreToolUse')) return;
      const a = this.d.agent(agentId);
      if (!a) return;
      if (event === 'SessionStart') {
        const report = rootsReport(effectiveRoots(a.provider, a.agentDir, a.ctx.cwd), a.ctx);
        this.d.record({ kind: 'write-roots', agentId, provider: a.provider, role: a.ctx.isGod ? 'god' : 'agent', ...report });
        return;
      }
      const tool = typeof p.tool_name === 'string' ? p.tool_name : '';
      if (!tool) return;
      for (const o of observeTool(tool, p.tool_input, a.ctx)) this.d.record({ kind: 'write-would-refuse', agentId, tool, ...o });
    } catch { /* a dry run must never disturb the hook it rides on */ }
  }
}
