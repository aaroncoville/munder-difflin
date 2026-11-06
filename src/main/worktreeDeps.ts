import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readlink, realpath, rmdir, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type DepLink =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

export type DepUnlink =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/**
 * Link the base checkout's dependencies into an isolated worktree: a real node_modules directory with each entry a
 * link into the base. A link to the base's whole folder is not safe, because `npm ci` empties node_modules by listing
 * it and removing each entry, so through that link it empties the base. Removing an entry link removes only the link.
 * This costs no more than one link per package, where a copy would cost the whole install on every spawn. Plain files
 * such as npm's .package-lock.json are left out, because a Windows junction cannot point at a file.
 */
export async function linkWorktreeDeps(baseDir: string, worktreeDir: string): Promise<DepLink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');
  if (!existsSync(baseNodeModules)) return { ok: true, skipped: true };

  try {
    await lstat(worktreeNodeModules);
    return { ok: true, skipped: true };
  } catch {
    // node_modules does not exist in this worktree yet.
  }

  try {
    const entries = await readdir(baseNodeModules, { withFileTypes: true });
    await mkdir(worktreeNodeModules);
    for (const entry of entries) {
      if (entry.isFile()) continue;
      await symlink(join(baseNodeModules, entry.name), join(worktreeNodeModules, entry.name), process.platform === 'win32' ? 'junction' : null);
    }
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Remove the entries linkWorktreeDeps made, and the folder if that empties it. A link only counts when it goes from
 *  a name to the same name in the base, so anything else the worktree put there stays. */
async function unlinkEntries(baseNodeModules: string, worktreeNodeModules: string): Promise<DepUnlink> {
  let removed = false;
  for (const entry of await readdir(worktreeNodeModules, { withFileTypes: true })) {
    if (!entry.isSymbolicLink()) continue;
    const link = join(worktreeNodeModules, entry.name);
    if (resolve(worktreeNodeModules, await readlink(link)) !== join(baseNodeModules, entry.name)) continue;
    await unlink(link);
    removed = true;
  }
  if (removed && (await readdir(worktreeNodeModules)).length === 0) await rmdir(worktreeNodeModules);
  return { ok: true, removed };
}

/** Remove the dependency links before testing whether a worktree is dirty. */
export async function unlinkWorktreeDeps(baseDir: string, worktreeDir: string): Promise<DepUnlink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const worktreeNodeModules = join(worktreeDir, 'node_modules');

  try {
    const stat = await lstat(worktreeNodeModules);
    if (stat.isDirectory()) return await unlinkEntries(baseNodeModules, worktreeNodeModules);
    if (!stat.isSymbolicLink()) return { ok: true, removed: false };
    const linkTarget = await readlink(worktreeNodeModules);
    const [baseTarget, worktreeTarget] = await Promise.all([
      realpath(baseNodeModules),
      realpath(resolve(worktreeDir, linkTarget))
    ]);
    if (baseTarget !== worktreeTarget) return { ok: true, removed: false };
    await unlink(worktreeNodeModules);
    return { ok: true, removed: true };
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') return { ok: true, removed: false };
    return { ok: false, error: String(error) };
  }
}
