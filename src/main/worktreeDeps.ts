/**
 * Symlink an isolated agent worktree's node_modules to the base checkout so
 * that `npm run typecheck` and `node --test` work without a full install.
 *
 * WHY THIS EXISTS
 * ───────────────
 * An isolated worktree has no node_modules of its own: it is a bare git
 * checkout, not a fresh project. Running `npm run typecheck` there therefore
 * fails with `error TS2688: Cannot find type definition file for 'node'` —
 * errors that look like broken code but are actually a missing toolchain.
 * Two workers burned ~3 M tokens each chasing that phantom before this fix.
 *
 * A symlink costs microseconds and zero disk space, and the worktree's
 * package.json matches the base (same repo, same branch) so there is nothing
 * to reconcile. Do NOT run npm install/ci in the worktree — that replaces the
 * symlink with a full copy and takes 2–4 minutes (electron-rebuild).
 *
 * TEARDOWN SAFETY
 * ───────────────
 * `git worktree remove --force` removes the working tree directory, not its
 * contents through symlinks. The symlink entry is unlinked, not followed.
 * The base checkout's node_modules is therefore safe at teardown. This is
 * verified by the teardown-safety test in test/worktree-deps.test.cjs.
 */

import { existsSync } from 'node:fs';
import { lstat, symlink } from 'node:fs/promises';
import { join } from 'node:path';

export type DepLink =
  | { ok: true; skipped: boolean }
  | { ok: false; error: string };

/**
 * Symlink `<baseDir>/node_modules` → `<wtDir>/node_modules`.
 *
 * Skipped (ok:true, skipped:true) when:
 *   - baseDir has no node_modules (nothing to link)
 *   - wtDir already has any node_modules entry (symlink or real dir)
 *
 * Returns {ok:false, error} on failure — NON-FATAL: caller logs and continues.
 */
export async function linkWorktreeDeps(baseDir: string, wtDir: string): Promise<DepLink> {
  const baseNodeModules = join(baseDir, 'node_modules');
  const wtNodeModules = join(wtDir, 'node_modules');
  if (!existsSync(baseNodeModules)) return { ok: true, skipped: true };
  // lstat does not follow symlinks — detects both real dirs and (dangling) symlinks.
  try { await lstat(wtNodeModules); return { ok: true, skipped: true }; } catch { /* does not exist */ }
  try {
    await symlink(baseNodeModules, wtNodeModules);
    return { ok: true, skipped: false };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
