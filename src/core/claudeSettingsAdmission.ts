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
import { insideAny } from './writeRoots';

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

/** What in one settings file's text cannot be judged, beyond the roots claudeRootEntries reads; null when nothing.
 *  A permissions allow, ask or deny list that is not a list of text is not understood: reading around it would skip a
 *  rule the CLI may still apply. */
function settingsProblem(text: string): string | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return 'it is not JSON'; }
  if (!isPlainObject(v)) return 'it is not an object';
  const pm = v.permissions;
  if (isPlainObject(pm)) {
    for (const k of ['allow', 'ask', 'deny']) {
      if (Object.hasOwn(pm, k) && !stringList(pm[k])) return `permissions.${k} is not a list of text`;
    }
  }
  return null;
}

export interface ClaudeSettingsPlaces {
  /** The machine-wide settings file; its managed-settings.d drop-ins are read too. */
  managedFile: string;
  /** The Claude user folder the session reads settings.json from (CLAUDE_CONFIG_DIR, else ~/.claude). */
  userDir: string;
  /** The roots the seat may write: anything the owner's settings add must be inside one of them. */
  allowed: string[];
  /** The seat's working folder, for relative roots. */
  cwd: string;
  /** The home folder ~ and $HOME stand for. */
  home: string;
}

/** The first write root the owner's managed or user Claude settings add outside `allowed`: `why` names it as
 *  "<source> settings: <key>" (or says the file could not be read or understood), and `root` is the path it resolved
 *  to (null when it could not be resolved). Null when every root is inside. */
export function claudeSettingsExcess(p: ClaudeSettingsPlaces): { why: string; root: string | null } | null {
  const dropDir = join(dirname(p.managedFile), 'managed-settings.d');
  const dropIns: string[] = [];
  try { for (const n of readdirSync(dropDir).sort()) if (n.endsWith('.json')) dropIns.push(join(dropDir, n)); } catch { /* none */ }
  const files: Array<[string, string]> = [...[p.managedFile, ...dropIns].map((f): [string, string] => [f, 'managed settings']), [join(p.userDir, 'settings.json'), 'user settings']];
  const inside = (x: string | null): boolean => !!x && insideAny(x, p.allowed);
  for (const [file, source] of files) {
    const text = readSmallSettingsFile(file);
    if (text === 'missing') continue;
    if (text === null) return { why: `${source} (could not be read)`, root: null };
    const c = claudeRootEntries(text);
    if (!c) return { why: `${source} (could not be understood)`, root: null };
    const problem = settingsProblem(text);
    if (problem) return { why: `${source} (could not be understood: ${problem})`, root: null };
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
