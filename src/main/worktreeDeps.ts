import { existsSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, readlink, realpath, rmdir, symlink, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export type DepLink =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

export type DepUnlink =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };

/** The folders npm writes inside rather than replacing. Through a link to one of these, `npm uninstall @scope/a` would
 *  delete the base's package and removing a package's bin would delete the base's. */
function npmWritesInside(name: string): boolean {
  return name === '.bin' || name.startsWith('@');
}

function linkEntry(target: string, link: string): Promise<void> {
  return symlink(target, link, process.platform === 'win32' ? 'junction' : null);
}

/**
 * Link the base checkout's dependencies into an isolated worktree: a real node_modules directory with each package a
 * link into the base. A link to the base's whole folder is not safe, because `npm ci` empties node_modules by listing
 * it and removing each entry, so through that link it empties the base. npm only ever removes or replaces a package
 * link itself, so @scope folders and .bin are real folders too, holding a link per entry. This costs no more than one
 * link per package, where a copy would cost the whole install on every spawn. Plain files are not linked, because a
 * Windows junction cannot point at a file: npm's .package-lock.json is left out, and .bin's shims are copied, which
 * works because they find their package relative to themselves.
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
      const from = join(baseNodeModules, entry.name);
      const to = join(worktreeNodeModules, entry.name);
      if (!npmWritesInside(entry.name)) {
        await linkEntry(from, to);
        continue;
      }
      await mkdir(to);
      for (const inner of await readdir(from, { withFileTypes: true })) {
        if (inner.isFile()) await copyFile(join(from, inner.name), join(to, inner.name));
        else await linkEntry(join(from, inner.name), join(to, inner.name));
      }
    }
    return { ok: true, skipped: false };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** Whether `here` is what linkWorktreeDeps put there for `base`: a link from a name to the same name in the base, or
 *  an unchanged copy of a plain file. */
async function isOurs(base: string, here: string, isLink: boolean): Promise<boolean> {
  if (isLink) return resolve(here, '..', await readlink(here)) === base;
  try {
    return (await readFile(here)).equals(await readFile(base));
  } catch {
    return false;
  }
}

/** Remove what linkWorktreeDeps made, and any folder that empties. Anything else the worktree put there stays. */
async function unlinkEntries(base: string, here: string, nested = false): Promise<DepUnlink> {
  let removed = false;
  for (const entry of await readdir(here, { withFileTypes: true })) {
    const entryBase = join(base, entry.name);
    const entryHere = join(here, entry.name);
    if (entry.isDirectory() && !nested && npmWritesInside(entry.name)) {
      const inner = await unlinkEntries(entryBase, entryHere, true);
      if (inner.ok && inner.removed) removed = true;
    } else if ((entry.isSymbolicLink() || (nested && entry.isFile())) && await isOurs(entryBase, entryHere, entry.isSymbolicLink())) {
      await unlink(entryHere);
      removed = true;
    }
  }
  if (removed && (await readdir(here)).length === 0) await rmdir(here);
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
