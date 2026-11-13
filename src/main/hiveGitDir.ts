import { createHash } from 'node:crypto';
import { constants, cpSync, existsSync, realpathSync, writeFileSync } from 'node:fs';
import { access, cp, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitRunner } from './hiveCommit';

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
  | { ok: true; action: 'none' | 'moved' | 'finished' | 'set-aside' | 'not-adopted'; note?: string }
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

/**
 * Everything in a git directory that decides what git runs or where it looks, apart from objects and refs. A git
 * directory imported from where an agent could write it keeps none of these: the history stays, and the app writes the
 * rest itself.
 * - `config` (with any include/includeIf), `config.worktree`: settings that name programs. The old config is kept,
 *   inert, as `config.before-move` for whoever reverses the move; git never reads that name.
 * - `hooks/`: programs.
 * - `commondir`, `gitdir`: send git to another directory, and with it another config.
 * - `modules/`: the git directories of submodules, each with a config of its own that git reads when it looks inside
 *   them.
 * - `info/attributes`: can route files through filters and other drivers. `info/exclude` changes what is recorded;
 *   the hive keeps its rules in .gitignore.
 * - `objects/info/alternates`, `objects/info/http-alternates`: make git read objects from elsewhere. History that
 *   really lives there would be lost by removing them, so the objects are first copied in (see sanitizeGitDir).
 * The fresh config `git init` writes has no include or includeIf, so nothing the old config pulled in survives.
 */
const IMPORTED_SETTINGS = ['config.worktree', 'hooks', 'commondir', 'gitdir', 'modules', 'info/attributes', 'info/exclude'];
const ALTERNATES = ['objects/info/alternates', 'objects/info/http-alternates'];

/** Replace what git executes or follows in `gitDir` with what the app writes. Objects, refs and history stay. Safe to
 *  run again. */
export async function sanitizeGitDir(gitDir: string, hiveRoot: string, git: GitRunner): Promise<{ ok: boolean; error?: string }> {
  try {
    // Kept once, for whoever reverses the move; a repeated run must not replace it with the app's config.
    if (!(await exists(join(gitDir, 'config.before-move'))) && await exists(join(gitDir, 'config'))) {
      await rename(join(gitDir, 'config'), join(gitDir, 'config.before-move'));
    } else {
      await rm(join(gitDir, 'config'), { force: true });
    }
    for (const name of IMPORTED_SETTINGS) await rm(join(gitDir, name), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `could not clear the imported repository's settings: ${(e as Error).message}` };
  }
  // A fresh config, and no templates: nothing from the owner's template folder either.
  const init = await git([`--git-dir=${gitDir}`, `--work-tree=${hiveRoot}`, 'init', '-q', '--template='], hiveRoot);
  if (!init.ok) return { ok: false, error: `git init on the imported repository failed: ${(init.err || init.out).trim()}` };
  // Objects borrowed through alternates are copied in before the alternates go, under the config just written, so no
  // history is lost. Objects are data: nothing here runs a program the imported directory named. If the copy fails,
  // the alternates stay and the move stops; it is tried again on the next launch.
  if (await exists(join(gitDir, ALTERNATES[0]))) {
    const repack = await git([`--git-dir=${gitDir}`, `--work-tree=${hiveRoot}`, 'repack', '-a', '-d', '-q'], hiveRoot);
    if (!repack.ok) return { ok: false, error: `could not copy in the objects the imported repository borrowed: ${(repack.err || repack.out).trim()}` };
  }
  try {
    for (const name of ALTERNATES) await rm(join(gitDir, name), { force: true });
  } catch (e) {
    return { ok: false, error: `could not remove the imported repository's alternates: ${(e as Error).message}` };
  }
  return { ok: true };
}

export async function writeGitfile(hiveRoot: string, target: string): Promise<void> {
  await writeFile(join(hiveRoot, '.git'), `gitdir: ${target}\n`, 'utf8');
}

/** The name a `hive/.git` folder that appeared after the move is renamed to. The hive's .gitignore excludes it. */
export const SET_ASIDE_PREFIX = '.git.set-aside-';

/**
 * Bring the hive's repository to `target`, the git directory in the app data folder. Every step is safe to interrupt
 * and repeat; nothing that holds history is deleted, only renamed or copied.
 *
 * - `target` exists: it wins, always. A `hive/.git` folder next to it was put there after the move, and an agent could
 *   have: it is renamed aside inside the hive, never read and never adopted. The gitfile is rewritten.
 * - `hive/.git` is a folder and `target` does not exist: the first move. It is renamed to `target` (copied, checked
 *   and then removed across volumes), what it carried that git executes or follows is replaced (sanitizeGitDir), and
 *   the marker is written before the final rename.
 * - `target.partial` is left from an interrupted rename: finish it.
 * - Otherwise there is no history the app may take: the caller starts a new repository. A gitfile pointing elsewhere is
 *   not followed.
 */
export async function settleHiveGitDir(hiveRoot: string, base: string, target: string, git: GitRunner): Promise<SettleResult> {
  const dotGit = join(hiveRoot, '.git');
  const partial = `${target}.partial`;
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const st = await lstat(dotGit).catch(() => null);
    const isFolder = !!st && st.isDirectory() && !st.isSymbolicLink();

    if (await exists(target)) {
      let note: string | undefined;
      if (isFolder) {
        const aside = join(hiveRoot, `${SET_ASIDE_PREFIX}${Date.now()}`);
        await rename(dotGit, aside);
        note = `${dotGit} was a folder again; renamed to ${aside}, not read`;
      } else if (st) {
        await rm(dotGit, { force: true });
      }
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: note ? 'set-aside' : 'none', ...(note ? { note } : {}) };
    }

    if (isFolder) {
      await rm(partial, { recursive: true, force: true });
      let copied = false;
      try {
        await rename(dotGit, partial);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
        await cp(dotGit, partial, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
        if ((await listing(partial)) !== (await listing(dotGit))) return { ok: false, error: `the copy of ${dotGit} does not match it; nothing was moved` };
        copied = true;
      }
      const clean = await sanitizeGitDir(partial, hiveRoot, git);
      if (!clean.ok) return { ok: false, error: clean.error! };
      writeMarker(partial, dotGit);
      await rename(partial, target);
      if (copied) await rm(dotGit, { recursive: true, force: true });
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'moved' };
    }

    if (!st && await exists(partial)) {
      // Interrupted between the two renames: the history is all in the partial, and nothing else holds it.
      const clean = await sanitizeGitDir(partial, hiveRoot, git);
      if (!clean.ok) return { ok: false, error: clean.error! };
      writeMarker(partial, dotGit);
      await rename(partial, target);
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'finished' };
    }

    // A gitfile (or anything else) and no target: never followed. The caller starts a new repository.
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
 * old hive (it is doing the move), so the history comes from the app's own folder, never from a gitfile. Synchronous,
 * like the rest of that move, which runs with every service stopped.
 */
export function carryHiveGitDir(base: string, oldHiveRoot: string, newHiveRoot: string): boolean {
  const from = hiveGitDirFor(base, oldHiveRoot);
  const to = hiveGitDirFor(base, newHiveRoot);
  if (!existsSync(from) || existsSync(to)) return false;
  cpSync(from, to, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  writeMarker(to, from);
  return true;
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
