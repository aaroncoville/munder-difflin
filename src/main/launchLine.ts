/**
 * How a provider CLI is launched, read the way the CLI reads it: the launch line with each CLI's own option grammar
 * (up to the first positional, so a prompt is never read) and the environment variables that move where it looks
 * for its configuration. Shared by the write-roots dry run and the hook-runtime spawn check, so both read a launch
 * the same way. Anything not modelled is `unknown`; nothing here guesses.
 */
import { basename, isAbsolute, join, resolve } from 'node:path';

/** Environment variables that move where a provider reads configuration or write roots. Only these are recorded from a spawn. */
export const RELOCATING_ENV = ['HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'TMPDIR', 'CLAUDE_CODE_TMPDIR'] as const;
/** Claude's own variables that point it at other settings, config or plugins: not modelled, so unknown. */
const CLAUDE_UNMODELLED_ENV = /^CLAUDE_CODE_(?!TMPDIR$)[A-Z0-9_]*(SETTINGS|CONFIG|MANAGED|PLUGIN)/;

/** The relocation-relevant part of a spawn's final environment: the variables above, plus any unmodelled Claude one (by name). */
export function relocationEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v !== 'string') continue;
    if ((RELOCATING_ENV as readonly string[]).includes(k)) out[k] = v;
    else if (CLAUDE_UNMODELLED_ENV.test(k)) out[k] = '';
  }
  return out;
}

/** 'claude' / 'codex' when the launch line's executable is that CLI itself, else null (a wrapper such as env, sh -c, npx).
 *  Judged by the executable's name, not by resolving the path: a different program installed under the name claude or
 *  codex is taken to be the CLI. */
export function launchExecutable(args: string[] | undefined): 'claude' | 'codex' | null {
  const first = Array.isArray(args) && typeof args[0] === 'string' ? args[0].trim().split(/\s+/)[0] ?? '' : '';
  const b = basename(first);
  return b === 'claude' || b === 'codex' ? b : null;
}

export type Places = { home: string; claudeUserDir: string; codexHome: string; /** Temp folders the CLI's sandbox lets it write. */ tmpDirs: string[] } | { unknown: string };

/** Where this provider will read its user configuration, given the final spawn environment; or what made it unknown. */
export function launchPlaces(provider: string, env: Record<string, string> | undefined, appHome: string): Places {
  if (!env) return { unknown: 'no spawn environment recorded' };
  const home = env.HOME ?? appHome;
  if (!isAbsolute(home)) return { unknown: 'HOME is not an absolute path' };
  if (provider === 'claude') {
    if (env.XDG_CONFIG_HOME !== undefined) return { unknown: 'XDG_CONFIG_HOME is set' };
    const odd = Object.keys(env).find((k) => CLAUDE_UNMODELLED_ENV.test(k));
    if (odd) return { unknown: `${odd} is set` };
  }
  const cfg = env.CLAUDE_CONFIG_DIR;
  if (cfg !== undefined && !isAbsolute(cfg)) return { unknown: 'CLAUDE_CONFIG_DIR is not an absolute path' };
  const ch = env.CODEX_HOME;
  if (ch !== undefined && !isAbsolute(ch)) return { unknown: 'CODEX_HOME is not an absolute path' };
  const tmpDirs: string[] = [];
  for (const k of provider === 'claude' ? ['TMPDIR', 'CLAUDE_CODE_TMPDIR'] : ['TMPDIR']) {
    const v = env[k];
    if (v === undefined) continue;
    if (!isAbsolute(v)) return { unknown: `${k} is not an absolute path` };
    tmpDirs.push(v);
  }
  return { home, claudeUserDir: cfg ?? join(home, '.claude'), codexHome: ch ?? join(home, '.codex'), tmpDirs };
}

/** Codex options that take a value (the next argument, or `--name=value`). */
const CODEX_VALUE_OPTS = new Set(['-a', '--ask-for-approval', '-s', '--sandbox', '-m', '--model', '-c', '--config', '-p', '--profile',
  '--add-dir', '--remote', '--remote-auth-token-env', '--enable', '--disable', '--local-provider']);
/** Codex options that take no value and do not change the sandbox or the folder it runs in. */
const CODEX_FLAGS = new Set(['--strict-config', '--oss', '--approve-for-me', '--dangerously-bypass-hook-trust', '--search', '--no-alt-screen',
  '--no-daemon', '-h', '--help', '-V', '--version']);

/** How Codex's sandbox was chosen on the launch line the app spawned: the executable's own words
 *  (from the command string) followed by the argv as given, each argument whole. Options are read
 *  up to the first argument that is neither an option nor an option's value (the prompt is never
 *  read). Anything that could change the sandbox in a way not read here is `unknown`: a `-c` on a
 *  sandbox key, a profile, a remote app server (its own policy is in force), or an option this
 *  grammar does not know. `--add-dir` directories are collected as roots. 'none' when no option says. */
export function codexLaunchSandbox(args: string[] | undefined, addDirs: string[] = []): 'workspace-write' | 'read-only' | 'danger-full-access' | 'none' | 'unknown' {
  const a = (args ?? []).filter((x): x is string => typeof x === 'string');
  // The first element is the command string, split into its words; the rest are argv elements, whole.
  const words = [...(a[0] ?? '').trim().split(/\s+/).filter(Boolean), ...a.slice(1)];
  let mode: string | null = null;
  let i = 1; // words[0] is the executable
  if (words[i] === 'resume') i += 2; // `resume <session id>`
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--' || !w.startsWith('-')) {
      // The prompt (or '--'): Codex still reads options after it, so anything further is not modelled.
      if (i + 1 < words.length) return 'unknown';
      break;
    }
    const eq = w.indexOf('=');
    const name = w.startsWith('--') && eq !== -1 ? w.slice(0, eq) : w;
    const value = w.startsWith('--') && eq !== -1 ? w.slice(eq + 1) : null;
    if (name === '--dangerously-bypass-approvals-and-sandbox' || name === '--yolo') return 'danger-full-access';
    if (name === '--full-auto') { mode = 'workspace-write'; continue; }
    if (CODEX_FLAGS.has(name) && value === null) continue;
    // Anything else (-C/--cd and --worktree move the session's folder, -i takes several values, a new flag may change
    // the sandbox) is not modelled.
    if (!CODEX_VALUE_OPTS.has(name)) return 'unknown';
    const v = value ?? words[++i];
    if (v === undefined) return 'unknown';
    if (name === '-s' || name === '--sandbox') mode = v;
    else if ((name === '-c' || name === '--config') && /^\s*"?(sandbox_mode|sandbox_workspace_write|profile)\b/.test(v)) return 'unknown';
    else if (name === '--add-dir') addDirs.push(v);
    else if (name === '-p' || name === '--profile' || name === '--remote') return 'unknown';
  }
  if (mode === null) return 'none';
  return mode === 'workspace-write' || mode === 'read-only' || mode === 'danger-full-access' ? mode : 'unknown';
}

const CLAUDE_VALUE_OPTS = new Set(['--agent', '--agents', '--append-system-prompt', '--autocompact', '--debug-file', '--effort', '--environment',
  '--fallback-model', '--input-format', '--json-schema', '--max-budget-usd', '--model', '-n', '--name', '--output-format', '--permission-mode',
  '--permission-prompts', '--remote-control-session-name-prefix', '--session-id', '--system-prompt',
  '--system-prompt-snapshot', '--settings']);
const CLAUDE_VARIADIC_OPTS = new Set(['--add-dir', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--betas',
  '--file', '--mcp-config', '--tools']);
const CLAUDE_FLAGS = new Set(['--allow-dangerously-skip-permissions', '--ax-screen-reader', '--bg', '--background', '--brief', '--chrome', '-c',
  '--continue', '--dangerously-skip-permissions', '--desktop', '--disable-slash-commands', '--exclude-dynamic-system-prompt-sections',
  '--fork-session', '--forward-subagent-text', '-h', '--help', '--ide', '--include-hook-events', '--include-partial-messages', '--no-chrome',
  '--no-session-persistence', '-p', '--print', '--replay-user-messages', '--strict-mcp-config', '--verbose', '-v', '--version', '--tmux']);
/** Claude's launch line as the app spawned it, read with the CLI's option grammar up to the first positional (the prompt
 *  is never read): `--add-dir` directories are collected as roots; a `--settings` other than the generated file, an
 *  option that changes where settings come from or the folder it runs in (--setting-sources, --bare, --safe-mode,
 *  --restricted, --worktree, --debug's optional value ...), or any other option the grammar does not know, is `unknown`. */
export function claudeLaunch(args: string[] | undefined, generatedSettings: string, addDirs: string[] = []): 'ok' | 'unknown' {
  if (!Array.isArray(args) || args.length === 0) return 'unknown'; // no launch line recorded: nothing to read it from
  const a = args.filter((x): x is string => typeof x === 'string');
  const words = [...(a[0] ?? '').trim().split(/\s+/).filter(Boolean), ...a.slice(1)];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--' || !w.startsWith('-')) {
      // The prompt (or '--'): Claude still reads options after it, so anything further is not modelled.
      if (i + 1 < words.length) return 'unknown';
      break;
    }
    const eq = w.indexOf('=');
    const name = w.startsWith('--') && eq !== -1 ? w.slice(0, eq) : w;
    const inline = w.startsWith('--') && eq !== -1 ? w.slice(eq + 1) : null;
    if (CLAUDE_FLAGS.has(name)) { if (inline !== null) return 'unknown'; continue; }
    if (name === '-r' || name === '--resume') { if (inline === null && words[i + 1] !== undefined && !words[i + 1].startsWith('-')) i++; continue; }
    if (CLAUDE_VALUE_OPTS.has(name)) {
      const v = inline ?? words[++i];
      if (v === undefined) return 'unknown';
      if (name === '--settings' && resolve(v) !== resolve(generatedSettings)) return 'unknown';
      continue;
    }
    if (CLAUDE_VARIADIC_OPTS.has(name)) {
      const vals = inline !== null ? [inline] : [];
      while (inline === null && i + 1 < words.length && !words[i + 1].startsWith('-')) vals.push(words[++i]);
      if (!vals.length) return 'unknown';
      if (name === '--add-dir') addDirs.push(...vals);
      continue;
    }
    return 'unknown';
  }
  return 'ok';
}

/** TOML text without comments: a '#' outside a string, and what follows it on the line. */
export function stripTomlComments(text: string): string {
  return text.split('\n').map((line) => {
    let q: string | null = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '\\' && q === '"') i++; else if (c === q) q = null; } else if (c === '"' || c === "'") q = c; else if (c === '#') return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

/** A plain JSON object (not null, not an array). */
export const isPlainObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** A JSON value that must be an array of strings when present. */
export const stringList = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string');

export type RootsState = 'ok' | 'unsandboxed' | 'unknown';

/** The keys that decide a Codex sandbox. Each occurrence must be one the decoder below consumed in its exact plain form. */
const CODEX_POLICY_KEYS = ['writable_roots', 'sandbox_mode', 'sandbox_workspace_write', 'profile'] as const;

/** Codex writable_roots and sandbox mode from a config.toml, read without a TOML parser by the conservative rule:
 *  only a top-level `sandbox_mode = "..."`, a bare `[sandbox_workspace_write]` header and one `writable_roots = [...]`
 *  under it are read. If, after comments are removed, any of those keys (or `profile`) appears anywhere the decoder did
 *  not consume it (a quoted or dotted key, an inline table, a profile, a duplicate, another form), the file is unknown. */
export function codexRoots(toml: string): { roots: string[]; state: RootsState } {
  const unknown = { roots: [], state: 'unknown' as const };
  const text = stripTomlComments(toml);
  const lines = text.split('\n');
  const consumed: Record<string, number> = { writable_roots: 0, sandbox_mode: 0, sandbox_workspace_write: 0, profile: 0 };
  let section = '';
  let mode: string | null = null;
  let roots: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const header = /^\s*\[\s*([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)\s*\]\s*$/.exec(l);
    if (header) { section = header[1]; if (section === 'sandbox_workspace_write') consumed.sandbox_workspace_write++; continue; }
    if (section === '') {
      const m = /^\s*sandbox_mode\s*=\s*"([^"\\]*)"\s*$/.exec(l);
      if (m) { mode = m[1]; consumed.sandbox_mode++; continue; }
    }
    if (section === 'sandbox_workspace_write') {
      const m = /^\s*writable_roots\s*=\s*(\[.*)$/.exec(l);
      if (m) {
        let arr = m[1];
        while (!/\]\s*$/.test(arr) && i + 1 < lines.length) arr += '\n' + lines[++i];
        let v: unknown;
        try { v = JSON.parse(arr.replace(/,\s*\]\s*$/, ']')); } catch { return unknown; }
        if (!stringList(v) || roots !== null) return unknown;
        roots = v;
        consumed.writable_roots++;
        continue;
      }
    }
  }
  for (const k of CODEX_POLICY_KEYS) if ((text.match(new RegExp(k, 'g')) ?? []).length !== consumed[k]) return unknown;
  if (consumed.sandbox_workspace_write > 1 || consumed.sandbox_mode > 1) return unknown;
  if (mode === 'danger-full-access') return { roots: [], state: 'unsandboxed' };
  if (mode !== null && mode !== 'workspace-write' && mode !== 'read-only') return unknown;
  return { roots: roots ?? [], state: 'ok' };
}

/** Writable dirs in one Claude settings file; `enabled` is its sandbox.enabled, if it says. JSON.parse, then an exact
 *  shape check of the keys read: any other type at those keys (or at the objects holding them) is null (unknown). */
export function claudeRoots(json: string): { roots: string[]; enabled: boolean | undefined } | null {
  let v: unknown;
  try { v = JSON.parse(json); } catch { return null; }
  if (!isPlainObject(v)) return null;
  const roots: string[] = [];
  let enabled: boolean | undefined;
  if (Object.hasOwn(v, 'sandbox')) {
    const sb = v.sandbox;
    if (!isPlainObject(sb)) return null;
    if (Object.hasOwn(sb, 'enabled')) { if (typeof sb.enabled !== 'boolean') return null; enabled = sb.enabled; }
    if (Object.hasOwn(sb, 'filesystem')) {
      const fsx = sb.filesystem;
      if (!isPlainObject(fsx)) return null;
      if (Object.hasOwn(fsx, 'allowWrite')) { if (!stringList(fsx.allowWrite)) return null; roots.push(...fsx.allowWrite); }
    }
  }
  if (Object.hasOwn(v, 'permissions')) {
    const pm = v.permissions;
    if (!isPlainObject(pm)) return null;
    if (Object.hasOwn(pm, 'additionalDirectories')) { if (!stringList(pm.additionalDirectories)) return null; roots.push(...pm.additionalDirectories); }
  }
  return { roots, enabled };
}
