/**
 * The write roots a Claude seat gets from the owner's own settings, judged against the roots the seat was given.
 *
 * Claude merges the owner's managed and user settings into every session, whatever settings file the app passes with
 * --settings. A write root there (sandbox.filesystem.allowWrite, permissions.additionalDirectories, or an Edit allow
 * rule) outside the seat's scoped roots would be added to the seat's sandbox and edit tools anyway, so a scoped seat
 * may only start when every such root is inside the roots it was given. A settings file that cannot be read or
 * understood fails the check: its roots cannot be shown to be inside.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve as resolvePath } from 'node:path';
import { CLAUDE_FILE_WRITE_TOOLS, claudeRootEntries, isPlainObject, stringList } from './launchLine';
import { insideAny, SCOPED_UNSANDBOXED_COMMANDS } from './writeRoots';

/** The machine-wide Claude settings file. */
export const MANAGED_CLAUDE_SETTINGS = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode/managed-settings.json'
  : process.platform === 'win32' ? 'C:\\ProgramData\\ClaudeCode\\managed-settings.json' : '/etc/claude-code/managed-settings.json';

/** A settings file's text: 'missing' when absent, null when it is a link, not a regular file, larger than 1 MB, or
 *  unreadable. Opened non-blocking and judged on the handle, so a file swapped for a pipe cannot hold the reader. */
export function readSmallSettingsFile(file: string): string | 'missing' | null {
  let st;
  try { st = lstatSync(file); } catch (e) { const c = (e as NodeJS.ErrnoException).code; return c === 'ENOENT' || c === 'ENOTDIR' ? 'missing' : null; }
  if (st.isSymbolicLink() || !st.isFile() || st.size > 1024 * 1024) return null;
  let fd: number | null = null;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
    const f = fstatSync(fd);
    if (!f.isFile() || f.size > 1024 * 1024) return null;
    return readFileSync(fd, 'utf8');
  } catch { return null; } finally { if (fd !== null) closeSync(fd); }
}

/** A root as written in a settings file: ~ and $HOME expanded against `home`, relative ones against the cwd; any other
 *  variable or form is not understood (null). */
export function settingsRootPath(x: unknown, cwd: string, home: string): string | null {
  if (typeof x !== 'string' || !x) return null;
  let v = x.replace(/^~(?=$|[\\/])/, home).replace(/^\$\{?HOME\}?(?=$|[\\/])/, home);
  // A leading ~user is someone else's home and is not understood; a ~ inside a name (com~apple~CloudDocs) is just a name.
  if (/^~/.test(v) || /[$%`]/.test(v)) return null;
  if (!isAbsolute(v)) { if (!cwd) return null; v = join(cwd, v); }
  return resolvePath(v);
}

/** The file-writing tool an allow rule names (Edit, Write, MultiEdit, NotebookEdit), or null. */
function writeRuleTool(rule: string): string | null {
  const m = /^\s*([A-Za-z]+)\s*(\(|$)/.exec(rule);
  return m && CLAUDE_FILE_WRITE_TOOLS.includes(m[1]) ? m[1] : null;
}

/** The folder a file-writing tool's allow rule (Edit(...), Write(...), MultiEdit(...), NotebookEdit(...)) starts in,
 *  or null when it cannot be read (a bare `Edit` or `Write` allows every path). `//x` is absolute, `~/x` in the home folder, `/x` relative to the settings file's folder, any other relative
 *  to the working folder. A pattern is cut at its first wildcard; a cut inside a name keeps the folder holding it. */
export function editRuleFolder(rule: string, settingsDir: string, cwd: string, home: string): string | null {
  const m = /^\s*([A-Za-z]+)\s*\((.*)\)\s*$/.exec(rule);
  if (!m || !CLAUDE_FILE_WRITE_TOOLS.includes(m[1])) return null;
  const spec = m[2].trim();
  if (!spec) return null;
  let p: string;
  if (spec.startsWith('//')) p = spec.slice(1);
  else if (spec === '~' || spec.startsWith('~/')) p = join(home, spec.slice(1));
  else if (spec.startsWith('/')) p = join(settingsDir, spec);
  else { if (!cwd || !isAbsolute(cwd)) return null; p = join(cwd, spec); }
  const cut = p.search(/[*?[{]/);
  if (cut === -1) return resolvePath(p);
  const head = p.slice(0, cut);
  return resolvePath(head.endsWith('/') ? head : dirname(head));
}

/** What else in one settings file widens a scoped seat, beyond the roots claudeRootEntries reads: `problem` when a
 *  key cannot be judged, `key` when it widens the seat; null when nothing does.
 *  - A permissions allow, ask or deny list that is not a list of text is not understood: reading around it would skip
 *    a rule the CLI may still apply.
 *  - sandbox.excludedCommands runs the commands it names outside the sandbox, where they can write anywhere; an entry
 *    is admitted only when the scoped seat already runs it unsandboxed (SCOPED_UNSANDBOXED_COMMANDS).
 *  - With `sandboxOff` set, sandbox.enabled false or sandbox.allowUnsandboxedCommands true widens the seat: managed
 *    settings outrank the seat's own settings file for these, so the sandbox would be off or a failed command rerun
 *    outside it. */
function settingsExcess(text: string, sandboxOff: boolean): { problem: string } | { key: string } | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return { problem: 'it is not JSON' }; }
  if (!isPlainObject(v)) return { problem: 'it is not an object' };
  const pm = v.permissions;
  if (isPlainObject(pm)) {
    for (const k of ['allow', 'ask', 'deny']) {
      if (Object.hasOwn(pm, k) && !stringList(pm[k])) return { problem: `permissions.${k} is not a list of text` };
    }
  }
  const sb = v.sandbox;
  if (isPlainObject(sb) && Object.hasOwn(sb, 'allowUnsandboxedCommands') && typeof sb.allowUnsandboxedCommands !== 'boolean') {
    return { problem: 'sandbox.allowUnsandboxedCommands is not a boolean' };
  }
  if (sandboxOff && isPlainObject(sb)) {
    if (sb.enabled === false) return { key: 'sandbox.enabled' };
    if (sb.allowUnsandboxedCommands === true) return { key: 'sandbox.allowUnsandboxedCommands' };
  }
  if (isPlainObject(sb) && Object.hasOwn(sb, 'excludedCommands')) {
    if (!stringList(sb.excludedCommands)) return { problem: 'sandbox.excludedCommands is not a list of text' };
    const own: readonly string[] = SCOPED_UNSANDBOXED_COMMANDS;
    if (!sb.excludedCommands.every((c) => own.includes(c))) return { key: 'sandbox.excludedCommands' };
  }
  return null;
}

/** The permissions.defaultMode values the strict check admits: the modes that ask, or refuse, before a tool writes
 *  outside the rules. bypassPermissions and auto are left out. */
export const ADMITTED_DEFAULT_MODES: readonly string[] = ['default', 'manual', 'acceptEdits', 'plan', 'dontAsk'];

type Judged = { key: string; why?: string; root?: string | null } | null;

/** The strict judgement of one settings object's `sandbox` and `permissions` subtrees: an allowlist. Every key there
 *  must be one listed below, with the type it expects, and must not widen what the seat can write, read or run beyond
 *  `inside`; the first that fails is returned with its key path (and the root it resolved to, for a root). Keys outside
 *  the two subtrees are not judged here.
 *
 *  sandbox: enabled (not false), failIfUnavailable (not false), allowUnsandboxedCommands (not true),
 *    enableWeakerNestedSandbox (not true), autoAllowBashIfSandboxed (boolean), excludedCommands (only entries the
 *    scoped seat already runs unsandboxed), filesystem.{disabled (not true), allowWrite (inside), denyWrite, denyRead},
 *    network.{allowedDomains, allowLocalBinding}.
 *  permissions: allow (a file-writing tool's rule must be inside; other rules leave the sandbox and roots as they are),
 *    ask, deny, additionalDirectories (inside), defaultMode (ADMITTED_DEFAULT_MODES), disableBypassPermissionsMode
 *    ("disable"). */
function strictExcess(v: Record<string, unknown>, inside: (x: string | null) => boolean, cwd: string, home: string, settingsDir: string): Judged {
  const bool = (o: Record<string, unknown>, k: string, path: string, refused: boolean): Judged => {
    if (!Object.hasOwn(o, k)) return null;
    if (typeof o[k] !== 'boolean') return { key: path, why: 'is not a boolean' };
    return o[k] === refused ? { key: path } : null;
  };
  const list = (o: Record<string, unknown>, k: string, path: string): Judged | string[] => {
    if (!Object.hasOwn(o, k)) return [];
    return stringList(o[k]) ? o[k] as string[] : { key: path, why: 'is not a list of text' };
  };
  const unknown = (o: Record<string, unknown>, known: string[], path: string): Judged => {
    const k = Object.keys(o).find((x) => !known.includes(x));
    return k === undefined ? null : { key: `${path}.${k}`, why: 'is not a key this check understands' };
  };
  const roots = (values: string[], path: string): Judged => {
    for (const x of values) {
      const root = settingsRootPath(x, cwd, home);
      if (!inside(root)) return { key: path, root };
    }
    return null;
  };
  if (Object.hasOwn(v, 'sandbox')) {
    const sb = v.sandbox;
    if (!isPlainObject(sb)) return { key: 'sandbox', why: 'is not an object' };
    const u = unknown(sb, ['enabled', 'failIfUnavailable', 'allowUnsandboxedCommands', 'enableWeakerNestedSandbox', 'autoAllowBashIfSandboxed', 'excludedCommands', 'filesystem', 'network'], 'sandbox');
    if (u) return u;
    for (const [k, refused] of [['enabled', false], ['failIfUnavailable', false], ['allowUnsandboxedCommands', true], ['enableWeakerNestedSandbox', true]] as const) {
      const j = bool(sb, k, `sandbox.${k}`, refused);
      if (j) return j;
    }
    if (Object.hasOwn(sb, 'autoAllowBashIfSandboxed') && typeof sb.autoAllowBashIfSandboxed !== 'boolean') return { key: 'sandbox.autoAllowBashIfSandboxed', why: 'is not a boolean' };
    const ex = list(sb, 'excludedCommands', 'sandbox.excludedCommands');
    if (!Array.isArray(ex)) return ex;
    const own: readonly string[] = SCOPED_UNSANDBOXED_COMMANDS;
    if (!ex.every((c) => own.includes(c))) return { key: 'sandbox.excludedCommands' };
    if (Object.hasOwn(sb, 'filesystem')) {
      const fsx = sb.filesystem;
      if (!isPlainObject(fsx)) return { key: 'sandbox.filesystem', why: 'is not an object' };
      const uf = unknown(fsx, ['disabled', 'allowWrite', 'denyWrite', 'denyRead'], 'sandbox.filesystem');
      if (uf) return uf;
      const d = bool(fsx, 'disabled', 'sandbox.filesystem.disabled', true);
      if (d) return d;
      for (const k of ['denyWrite', 'denyRead']) {
        const l = list(fsx, k, `sandbox.filesystem.${k}`);
        if (!Array.isArray(l)) return l;
      }
      const aw = list(fsx, 'allowWrite', 'sandbox.filesystem.allowWrite');
      if (!Array.isArray(aw)) return aw;
      const r = roots(aw, 'sandbox.filesystem.allowWrite');
      if (r) return r;
    }
    if (Object.hasOwn(sb, 'network')) {
      const net = sb.network;
      if (!isPlainObject(net)) return { key: 'sandbox.network', why: 'is not an object' };
      const un = unknown(net, ['allowedDomains', 'allowLocalBinding'], 'sandbox.network');
      if (un) return un;
      const dom = list(net, 'allowedDomains', 'sandbox.network.allowedDomains');
      if (!Array.isArray(dom)) return dom;
      if (Object.hasOwn(net, 'allowLocalBinding') && typeof net.allowLocalBinding !== 'boolean') return { key: 'sandbox.network.allowLocalBinding', why: 'is not a boolean' };
    }
  }
  if (Object.hasOwn(v, 'permissions')) {
    const pm = v.permissions;
    if (!isPlainObject(pm)) return { key: 'permissions', why: 'is not an object' };
    const u = unknown(pm, ['allow', 'ask', 'deny', 'additionalDirectories', 'defaultMode', 'disableBypassPermissionsMode'], 'permissions');
    if (u) return u;
    for (const k of ['ask', 'deny']) {
      const l = list(pm, k, `permissions.${k}`);
      if (!Array.isArray(l)) return l;
    }
    const allow = list(pm, 'allow', 'permissions.allow');
    if (!Array.isArray(allow)) return allow;
    for (const rule of allow) {
      const tool = writeRuleTool(rule);
      if (tool === null) continue;
      const root = editRuleFolder(rule, settingsDir, cwd, home);
      if (!inside(root)) return { key: `permissions.allow ${tool}`, root };
    }
    const dirs = list(pm, 'additionalDirectories', 'permissions.additionalDirectories');
    if (!Array.isArray(dirs)) return dirs;
    const r = roots(dirs, 'permissions.additionalDirectories');
    if (r) return r;
    if (Object.hasOwn(pm, 'defaultMode')) {
      if (typeof pm.defaultMode !== 'string') return { key: 'permissions.defaultMode', why: 'is not text' };
      if (!ADMITTED_DEFAULT_MODES.includes(pm.defaultMode)) return { key: 'permissions.defaultMode' };
    }
    if (Object.hasOwn(pm, 'disableBypassPermissionsMode') && pm.disableBypassPermissionsMode !== 'disable') {
      return { key: 'permissions.disableBypassPermissionsMode', why: 'is not "disable"' };
    }
  }
  return null;
}

export interface ClaudeSettingsPlaces {
  /** The machine-wide settings file; its managed-settings.d drop-ins are read too. */
  managedFile: string;
  /** The Claude user folder the session reads settings.json from (CLAUDE_CONFIG_DIR, else ~/.claude); null when the
   *  session loads no user settings. */
  userDir: string | null;
  /** The roots the seat may write: anything the owner's settings add must be inside one of them. */
  allowed: string[];
  /** The seat's working folder, for relative roots. */
  cwd: string;
  /** The home folder ~ and $HOME stand for. */
  home: string;
  /** Judge the `sandbox` and `permissions` subtrees as an allowlist (strictExcess) instead of reading only the keys
   *  that name write roots. */
  strict?: boolean;
}

/** The first write root the owner's managed or user Claude settings add outside `allowed`: `why` names it as
 *  "<source> settings: <key>" (or says the file could not be read or understood), and `root` is the path it resolved
 *  to (null when it could not be resolved). Null when every root is inside. */
export function claudeSettingsExcess(p: ClaudeSettingsPlaces): { why: string; root: string | null } | null {
  const dropDir = join(dirname(p.managedFile), 'managed-settings.d');
  const dropIns: string[] = [];
  try { for (const n of readdirSync(dropDir).sort()) if (n.endsWith('.json')) dropIns.push(join(dropDir, n)); } catch { /* none */ }
  const files: Array<[string, string]> = [...[p.managedFile, ...dropIns].map((f): [string, string] => [f, 'managed settings']), ...(p.userDir === null ? [] : [[join(p.userDir, 'settings.json'), 'user settings'] as [string, string]])];
  const inside = (x: string | null): boolean => !!x && insideAny(x, p.allowed);
  for (const [file, source] of files) {
    const text = readSmallSettingsFile(file);
    if (text === 'missing') continue;
    if (text === null) return { why: `${source} (could not be read)`, root: null };
    if (p.strict) {
      let v: unknown;
      try { v = JSON.parse(text); } catch { return { why: `${source} (could not be understood: it is not JSON)`, root: null }; }
      if (!isPlainObject(v)) return { why: `${source} (could not be understood: it is not an object)`, root: null };
      const j = strictExcess(v, inside, p.cwd, p.home, dirname(file));
      if (j) return { why: `${source}: ${j.key}${j.why ? ` (${j.why})` : ''}`, root: j.root ?? null };
      continue;
    }
    const c = claudeRootEntries(text);
    if (!c) return { why: `${source} (could not be understood)`, root: null };
    const more = settingsExcess(text, source === 'managed settings');
    if (more && 'problem' in more) return { why: `${source} (could not be understood: ${more.problem})`, root: null };
    if (more) return { why: `${source}: ${more.key}`, root: null };
    for (const e of c.entries) {
      const root = settingsRootPath(e.value, p.cwd, p.home);
      if (!inside(root)) return { why: `${source}: ${e.key}`, root };
    }
    for (const rule of c.editRules) {
      const root = editRuleFolder(rule, dirname(file), p.cwd, p.home);
      if (!inside(root)) return { why: `${source}: permissions.allow ${writeRuleTool(rule) ?? 'Edit'}`, root };
    }
  }
  return null;
}
