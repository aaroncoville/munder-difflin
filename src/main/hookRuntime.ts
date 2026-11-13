/**
 * The folder Claude and Codex hook commands run from.
 *
 * Hooks run outside the agent's sandbox. If their command named a file an agent can write
 * (anything under the hive folder, or a source checkout an agent works in), that agent could
 * replace it and have its code run unsandboxed, as every other agent, at their next hook.
 *
 * So the app stages the hook shim and its node launcher into a private folder of its own
 * (0700, outside the hive), writes both from the text it holds itself, replaces them without
 * following links, and checks both by digest when it stages them and again before each spawn.
 * A spawn whose working directory or write roots overlap that folder is refused. If the folder
 * cannot be staged or verified, a Claude or Codex spawn fails with a visible reason: there is
 * no fallback to a command under the hive.
 */
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, constants, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

export class HookRuntimeUnavailable extends Error {
  readonly code = 'hook-runtime-unavailable';
  constructor(reason: string) {
    super(`Hook runtime unavailable: ${reason}. Claude and Codex agents cannot start until it is fixed; see log.jsonl (kind "hook-runtime").`);
    this.name = 'HookRuntimeUnavailable';
  }
}

export interface RuntimeFile { name: string; content: string; mode: number }
export interface StagedHookRuntime { dir: string; launcher: string; shim: string; digests: Record<string, string> }

const sha256 = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');

/** Characters that would break or expand inside the generated command on this platform. Only the
 *  Windows Codex command is bare (its shell stack drops quotes), so `bare` also refuses whitespace. */
export function unsafePathReason(p: string, platform: string, bare = false): string | null {
  if (platform === 'win32') {
    if (/["%!^&|<>()`$]/.test(p)) return 'its path has a shell character the hook command cannot carry';
    return bare && /\s/.test(p) ? 'its path has a space, which the Windows Codex command cannot quote' : null;
  }
  return /["$`\\\r\n]/.test(p) ? 'its path has a quote, $, backtick or backslash, which the hook command would expand' : null;
}

const within = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

/** A path with the links in its longest existing prefix resolved, in the disk's own case. */
export function realish(p: string): string {
  let head = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(head), ...tail.reverse()); } catch { /* not on disk yet */ }
    const up = resolve(head, '..');
    if (up === head) return resolve(p);
    tail.push(head.slice(up.length).replace(/^[\\/]+/, ''));
    head = up;
  }
}

/** True when either path holds the other. */
export function overlaps(a: string, b: string): boolean {
  const x = realish(a);
  const y = realish(b);
  return within(x, y) || within(y, x);
}

export function writeNoFollow(dir: string, f: RuntimeFile): void {
  const tmp = join(dir, `.${f.name}.${process.pid}.${randomBytes(6).toString('hex')}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const fd = openSync(tmp, flags, f.mode);
  try {
    const buf = Buffer.from(f.content, 'utf8');
    let off = 0;
    while (off < buf.length) {
      const n = writeSync(fd, buf, off, buf.length - off);
      if (n <= 0) throw new Error('write made no progress');
      off += n;
    }
  } finally { closeSync(fd); }
  try { chmodSync(tmp, f.mode); renameSync(tmp, join(dir, f.name)); } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/** Make (or check) a folder only this user can write and no agent's hive folder reaches: absolute, outside the hive,
 *  created 0700, not a link, owned by this user, and set back to 0700. Throws HookRuntimeUnavailable with the reason.
 *  Main reads authority (a hook command, a helper session's --settings) only from such a folder, never from a place an
 *  agent can write. */
export function ensurePrivateDir(dir: string, hiveRoot: string | null): void {
  const fail = (why: string): never => { throw new HookRuntimeUnavailable(why); };
  if (typeof dir !== 'string' || !isAbsolute(dir)) fail('its folder is not an absolute path');
  if (!hiveRoot) fail('the hive folder is not known yet, so the folder cannot be shown to be outside it');
  if (overlaps(dir, hiveRoot as string)) fail('its folder overlaps the hive folder, which every agent can write');
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (e) { fail(`its folder could not be created (${(e as Error).message})`); }
  const st = lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('its folder is a link or not a folder');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) fail('its folder belongs to another user');
  try { chmodSync(dir, 0o700); } catch (e) { fail(`its folder could not be made private (${(e as Error).message})`); }
}

/** Stage the launcher and shim; throws HookRuntimeUnavailable with the reason. */
export function stageHookRuntime(o: {
  dir: string; hiveRoot: string | null; platform: string; launcher: RuntimeFile; shim: RuntimeFile;
}): StagedHookRuntime {
  const fail = (why: string): never => { throw new HookRuntimeUnavailable(why); };
  if (typeof o.dir !== 'string' || !isAbsolute(o.dir)) fail('its folder is not an absolute path');
  const unsafe = unsafePathReason(o.dir, o.platform);
  if (unsafe) fail(unsafe);
  if (!o.hiveRoot) fail('the hive folder is not known yet, so the runtime cannot be shown to be outside it');
  ensurePrivateDir(o.dir, o.hiveRoot);
  try {
    writeNoFollow(o.dir, o.launcher);
    writeNoFollow(o.dir, o.shim);
  } catch (e) { fail(`its files could not be written (${(e as Error).message})`); }
  const rt: StagedHookRuntime = {
    dir: o.dir, launcher: join(o.dir, o.launcher.name), shim: join(o.dir, o.shim.name),
    digests: { [o.launcher.name]: sha256(o.launcher.content), [o.shim.name]: sha256(o.shim.content) },
  };
  verifyHookRuntime(rt);
  return rt;
}

/** Throws HookRuntimeUnavailable unless the folder and both files are exactly as staged. */
export function verifyHookRuntime(rt: StagedHookRuntime): void {
  const fail = (why: string): never => { throw new HookRuntimeUnavailable(why); };
  let st;
  try { st = lstatSync(rt.dir); } catch { return fail('its folder is gone'); }
  if (st.isSymbolicLink() || !st.isDirectory()) fail('its folder was replaced');
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) fail('its folder became readable or writable by others');
  for (const [name, digest] of Object.entries(rt.digests)) {
    const p = join(rt.dir, name);
    let f;
    try { f = lstatSync(p); } catch { return fail(`${name} is gone`); }
    if (f.isSymbolicLink() || !f.isFile()) fail(`${name} was replaced by something that is not a file`);
    if (sha256(readFileSync(p)) !== digest) fail(`${name} changed since the app wrote it`);
  }
}

/** The hook command for this runtime: quoted on POSIX, bare on Windows where Codex's shell stack drops quotes (the path was checked to need none). */
export function hookCommandFor(rt: StagedHookRuntime, quoted: boolean): string {
  return quoted ? `"${rt.launcher}" "${rt.shim}"` : `${rt.launcher} ${rt.shim}`;
}

/** A write root an agent's sandbox is given, and where it came from; path null = could not be read or understood. */
export interface WriteRoot { path: string | null; from: string }

/** Why a root lets the agent reach the runtime folder, naming the root and its source; null when none does. */
export function rootOverlap(rt: StagedHookRuntime, roots: WriteRoot[]): string | null {
  for (const r of roots) {
    if (r.path === null) return `a write root in ${r.from} could not be read or understood`;
    if (r.path && overlaps(rt.dir, r.path)) return `the agent may write the hook runtime folder through ${r.path} (${r.from})`;
  }
  return null;
}
