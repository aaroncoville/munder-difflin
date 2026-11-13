/**
 * How a provider CLI is launched, read the way the CLI reads it: the launch line with each CLI's own option grammar
 * (up to the first positional, so a prompt is never read) and the environment variables that move where it looks
 * for its configuration. Shared by the write-roots dry run and the hook-runtime spawn check, so both read a launch
 * the same way. Anything not modelled is `unknown`; nothing here guesses.
 */
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse as parseToml } from 'smol-toml';

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
  // Only the launched CLI's own variables count: the other provider's are not read by it, so they are ignored.
  const cfg = provider === 'claude' ? env.CLAUDE_CONFIG_DIR : undefined;
  if (cfg !== undefined && !isAbsolute(cfg)) return { unknown: 'CLAUDE_CONFIG_DIR is not an absolute path' };
  const ch = provider === 'codex' ? env.CODEX_HOME : undefined;
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

/** The Codex releases this decoder's allowlists were checked against. Outside them a key or flag may mean something else. */
export const CODEX_VERSIONS = 'Codex 0.162-0.167';
/** Why a key or flag is not understood: it is not on the versioned allowlist. */
export const notOnList = (what: string): string => `${what} is not on the list this app version understands (${CODEX_VERSIONS})`;

/** The Codex launch options the app's own builders emit, each with what it means here. Anything else is not understood.
 *  -a/--ask-for-approval: auto mode's `-a never` (agentProvider.ts); the approval policy decides later escalation, not a root.
 *  -s/--sandbox: auto mode's `-s workspace-write`; read as the sandbox mode.
 *  --model: the preset's model flag (agentProvider.ts modelFlag, workerLaunch.ts).
 *  --add-dir: the hive spawn's extra write roots (hive.ts); collected as roots.
 *  --remote: the app's remote rewrite (codexRemote.ts); the app server's own policy is in force, so it is unknown here.
 *  --dangerously-bypass-hook-trust: the hive spawn, so its generated hooks run (hive.ts).
 *  resume <session>: the resume subcommand (agentProvider.ts resumeSubcommand).
 *  Also read for what they mean, though the app no longer emits them: --full-auto (workspace-write) and
 *  --dangerously-bypass-approvals-and-sandbox / --yolo (no sandbox). */
const CODEX_VALUE_OPTS = new Set(['-a', '--ask-for-approval', '-s', '--sandbox', '--model', '--add-dir', '--remote', '--enable', '--disable']);
const CODEX_FLAGS = new Set(['--dangerously-bypass-hook-trust']);

/** How Codex's sandbox was chosen on the launch line the app spawned: the executable's own words
 *  (from the command string) followed by the argv as given, each argument whole. Options are read
 *  up to the first argument that is neither an option nor an option's value (the prompt is never
 *  read). Only the options the app emits are understood; any other option, any -c, a remote app server (its own policy
 *  is in force), or --enable/--disable of a feature not on the benign list is `unknown`, and `why` names it.
 *  `--add-dir` directories are collected as roots. 'none' when no option says. */
export function codexLaunchSandbox(args: string[] | undefined, addDirs: string[] = [], why: string[] = []): 'workspace-write' | 'read-only' | 'danger-full-access' | 'none' | 'unknown' {
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
      if (i + 1 < words.length) { why.push(`${JSON.stringify(words[i + 1])} after the prompt`); return 'unknown'; }
      break;
    }
    const eq = w.indexOf('=');
    const name = w.startsWith('--') && eq !== -1 ? w.slice(0, eq) : w;
    const value = w.startsWith('--') && eq !== -1 ? w.slice(eq + 1) : null;
    if (name === '--dangerously-bypass-approvals-and-sandbox' || name === '--yolo') return 'danger-full-access';
    if (name === '--full-auto') { mode = 'workspace-write'; continue; }
    if (CODEX_FLAGS.has(name) && value === null) continue;
    if (!CODEX_VALUE_OPTS.has(name)) { why.push(notOnList(`option ${name}`)); return 'unknown'; }
    const v = value ?? words[++i];
    if (v === undefined) { why.push(`option ${name} without a value`); return 'unknown'; }
    if (name === '-s' || name === '--sandbox') mode = v;
    else if (name === '--add-dir') addDirs.push(v);
    else if (name === '--remote') { why.push('option --remote (the app server\'s own policy is in force)'); return 'unknown'; }
    else if ((name === '--enable' || name === '--disable') && !Object.hasOwn(CODEX_FEATURES, v)) { why.push(notOnList(`${name} ${v}`)); return 'unknown'; }
  }
  if (mode === null) return 'none';
  if (mode === 'workspace-write' || mode === 'read-only' || mode === 'danger-full-access') return mode;
  why.push(`sandbox ${JSON.stringify(mode)}`);
  return 'unknown';
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
export function claudeLaunch(args: string[] | undefined, generatedSettings: string, addDirs: string[] = [], why: string[] = []): 'ok' | 'unknown' {
  if (!Array.isArray(args) || args.length === 0) { why.push('no launch line'); return 'unknown'; } // nothing to read it from
  const a = args.filter((x): x is string => typeof x === 'string');
  const words = [...(a[0] ?? '').trim().split(/\s+/).filter(Boolean), ...a.slice(1)];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '--' || !w.startsWith('-')) {
      // The prompt (or '--'): Claude still reads options after it, so anything further is not modelled.
      if (i + 1 < words.length) { why.push(`${JSON.stringify(words[i + 1])} after the prompt`); return 'unknown'; }
      break;
    }
    const eq = w.indexOf('=');
    const name = w.startsWith('--') && eq !== -1 ? w.slice(0, eq) : w;
    const inline = w.startsWith('--') && eq !== -1 ? w.slice(eq + 1) : null;
    if (CLAUDE_FLAGS.has(name)) { if (inline !== null) { why.push(`option ${name} with a value`); return 'unknown'; } continue; }
    if (name === '-r' || name === '--resume') { if (inline === null && words[i + 1] !== undefined && !words[i + 1].startsWith('-')) i++; continue; }
    if (CLAUDE_VALUE_OPTS.has(name)) {
      const v = inline ?? words[++i];
      if (v === undefined) { why.push(`option ${name} without a value`); return 'unknown'; }
      if (name === '--settings' && resolve(v) !== resolve(generatedSettings)) { why.push(`--settings ${v.length > 80 ? 'with inline JSON' : v}`); return 'unknown'; }
      continue;
    }
    if (CLAUDE_VARIADIC_OPTS.has(name)) {
      const vals = inline !== null ? [inline] : [];
      while (inline === null && i + 1 < words.length && !words[i + 1].startsWith('-')) vals.push(words[++i]);
      if (!vals.length) { why.push(`option ${name} without a value`); return 'unknown'; }
      if (name === '--add-dir') addDirs.push(...vals);
      continue;
    }
    why.push(`option ${name}`);
    return 'unknown';
  }
  return 'ok';
}

/** A plain JSON object (not null, not an array). */
export const isPlainObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/** A JSON value that must be an array of strings when present. */
export const stringList = (x: unknown): x is string[] => Array.isArray(x) && x.every((y) => typeof y === 'string');

export type RootsState = 'ok' | 'unsandboxed' | 'unknown';

/** The key path of the first value that is not a string, boolean, finite number, array or plain table, or null. */
function oddValue(v: unknown, at: string): string | null {
  if (typeof v === 'string' || typeof v === 'boolean') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? null : at || '(top)';
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const o = oddValue(v[i], `${at}[${i}]`); if (o) return o; } return null; }
  if (v !== null && typeof v === 'object' && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)) {
    for (const [k, x] of Object.entries(v)) { const o = oddValue(x, at ? `${at}.${k}` : k); if (o) return o; }
    return null;
  }
  return at || '(top)';
}

/** Top-level config keys that do not change the writable set, the sandbox mode, or which programs Codex runs, each with
 *  its source: the inventory of Codex policy inputs (by section) or Codex's config schema. Any other top-level key is not
 *  understood. Being on this list says nothing more than that. */
export const CODEX_BENIGN_KEYS: Readonly<Record<string, string>> = {
  model: 'config reference (model name); in the owner config named by the inventory\'s conclusion',
  model_reasoning_effort: 'config reference; in the owner config named by the inventory\'s conclusion',
  model_provider: 'config reference (which provider entry serves the model); absent from the inventory\'s policy tables',
  shell_environment_policy: 'config reference (environment given to commands); absent from the inventory\'s policy tables',
  approval_policy: 'inventory, note under "Config keys that change the sandbox": grants no path, decides later escalation',
  history: 'config reference (transcript history); absent from the inventory\'s policy tables',
  tui: 'config reference (terminal UI); absent from the inventory\'s policy tables',
  include_permissions_instructions: 'config reference (prompt text only); absent from the inventory\'s policy tables'
};
/** features.<name> entries known not to touch the sandbox, its backend, hooks or plugins (the inventory lists those:
 *  hooks, codex_hooks, plugins, prefer_mxc, use_linux_sandbox_bwrap, use_legacy_landlock). */
export const CODEX_FEATURES: Readonly<Record<string, string>> = {
  multi_agent: 'inventory conclusion: the owner config\'s only feature, not a policy input'
};
/** Inside sandbox_workspace_write: writable_roots is read; the two exclusions only narrow the set (inventory rows);
 *  network_access is a boolean about the network, not the writable set. */
const SWW_KEYS = new Set(['writable_roots', 'exclude_tmpdir_env_var', 'exclude_slash_tmp', 'network_access']);
/** Top-level tables that name a program Codex runs itself, outside its sandbox (Codex config schema):
 *  mcp_servers.<x> (command, args, auth, http_headers_helper), notify, and model_providers.<x> (auth.command,
 *  aws.auth_refresh.command, aws.credential_export.command). They are read by file, like [hooks]: allowed and not read
 *  in the owner's own config, not understood in a project config, and in a generated config only as the app copied
 *  them from the owner's. */
export const CODEX_PROGRAM_KEYS: readonly string[] = ['mcp_servers', 'notify', 'model_providers'];

/** Deep equality of two parsed TOML values (strings, numbers, booleans, arrays, plain tables). */
function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (isPlainObject(a) || isPlainObject(b)) {
    if (!isPlainObject(a) || !isPlainObject(b)) return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && sameValue(a[k], b[k]));
  }
  return a === b;
}

/** Which config file is read: the per-agent one the app generates (its CODEX_HOME), the owner's own user config, or a
 *  project .codex/config.toml in the working directory or above it (where a seat works, so not owner-held). */
export type CodexConfigKind = 'generated' | 'user' | 'project';
/** The lifecycle hooks the app writes into a generated config: one group per event, one command entry each. `stateKeys`
 *  are the hook ids whose trust the app's remote start persists (hooks.state.<id>.trusted_hash, codexHookTrust.ts). */
export interface CodexAppHooks { events: readonly string[]; command: string; timeout: number; stateKeys?: readonly string[] }

/** The ids Codex gives the generated hooks in the config at `realConfig` (its real path): `<file>:<event_in_snake_case>:0:0`,
 *  as Codex 0.162 reports them and the app persists their trust. */
export function codexHookStateKeys(realConfig: string, events: readonly string[]): string[] {
  return events.map((e) => `${realConfig}:${e.replace(/(?<=[a-z])(?=[A-Z])/g, '_').toLowerCase()}:0:0`);
}

/** True when `hooks` is exactly what the app writes: the same events, each one group holding one entry of exactly
 *  type "command", this command and this timeout. Anything extra or different is false. */
function hooksAreApps(hooks: unknown, app: CodexAppHooks | null | undefined): boolean {
  if (!app || !isPlainObject(hooks)) return false;
  // The trust the app persists for its own hooks: only those ids, each holding only a sha256 trusted_hash.
  if (Object.hasOwn(hooks, 'state')) {
    const st = hooks.state;
    if (!isPlainObject(st) || !Object.entries(st).every(([id, v]) => (app.stateKeys ?? []).includes(id) && isPlainObject(v)
      && Object.keys(v).length === 1 && typeof v.trusted_hash === 'string' && /^sha256:[0-9a-f]{64}$/.test(v.trusted_hash))) return false;
  }
  const evs = Object.keys(hooks).filter((k) => k !== 'state');
  if (evs.length !== app.events.length || !app.events.every((e) => evs.includes(e))) return false;
  return evs.every((e) => {
    const groups = hooks[e];
    if (!Array.isArray(groups) || groups.length !== 1 || !isPlainObject(groups[0])) return false;
    const g = groups[0];
    if (Object.keys(g).length !== 1 || !Array.isArray(g.hooks) || g.hooks.length !== 1 || !isPlainObject(g.hooks[0])) return false;
    const h = g.hooks[0];
    return Object.keys(h).length === 3 && h.type === 'command' && h.command === app.command && h.timeout === app.timeout;
  });
}

/** Codex writable_roots and sandbox mode from one config.toml, parsed by smol-toml and checked against a versioned
 *  allowlist of top-level keys (CODEX_VERSIONS): a key is read (sandbox_mode, sandbox_workspace_write, projects' trust
 *  levels, features on CODEX_FEATURES, allow_symlinked_codex_home = false), known benign (CODEX_BENIGN_KEYS), or not
 *  understood, and `why` names it. [hooks] depends on the file: in the owner's user config it is allowed and not read;
 *  in the generated config it is read only when it is exactly the app's own hooks (`hooksDiffer` otherwise); in a project
 *  config it is not understood. A parse error or any other type where a read key lives is unknown too. */
export function codexRoots(toml: string, kind: CodexConfigKind = 'project', appHooks?: CodexAppHooks | null, ownerToml?: string | null): { roots: string[]; state: RootsState; mode?: string | null; why?: string; hooksDiffer?: true; configDiffers?: true } {
  const unknown = (why: string): { roots: string[]; state: 'unknown'; why: string } => ({ roots: [], state: 'unknown', why });
  let doc: unknown;
  try { doc = parseToml(toml); } catch (e) {
    const line = (e as { line?: number }).line;
    return unknown(`not valid TOML${typeof line === 'number' ? ` (line ${line})` : ''}`);
  }
  if (!isPlainObject(doc)) return unknown('not a TOML table');
  // Stricter than Codex on purpose: anything but a string, boolean, integer, finite float, array or table (a date or
  // time, an infinity, a value the parser and Codex may read differently) makes the whole file not understood.
  const odd = oddValue(doc, '');
  if (odd) return unknown(`${odd} is a value the app does not read (a date, time or non-finite number)`);
  let mode: string | null = null;
  let roots: string[] = [];
  // A generated config's program tables must be exactly the owner's (the app copies them); read the owner's once.
  let owner: Record<string, unknown> | null | undefined;
  const ownerDoc = (): Record<string, unknown> | null => {
    if (owner !== undefined) return owner;
    if (typeof ownerToml !== 'string') return (owner = ownerToml === null ? {} : null); // null = no owner config: nothing to copy
    try { const d = parseToml(ownerToml); owner = isPlainObject(d) ? d : null; } catch { owner = null; }
    return owner;
  };
  if (kind === 'generated') {
    for (const k of CODEX_PROGRAM_KEYS) {
      const o = ownerDoc();
      // An owner config that cannot be read: a program table in the copy cannot be shown to be the owner's.
      if (o === null ? Object.hasOwn(doc, k) : !sameValue(Object.hasOwn(doc, k) ? doc[k] : undefined, Object.hasOwn(o, k) ? o[k] : undefined)) {
        return { roots: [], state: 'unknown', why: `${k} differs from the owner's config the app copied`, configDiffers: true };
      }
    }
  }
  for (const [k, x] of Object.entries(doc)) {
    if (Object.hasOwn(CODEX_BENIGN_KEYS, k)) continue;
    if (k === 'sandbox_mode') { if (typeof x !== 'string') return unknown('sandbox_mode is not text'); mode = x; continue; }
    if (k === 'sandbox_workspace_write') {
      if (!isPlainObject(x)) return unknown('sandbox_workspace_write is not a table');
      for (const [k2, y] of Object.entries(x)) {
        if (!SWW_KEYS.has(k2)) return unknown(notOnList(`sandbox_workspace_write.${k2}`));
        if (k2 === 'writable_roots') { if (!stringList(y)) return unknown('sandbox_workspace_write.writable_roots is not a list of text'); roots = y; }
        else if (typeof y !== 'boolean') return unknown(`sandbox_workspace_write.${k2} is not true or false`);
      }
      continue;
    }
    if (k === 'projects') {
      if (!isPlainObject(x)) return unknown('projects is not a table');
      for (const [name, p] of Object.entries(x)) {
        if (!isPlainObject(p)) return unknown(`projects.${name} is not a table`);
        for (const [k2, y] of Object.entries(p)) {
          if (k2 !== 'trust_level') return unknown(notOnList(`projects.${name}.${k2}`));
          if (typeof y !== 'string') return unknown(`projects.${name}.trust_level is not text`);
        }
      }
      continue;
    }
    if (k === 'features') {
      if (!isPlainObject(x)) return unknown('features is not a table');
      for (const [f, y] of Object.entries(x)) {
        if (!Object.hasOwn(CODEX_FEATURES, f)) return unknown(notOnList(`features.${f}`));
        if (typeof y !== 'boolean') return unknown(`features.${f} is not true or false`);
      }
      continue;
    }
    // Lets roots under CODEX_HOME follow links out of it (to targets that can change): only false is read as harmless.
    if (k === 'allow_symlinked_codex_home' && x === false) continue;
    if (CODEX_PROGRAM_KEYS.includes(k)) {
      if (kind === 'project') return unknown(notOnList(`${k} in a project config (Codex runs the program it names outside its sandbox)`));
      continue; // the owner's own (not read), or a generated copy already compared with the owner's above
    }
    if (k === 'hooks') {
      if (kind === 'user') continue; // the owner's own file: allowed, not read (listed before enforcement)
      if (kind === 'generated') {
        if (hooksAreApps(x, appHooks)) continue;
        return { roots: [], state: 'unknown', why: 'hooks differ from the app\'s own', hooksDiffer: true };
      }
      return unknown(notOnList('hooks in a project config'));
    }
    return unknown(notOnList(k));
  }
  if (mode === 'danger-full-access') return { roots: [], state: 'unsandboxed', mode };
  if (mode !== null && mode !== 'workspace-write' && mode !== 'read-only') return { roots: [], state: 'unknown', mode, why: `sandbox_mode = "${mode}"` };
  return { roots, state: 'ok', mode };
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
