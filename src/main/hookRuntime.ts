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

/** Characters that would break or expand inside the generated command on this platform. On
 *  Windows the Codex command cannot carry quotes through its shell stack, so whitespace and
 *  cmd.exe metacharacters are refused outright. */
export function unsafePathReason(p: string, platform: string): string | null {
  if (platform === 'win32') return /[\s"%!^&|<>()`$]/.test(p) ? 'its path has a space or a shell character, which the Windows Codex command cannot quote' : null;
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

function writeNoFollow(dir: string, f: RuntimeFile): void {
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

/** Stage the launcher and shim; throws HookRuntimeUnavailable with the reason. */
export function stageHookRuntime(o: {
  dir: string; hiveRoot: string | null; platform: string; launcher: RuntimeFile; shim: RuntimeFile;
}): StagedHookRuntime {
  const fail = (why: string): never => { throw new HookRuntimeUnavailable(why); };
  if (typeof o.dir !== 'string' || !isAbsolute(o.dir)) fail('its folder is not an absolute path');
  const unsafe = unsafePathReason(o.dir, o.platform);
  if (unsafe) fail(unsafe);
  if (!o.hiveRoot) fail('the hive folder is not known yet, so the runtime cannot be shown to be outside it');
  if (overlaps(o.dir, o.hiveRoot as string)) fail('its folder overlaps the hive folder, which every agent can write');
  try { mkdirSync(o.dir, { recursive: true, mode: 0o700 }); } catch (e) { fail(`its folder could not be created (${(e as Error).message})`); }
  const st = lstatSync(o.dir);
  if (st.isSymbolicLink() || !st.isDirectory()) fail('its folder is a link or not a folder');
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) fail('its folder belongs to another user');
  try {
    chmodSync(o.dir, 0o700);
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

/** The first root that holds the runtime folder or sits inside it; 'unknown' when a root could not be read. */
export function rootOverlap(rt: StagedHookRuntime, roots: Array<string | null>): string | null {
  for (const r of roots) {
    if (r === null) return 'a write root could not be read';
    if (r && overlaps(rt.dir, r)) return 'the agent may write the hook runtime folder through its working directory or a write root';
  }
  return null;
}
