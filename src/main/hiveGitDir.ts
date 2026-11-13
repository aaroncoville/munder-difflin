import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, cpSync, existsSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { access, copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitRunner } from './hiveCommit';
import { HIVE_MAINTENANCE_TIMEOUT_MS } from './hiveCommit';

/**
 * Where the hive repository's git directory lives: in the app's data folder, never inside the hive.
 *
 * Every agent may write the hive folder, and the app runs git there outside any sandbox. A git directory inside the
 * hive lets an agent decide what that git executes: a hook, `core.fsmonitor`, a filter driver, or a `commondir` that
 * points git at a config of the agent's choosing. The app data folder is one no agent may write (an agent whose write
 * roots reach it is refused), so the hive's git runs as `git --git-dir=<here> --work-tree=<hive>` and reads only
 * config the app wrote. A `.gitattributes` in the hive can still name a filter, but the filter's command lives in that
 * config, so it names nothing that runs.
 *
 * One rule decides everything below: after the first move, this directory never takes content or direction from a
 * place an agent can write. The `hive/.git` gitfile is written for older builds and for agents reading history; the
 * app never reads it.
 *
 * Keyed by the hive's real path, so two hives (or a hive whose data folder changed) never share one.
 */
export function hiveGitDirFor(base: string, hiveRoot: string): string {
  let real = resolve(hiveRoot);
  try { real = realpathSync(hiveRoot); } catch { /* not created yet: the resolved path names it */ }
  return join(base, `${createHash('sha256').update(real).digest('hex').slice(0, 16)}.git`);
}

/** Written into the git directory once the app owns it: when, and where its history came from. */
export const HIVE_GIT_MARKER = 'hive-git.json';

export function writeMarker(gitDir: string, source: string | null): void {
  writeFileSync(join(gitDir, HIVE_GIT_MARKER), JSON.stringify({ adoptedAt: new Date().toISOString(), source }, null, 2) + '\n', 'utf8');
}

export type SettleResult =
  | { ok: true; action: 'none' | 'moved' | 'set-aside' | 'not-adopted' | 'refused-import'; note?: string }
  | { ok: false; error: string };

const exists = async (p: string): Promise<boolean> => access(p, constants.F_OK).then(() => true, () => false);

/** Every file under `dir` with its size, to check a copy without running git on a folder an agent could write. */
async function listing(dir: string): Promise<string> {
  const out: string[] = [];
  const walk = async (d: string, rel: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(p, r);
      else out.push(`${r}\t${(await lstat(p)).size}`);
    }
  };
  await walk(dir, '');
  return out.sort().join('\n');
}

/** The first symlink anywhere under `dir` (or `dir` itself), or null. Never follows one. */
async function findSymlink(dir: string): Promise<string | null> {
  const st = await lstat(dir).catch(() => null);
  if (!st) return null;
  if (st.isSymbolicLink()) return dir;
  if (!st.isDirectory()) return null;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const found = e.isSymbolicLink() ? join(dir, e.name) : e.isDirectory() ? await findSymlink(join(dir, e.name)) : null;
    if (found) return found;
  }
  return null;
}

/**
 * What a git directory imported from the hive may bring: its history, and nothing else. Everything not named here
 * (config, hooks, info/, modules/, commondir, MERGE_HEAD and the other in-progress operations, shallow, and anything a
 * later git adds) comes fresh from `git init --template=` or not at all. An allowlist answers "is anything missing?"
 * by construction, where a list of what to remove cannot.
 * - `HEAD`, only if it is a branch name or a commit id.
 * - `refs/` and `packed-refs`, without `refs/replace/` (replace refs swap one object for another when read).
 * - `objects/`, after the objects it borrowed through alternates are copied in; then without the alternates.
 * - `index`, so the first commit does not see every file as new; `logs/`, the reflog.
 * Nothing in it may be a symlink: a link would leave part of the directory where an agent can write it.
 */
const IMPORTED = ['HEAD', 'refs', 'packed-refs', 'objects', 'index', 'logs'];
const HEAD_FORMAT = /^(ref: refs\/heads\/[^\s]+|[0-9a-f]{40}|[0-9a-f]{64})\s*$/;

/**
 * Why the git directory being imported cannot be, or null. Checked on the source before anything is copied; the copy
 * itself also stops at any symlink it meets, should one appear in between.
 */
async function refusal(source: string): Promise<string | null> {
  const link = await findSymlink(source);
  if (link) return `it holds a symlink (${link})`;
  if (await exists(join(source, 'shallow'))) return 'it is a shallow repository, so its history is incomplete';
  const head = await readFile(join(source, 'HEAD'), 'utf8').catch(() => null);
  if (head === null || !HEAD_FORMAT.test(head)) return 'its HEAD is not a branch or a commit';
  return null;
}

/**
 * Copy `from` to `to`: folders are made by the app, files are copied (a clone where the volume can make one, else a
 * full copy). Never a rename or a link: no file in the result is one an agent could reach before, through a hard link
 * or a descriptor it holds open for writing. A symlink, or anything that is not a file or folder, stops the import.
 */
async function copyFresh(from: string, to: string): Promise<void> {
  const st = await lstat(from);
  if (st.isSymbolicLink()) throw new Refused(`it holds a symlink (${from})`);
  if (st.isDirectory()) {
    await mkdir(to, { recursive: true, mode: 0o700 });
    for (const name of await readdir(from)) await copyFresh(join(from, name), join(to, name));
    return;
  }
  if (!st.isFile()) throw new Refused(`it holds something that is not a file or a folder (${from})`);
  await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
}

class Refused extends Error {}

/** Anything under `dir` that is not a plain file or folder (a symlink above all), which stops the import. */
async function strayEntry(dir: string): Promise<string | null> {
  const st = await lstat(dir);
  if (st.isSymbolicLink()) return `it holds a symlink (${dir})`;
  if (st.isDirectory()) {
    for (const name of await readdir(dir)) {
      const found = await strayEntry(join(dir, name));
      if (found) return found;
    }
    return null;
  }
  return st.isFile() ? null : `it holds something that is not a file or a folder (${dir})`;
}

/**
 * Copy one imported entry. On macOS that is `/bin/cp -c -R`: clonefile(2), so a clone costs no space and next to no
 * time, and cp falls back to a plain copy where the volume cannot clone. Node's copyFile cannot clone there (its
 * clone flag is not supported on macOS and silently becomes a full copy). A clone is a new file of its own, so a hard
 * link or an open descriptor on the original cannot reach it. cp copies a symlink as a link, so the result is checked
 * for anything that is not a plain file or folder. Elsewhere copyFresh does it file by file.
 */
async function copyEntry(from: string, to: string): Promise<void> {
  if (process.platform === 'darwin') {
    await new Promise<void>((resolveCopy, reject) => {
      execFile('/bin/cp', ['-c', '-R', from, to], (err, _out, stderr) => (err ? reject(new Error(`cp failed: ${String(stderr).trim() || err.message}`)) : resolveCopy()));
    });
    const stray = await strayEntry(to);
    if (stray) throw new Refused(stray);
    return;
  }
  await copyFresh(from, to);
}

/**
 * Build `partial` from what `source` may bring (IMPORTED), by copy. `source` is not changed. Each copied entry is
 * checked against the original by file list and sizes. Rebuilt from nothing every time, so it is safe to repeat.
 */
async function importInto(source: string, partial: string, hiveRoot: string, git: GitRunner): Promise<{ ok: boolean; refused?: string; error?: string }> {
  await rm(partial, { recursive: true, force: true });
  const init = await git([`--git-dir=${partial}`, `--work-tree=${hiveRoot}`, 'init', '-q', '--template='], hiveRoot);
  if (!init.ok) return { ok: false, error: `git init failed: ${(init.err || init.out).trim()}` };
  try {
    for (const name of IMPORTED) {
      if (!(await exists(join(source, name)))) continue;
      await rm(join(partial, name), { recursive: true, force: true });
      await copyEntry(join(source, name), join(partial, name));
      const st = await lstat(join(source, name));
      const same = st.isDirectory()
        ? (await listing(join(source, name))) === (await listing(join(partial, name)))
        : st.size === (await lstat(join(partial, name))).size;
      if (!same) return { ok: false, error: `the copy of ${name} does not match the original` };
    }
  } catch (e) {
    if (e instanceof Refused) return { ok: false, refused: e.message };
    return { ok: false, error: (e as Error).message };
  }
  await rm(join(partial, 'refs', 'replace'), { recursive: true, force: true });
  const packed = await readFile(join(partial, 'packed-refs'), 'utf8').catch(() => null);
  if (packed !== null) {
    // A peeled line (`^<id>`) belongs to the ref above it, so it goes with it.
    const kept: string[] = [];
    let dropping = false;
    for (const line of packed.split('\n')) {
      if (line.startsWith('^')) { if (!dropping) kept.push(line); continue; }
      dropping = / refs\/replace\//.test(line);
      if (!dropping) kept.push(line);
    }
    await writeFile(join(partial, 'packed-refs'), kept.join('\n'), 'utf8');
  }
  // Objects borrowed through alternates are copied in before the alternates go, so no history is lost. Objects are
  // data: nothing here runs a program the imported directory named. A large repository can take a while, so this gets
  // the maintenance limit rather than a commit's.
  if (await exists(join(partial, 'objects', 'info', 'alternates'))) {
    const repack = await git([`--git-dir=${partial}`, `--work-tree=${hiveRoot}`, 'repack', '-a', '-d', '-q'], hiveRoot, HIVE_MAINTENANCE_TIMEOUT_MS);
    if (!repack.ok) return { ok: false, error: `could not copy in the objects the old repository borrowed: ${(repack.err || repack.out).trim()}` };
  }
  for (const name of ['objects/info/alternates', 'objects/info/http-alternates']) await rm(join(partial, name), { force: true });
  return { ok: true };
}

export async function writeGitfile(hiveRoot: string, target: string): Promise<void> {
  await writeFile(join(hiveRoot, '.git'), `gitdir: ${target}\n`, 'utf8');
}

/** The name a `hive/.git` folder that appeared after the move is renamed to. The hive's .gitignore excludes it. */
export const SET_ASIDE_PREFIX = '.git.set-aside-';

/** A free name next to `path` for keeping something aside. */
async function asideName(path: string, label: string): Promise<string> {
  let name = `${path}.${label}`;
  if (await exists(name)) name = `${name}-${Date.now()}`;
  return name;
}

/** Rename `from` to `aside`; where that crosses volumes, keep it aside inside the hive instead (the hive's .gitignore
 *  excludes that name). Returns where it went. */
async function keepAside(from: string, aside: string, hiveRoot: string): Promise<string> {
  try {
    await rename(from, aside);
    return aside;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
    const inHive = join(hiveRoot, `${SET_ASIDE_PREFIX}${Date.now()}`);
    await rename(from, inHive);
    return inHive;
  }
}

/**
 * Bring the hive's repository to `target`, the git directory in the app data folder. Every step is safe to interrupt
 * and repeat. Nothing that holds history is deleted, and nothing is moved out of the hive before `target` is complete,
 * so until then the hive keeps a working `.git`.
 *
 * - `target` exists: it wins, always. A `hive/.git` folder next to it was put there after the move, and an agent could
 *   have: it is renamed aside inside the hive, never read and never adopted. The gitfile is rewritten.
 * - Otherwise the history comes from `<target>.import` if an earlier build left one (it may be the only copy, so it is
 *   never deleted, and a `hive/.git` folder found beside it is set aside unread), else from the `hive/.git` folder.
 *   That source is refused if it holds a symlink, is shallow or has a HEAD that is not a branch or a commit: it is kept,
 *   unread, as `<target>.refused`, and a new history starts. Otherwise what IMPORTED names is copied into a fresh
 *   `<target>.partial` (importInto), which is renamed to `target`; only then is the source kept aside, whole and unread,
 *   as `<target>.before-move`, and the gitfile written.
 * - If the copy fails, the partial is dropped and the source stays where it was: a `hive/.git` folder in the hive, or
 *   the holding folder put back as `hive/.git`.
 * - With no source, the caller starts a new repository. A gitfile pointing elsewhere is not followed.
 */
export async function settleHiveGitDir(hiveRoot: string, base: string, target: string, git: GitRunner): Promise<SettleResult> {
  const dotGit = join(hiveRoot, '.git');
  const holding = `${target}.import`;
  const partial = `${target}.partial`;
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const st = await lstat(dotGit).catch(() => null);
    const isFolder = !!st && st.isDirectory() && !st.isSymbolicLink();

    if (await exists(target)) {
      // Finish an interrupted move's last step, then hold to the target.
      if (await exists(holding)) await rename(holding, await asideName(target, 'before-move'));
      await rm(partial, { recursive: true, force: true });
      let note: string | undefined;
      if (isFolder) {
        const aside = join(hiveRoot, `${SET_ASIDE_PREFIX}${Date.now()}`);
        await rename(dotGit, aside);
        note = `${dotGit} was a folder; renamed to ${aside}, not read`;
      } else if (st) {
        await rm(dotGit, { force: true });
      }
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: note ? 'set-aside' : 'none', ...(note ? { note } : {}) };
    }

    let source: string | null = null;
    let note: string | undefined;
    if (await exists(holding)) {
      source = holding;
      if (isFolder) {
        const aside = join(hiveRoot, `${SET_ASIDE_PREFIX}${Date.now()}`);
        await rename(dotGit, aside);
        note = `${dotGit} was a folder next to an earlier move's ${holding}; renamed to ${aside}, not read`;
      }
    } else if (isFolder) {
      source = dotGit;
    }

    if (source) {
      const why = await refusal(source);
      const imported = why ? null : await importInto(source, partial, hiveRoot, git);
      const refused = why ?? imported?.refused;
      if (refused) {
        await rm(partial, { recursive: true, force: true });
        const kept = await keepAside(source, await asideName(target, 'refused'), hiveRoot);
        // What is left at hive/.git can only be a gitfile now; the new history writes its own.
        await rm(dotGit, { force: true });
        return { ok: true, action: 'refused-import', note: `the repository in ${source} was not imported because ${refused}; it is kept, unread, at ${kept}, and a new history starts` };
      }
      if (!imported!.ok) {
        await rm(partial, { recursive: true, force: true });
        // Never leave the hive without its repository while the move waits for the next launch.
        if (source === holding && !(await lstat(dotGit).catch(() => null))) await rename(holding, dotGit);
        return { ok: false, error: imported!.error! };
      }
      writeMarker(partial, source);
      await rename(partial, target);
      await keepAside(source, await asideName(target, 'before-move'), hiveRoot);
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'moved', ...(note ? { note } : {}) };
    }

    // No history the app may take.
    await rm(partial, { recursive: true, force: true });
    if (st) {
      await rm(dotGit, { recursive: true, force: true });
      return { ok: true, action: 'not-adopted', note: `${dotGit} was not a folder and no repository exists for this hive in the app's folder; a new history starts` };
    }
    return { ok: true, action: 'none' };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * For a data-folder move: copy the old hive's git directory to the one the new hive's path keys to. The app knows the
 * old hive (it is doing the move), so the history comes from the app's own folder, never from a gitfile. It is copied
 * to a partial folder and renamed into place, so an interrupted copy is never taken for a repository. If the new path
 * already has one (a folder used before), that older history is kept aside and the one being moved is current.
 * Synchronous, like the rest of that move, which runs with every service stopped.
 */
export function carryHiveGitDir(base: string, oldHiveRoot: string, newHiveRoot: string): { carried: boolean; note?: string } {
  const from = hiveGitDirFor(base, oldHiveRoot);
  const to = hiveGitDirFor(base, newHiveRoot);
  if (!existsSync(from)) return { carried: false, note: `no repository for ${oldHiveRoot} in the app's folder; the new folder starts a new history` };
  const partial = `${to}.partial`;
  rmSync(partial, { recursive: true, force: true });
  cpSync(from, partial, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  writeMarker(partial, from);
  let note: string | undefined;
  if (existsSync(to)) {
    let aside = `${to}.superseded`;
    if (existsSync(aside)) aside = `${aside}-${Date.now()}`;
    renameSync(to, aside);
    note = `${newHiveRoot} already had a history; it is kept at ${aside}, and the one carried from ${oldHiveRoot} is current`;
  }
  renameSync(partial, to);
  return { carried: true, note };
}

/** Whether the hive has a repository, in either place, so a commit has somewhere to go. */
export function hiveRepoPresent(hiveRoot: string, target: string | null): boolean {
  return (target !== null && existsSync(target)) || existsSync(join(hiveRoot, '.git'));
}

/** An info/exclude line that matches exactly the folder `path` (relative to the hive), whatever characters it has. */
export function excludeLine(path: string): string | null {
  if (/[\n\r]/.test(path)) return null;
  const escaped = path.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ');
  return `/${escaped}/`;
}
