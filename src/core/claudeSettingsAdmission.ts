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
import { insideAny, SCOPED_SANDBOX_PINS, SCOPED_UNSANDBOXED_COMMANDS } from './writeRoots';
import { CLAUDE_SETTINGS_CLI, CLAUDE_SETTINGS_KEYS, type SettingsKey } from './claudeSettingsKeys';

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
  return m ? writeTool(m[1]) : null;
}

/** The file-writing tool a rule's tool name names, matched in any letter case (whether the CLI's own matching ignores
 *  case is not known, so a differently cased name is read as the tool), as CLAUDE_FILE_WRITE_TOOLS spells it. */
function writeTool(name: string): string | null {
  return CLAUDE_FILE_WRITE_TOOLS.find((t) => t.toLowerCase() === name.toLowerCase()) ?? null;
}

/** The folder a file-writing tool's allow rule (Edit(...), Write(...), MultiEdit(...), NotebookEdit(...)) starts in,
 *  or null when it cannot be read (a bare `Edit` or `Write` allows every path). `//x` is absolute, `~/x` in the home folder, `/x` relative to the settings file's folder, any other relative
 *  to the working folder. A pattern is cut at its first wildcard; a cut inside a name keeps the folder holding it. */
export function editRuleFolder(rule: string, settingsDir: string, cwd: string, home: string): string | null {
  const m = /^\s*([A-Za-z]+)\s*\((.*)\)\s*$/.exec(rule);
  if (!m || writeTool(m[1]) === null) return null;
  const spec = m[2].trim();
  if (!spec) return null;
  // As settingsRootPath: a variable or command substitution, or another user's home (~user), is not understood.
  if (/[$%`]/.test(spec) || /^~(?!$|\/)/.test(spec)) return null;
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

interface JudgeContext { inside: (x: string | null) => boolean; cwd: string; home: string; settingsDir: string }
type Judge = (value: unknown, path: string, c: JudgeContext) => Judged;

const refuseWhen = (bad: boolean): Judge => (v, path) => (v === bad ? { key: path } : null);
const rootsInside: Judge = (v, path, c) => {
  for (const x of v as string[]) {
    const root = settingsRootPath(x, c.cwd, c.home);
    if (!c.inside(root)) return { key: path, root };
  }
  return null;
};
// A credential entry that masks has the proxy put the real value into requests the seat makes; one that denies only
// hides it.
const denyEntriesOnly: Judge = (v, path) => ((v as unknown[]).every((e) => isPlainObject(e) && e.mode === 'deny') ? null : { key: path, why: 'an entry does not deny' });
/** Second-level labels that registries hand out under a two-letter country code (co.uk, com.au, gov.br …). Not the
 *  public suffix list: a wildcard under a suffix not named here is admitted. */
const GENERIC_SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'mil', 'ne', 'net', 'nic', 'or', 'org']);

/** Whether an allowedDomains entry matches every domain or every domain under a public suffix. A ':port' suffix is
 *  dropped first (it only narrows the entry to one port). A wildcard is understood only as one leading '*.' label;
 *  anywhere else the entry is too wide. '*.<tld>' and '*.<generic second level>.<country code>' are too wide. */
function domainTooWide(entry: string): boolean {
  const host = entry.trim().replace(/:\d+$/, '').toLowerCase();
  if (!host.includes('*')) return false;
  if (!host.startsWith('*.')) return true;
  const rest = host.slice(2);
  if (rest.includes('*')) return true;
  const labels = rest.split('.').filter(Boolean);
  if (labels.length <= 1) return true;
  return labels.length === 2 && labels[1].length === 2 && GENERIC_SECOND_LEVEL.has(labels[0]);
}

const emptyOnly: Judge = (v, path) => ((v as string[]).length === 0 ? null : { key: path });

/** The judgement of each key the table classes as judged (other than objects, whose keys are judged in turn): the
 *  values that would widen the seat are refused, the rest admitted. */
const JUDGES: Readonly<Record<string, Judge>> = {
  'permissions.additionalDirectories': rootsInside,
  'permissions.allow': (v, _path, c) => {
    for (const rule of v as string[]) {
      const tool = writeRuleTool(rule);
      if (tool === null) continue;
      const root = editRuleFolder(rule, c.settingsDir, c.cwd, c.home);
      if (!c.inside(root)) return { key: `permissions.allow ${tool}`, root };
    }
    return null;
  },
  'permissions.defaultMode': (v, path) => (ADMITTED_DEFAULT_MODES.includes(v as string) ? null : { key: path }),
  'sandbox.allowAppleEvents': refuseWhen(true),
  'sandbox.allowNestedUserNamespaces': refuseWhen(true),
  'sandbox.allowUnsandboxedCommands': refuseWhen(true),
  // The seats pin these (SCOPED_SANDBOX_PINS): only the pinned value is admitted, since a boolean has nothing tighter.
  'sandbox.autoAllowBashIfSandboxed': refuseWhen(!SCOPED_SANDBOX_PINS.autoAllowBashIfSandboxed),
  'sandbox.credentials.allowPlaintextInject': refuseWhen(true),
  'sandbox.credentials.envVars': denyEntriesOnly,
  'sandbox.credentials.files': denyEntriesOnly,
  'sandbox.enableWeakerNestedSandbox': refuseWhen(true),
  'sandbox.enableWeakerNetworkIsolation': refuseWhen(true),
  'sandbox.enabled': refuseWhen(false),
  'sandbox.excludedCommands': (v, path) => {
    const own: readonly string[] = SCOPED_UNSANDBOXED_COMMANDS;
    return (v as string[]).every((cmd) => own.includes(cmd)) ? null : { key: path };
  },
  'sandbox.failIfUnavailable': refuseWhen(false),
  'sandbox.filesystem.allowRead': rootsInside,
  'sandbox.filesystem.allowWrite': rootsInside,
  'sandbox.filesystem.disabled': refuseWhen(true),
  'sandbox.network.allowAllUnixSockets': refuseWhen(true),
  'sandbox.network.allowLocalBinding': refuseWhen(!SCOPED_SANDBOX_PINS.allowLocalBinding),
  'sandbox.network.allowMachLookup': emptyOnly,
  'sandbox.network.allowUnixSockets': emptyOnly,
  'sandbox.network.allowedDomains': (v, path) => {
    const wide = (v as string[]).find(domainTooWide);
    return wide === undefined ? null : { key: path, why: `"${wide}" matches every domain or a whole public suffix` };
  },
};

/** The keys JUDGES has a judgement for. */
export const JUDGED_SETTINGS_KEYS: readonly string[] = Object.keys(JUDGES);

/** Why `value` is not of `type`, or null. */
function typeProblem(e: SettingsKey, value: unknown): string | null {
  switch (e.type) {
    case 'object': return isPlainObject(value) ? null : 'is not an object';
    case 'boolean': return typeof value === 'boolean' ? null : 'is not a boolean';
    case 'strings': return stringList(value) ? null : 'is not a list of text';
    case 'string': return typeof value === 'string' ? null : 'is not text';
    case 'enum': return typeof value === 'string' && (e.values ?? []).includes(value) ? null : `is not one of ${(e.values ?? []).join(', ')}`;
    case 'array': return Array.isArray(value) ? null : 'is not a list';
    case 'stringListMap': return isPlainObject(value) && Object.values(value).every(stringList) ? null : 'is not a map of lists of text';
    case 'any': return null;
  }
}

/** The strict judgement of one settings object's `sandbox` and `permissions` subtrees: an allowlist over the table of
 *  the keys the pinned CLI accepts there (claudeSettingsKeys.ts). A key the table does not have is refused as unknown
 *  to it; a refused key is refused whatever its value; every other key must have the type the table gives, and a
 *  judged key must also pass its judgement (JUDGES). The first key that fails is returned with its path (and, for a
 *  root, the path it resolved to). Keys outside the two subtrees are not judged here. */
function strictExcess(v: Record<string, unknown>, inside: (x: string | null) => boolean, cwd: string, home: string, settingsDir: string): Judged {
  const c: JudgeContext = { inside, cwd, home, settingsDir };
  const walk = (o: Record<string, unknown>, prefix: string | null): Judged => {
    for (const [k, value] of Object.entries(o)) {
      const path = prefix === null ? k : `${prefix}.${k}`;
      if (prefix === null && k !== 'sandbox' && k !== 'permissions') continue;
      const e = CLAUDE_SETTINGS_KEYS[path];
      if (!e) return { key: path, why: `unknown to this build's settings table for CLI ${CLAUDE_SETTINGS_CLI}` };
      if (e.cls === 'refused') return { key: path, why: e.why };
      const bad = typeProblem(e, value);
      if (bad) return { key: path, why: bad };
      if (e.type === 'object') {
        const inner = walk(value as Record<string, unknown>, path);
        if (inner) return inner;
        continue;
      }
      if (e.cls !== 'judged') continue;
      const judge = JUDGES[path];
      // A judged key without a judgement is refused: the table says some of its values widen the seat.
      if (!judge) return { key: path, why: 'has no judgement in this build' };
      const j = judge(value, path, c);
      if (j) return j;
    }
    return null;
  };
  return walk(v, null);
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
