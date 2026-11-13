import { createHash } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import { access, cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
 * Keyed by the hive's real path, so two hives (or a hive whose data folder changed) never share one.
 */
export function hiveGitDirFor(base: string, hiveRoot: string): string {
  let real = resolve(hiveRoot);
  try { real = realpathSync(hiveRoot); } catch { /* not created yet: the resolved path names it */ }
  return join(base, `${createHash('sha256').update(real).digest('hex').slice(0, 16)}.git`);
}

/** The path a `.git` file points at, or null when it is not a well-formed gitfile. */
export async function readGitfile(file: string): Promise<string | null> {
  try {
    const m = /^gitdir: (.+?)\s*$/m.exec(await readFile(file, 'utf8'));
    return m && isAbsolute(m[1]) ? m[1] : null;
  } catch {
    return null;
  }
}

export type SettleResult =
  | { ok: true; action: 'none' | 'moved' | 'adopted' | 'finished' | 'ignored-folder' | 'not-adopted'; note?: string }
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
 * Make a git directory that came from where an agent could write it safe to run git on: whatever config, hooks or
 * redirection it carried is set aside, and `git init` writes a fresh config that points at the hive. Objects, refs and
 * history stay. Safe to run again.
 */
export async function sanitizeGitDir(gitDir: string, hiveRoot: string, git: GitRunner): Promise<{ ok: boolean; error?: string }> {
  try {
    // Kept once, for whoever reverses the move; a repeated run must not replace it with the clean config.
    if (!(await exists(join(gitDir, 'config.before-move'))) && await exists(join(gitDir, 'config'))) {
      await rename(join(gitDir, 'config'), join(gitDir, 'config.before-move'));
    } else {
      await rm(join(gitDir, 'config'), { force: true });
    }
    // commondir and gitdir redirect git to another directory, and with it to another config.
    for (const name of ['commondir', 'gitdir', 'config.worktree']) await rm(join(gitDir, name), { force: true });
    await rm(join(gitDir, 'hooks'), { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: `could not clear the moved repository's settings: ${(e as Error).message}` };
  }
  const init = await git([`--git-dir=${gitDir}`, `--work-tree=${hiveRoot}`, 'init', '-q'], hiveRoot);
  return init.ok ? { ok: true } : { ok: false, error: `git init on the moved repository failed: ${(init.err || init.out).trim()}` };
}

export async function writeGitfile(hiveRoot: string, target: string): Promise<void> {
  await writeFile(join(hiveRoot, '.git'), `gitdir: ${target}\n`, 'utf8');
}

/**
 * Bring the hive's repository to `target`, the git directory in the app data folder. Every step is safe to interrupt
 * and repeat; nothing that holds history is ever deleted, only renamed or copied.
 *
 * - `hive/.git` is a folder and `target` does not exist: the first move. It is renamed to `target` (copied, checked
 *   and then removed when the two are on different volumes), its settings are replaced (sanitizeGitDir), and
 *   `hive/.git` becomes a gitfile pointing at it, so an older build of the app, and an agent reading history, still
 *   find the same repository.
 * - `target.partial` is left from an interrupted rename: finish it.
 * - `hive/.git` is a folder although `target` exists: something put it there after the move, and an agent could
 *   have. It is never adopted; the app goes on using `target`.
 * - `hive/.git` is a gitfile and `target` does not exist (the hive was copied to a new data folder): the history it
 *   points at is copied in, but only from a git directory in the app's own folder, `base`. Anything else an agent
 *   could have written, so the hive starts a new repository instead.
 */
export async function settleHiveGitDir(hiveRoot: string, base: string, target: string, git: GitRunner): Promise<SettleResult> {
  const dotGit = join(hiveRoot, '.git');
  const partial = `${target}.partial`;
  try {
    await mkdir(base, { recursive: true, mode: 0o700 });
    const st = await lstat(dotGit).catch(() => null);
    const haveTarget = await exists(target);

    if (st?.isDirectory() && !st.isSymbolicLink()) {
      if (haveTarget) return { ok: true, action: 'ignored-folder', note: `${dotGit} is a folder again; the app keeps using ${target} and ignores it` };
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
      await rename(partial, target);
      if (copied) await rm(dotGit, { recursive: true, force: true });
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'moved' };
    }

    if (!st) {
      if (!haveTarget && await exists(partial)) {
        // Interrupted between the two renames: the history is all in the partial, and nothing else holds it.
        const clean = await sanitizeGitDir(partial, hiveRoot, git);
        if (!clean.ok) return { ok: false, error: clean.error! };
        await rename(partial, target);
        await writeGitfile(hiveRoot, target);
        return { ok: true, action: 'finished' };
      }
      if (haveTarget) await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'none' };
    }

    // A gitfile (or something else that is not a folder).
    const pointsAt = st.isFile() ? await readGitfile(dotGit) : null;
    if (haveTarget) {
      if (pointsAt !== target) await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'none' };
    }
    if (pointsAt && resolve(dirname(pointsAt)) === resolve(base) && await exists(pointsAt)) {
      await rm(partial, { recursive: true, force: true });
      await cp(pointsAt, partial, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
      const clean = await sanitizeGitDir(partial, hiveRoot, git);
      if (!clean.ok) return { ok: false, error: clean.error! };
      await rename(partial, target);
      await writeGitfile(hiveRoot, target);
      return { ok: true, action: 'adopted', note: `copied the history from ${pointsAt}` };
    }
    return {
      ok: true,
      action: 'not-adopted',
      note: pointsAt ? `${dotGit} points at ${pointsAt}, which is not in the app's own folder; a new repository is started` : undefined
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Whether the hive has a repository, in either place, so a commit has somewhere to go. */
export function hiveRepoPresent(hiveRoot: string, target: string | null): boolean {
  return (target !== null && existsSync(target)) || existsSync(join(hiveRoot, '.git'));
}
