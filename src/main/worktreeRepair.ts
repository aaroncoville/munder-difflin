/**
 * Recreate an isolated agent's git worktree when it has gone missing.
 *
 * WHY THIS EXISTS
 * ───────────────
 * `teardownPty` force-removes an isolated agent's worktree the moment its PTY
 * dies (a crash, a manual stop, an idle reap). But the agent RECORD — the floor
 * card, the hive roster, the restore recipe — keeps that worktree path as its
 * cwd, because that is where the agent actually ran. The next restart, model
 * change or auto-revive therefore spawned into a directory that no longer
 * exists and died with `cwd does not exist: …` (four agents in one night).
 *
 * The repair is `git worktree add` back onto the agent's own `agent/<id>`
 * branch, so a worktree that was removed after the agent committed comes back
 * WITH its commits. Uncommitted work in the removed worktree is already gone by
 * then — nothing here can bring it back, which is exactly why the repair never
 * touches a worktree that still exists.
 *
 * THE ORIGIN SIDECAR
 * ──────────────────
 * `git worktree add` has to run from the PARENT repo, and by repair time every
 * in-memory pointer to it is gone: the maps are cleared on teardown, `git`'s
 * own registration is pruned by `worktree remove`, and the agent record stores
 * only the worktree path (its base repo survives as a bare basename, if at
 * all). So the parent repo is recorded, at creation time, in a tiny JSON
 * sidecar in the worktrees root itself — the one place derivable from just the
 * missing path.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentBranchFor, defaultBaseBranch, isRegisteredWorktree, pruneWorktrees, runGit } from './git';

/** `<worktrees root>/.origins.json` — the sidecar for the worktree at `wtPath`.
 *  Derived from the path alone so a repair needs no other state. */
function originsFile(wtPath: string): string {
  return join(dirname(wtPath), '.origins.json');
}

function readOrigins(wtPath: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(originsFile(wtPath), 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, string> : {};
  } catch { return {}; }
}

/** Remember which repo `wtPath` was cut from. Best-effort: a failure here only
 *  costs a later repair its automatic origin, never the spawn. */
export function recordWorktreeOrigin(wtPath: string, origCwd: string): void {
  try {
    const file = originsFile(wtPath);
    const map = readOrigins(wtPath);
    if (map[wtPath] === origCwd) return;
    map[wtPath] = origCwd;
    // Atomic: several agents can be spawning at once, and a half-written
    // sidecar would lose every other agent's origin, not just this one's.
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch { /* best-effort bookkeeping */ }
}

/** The repo `wtPath` was cut from, or null if we never recorded it. */
export function lookupWorktreeOrigin(wtPath: string): string | null {
  const found = readOrigins(wtPath)[wtPath];
  return typeof found === 'string' && found ? found : null;
}

/** Forget `wtPath`'s origin (called when a worktree is deliberately retired). */
export function forgetWorktreeOrigin(wtPath: string): void {
  try {
    const map = readOrigins(wtPath);
    if (!(wtPath in map)) return;
    delete map[wtPath];
    const file = originsFile(wtPath);
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(map, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch { /* best-effort bookkeeping */ }
}

export type WorktreeRepair =
  | { ok: true; branch: string; origCwd: string; recreated: boolean }
  | { ok: false; error: string };

/** The hand-fix to print when we can't do it ourselves. */
function manualFix(wtPath: string, origCwd: string | null, branch: string): string {
  const repo = origCwd ?? '<the repo this agent works in>';
  return `git -C "${repo}" worktree add "${wtPath}" ${branch}`;
}

/**
 * Ensure the agent worktree at `wtPath` exists, recreating it if it doesn't.
 *
 * No-op (and never destructive) when the directory is still there. `origCwd`
 * overrides the sidecar lookup — pass it when the caller still holds the live
 * pointer. Returns a failure carrying the exact command that fixes it by hand
 * rather than silently falling back to the base repo: an agent spawned in the
 * shared checkout instead of its own worktree can clobber other agents' work,
 * which is the very thing isolation exists to prevent.
 */
export async function repairMissingWorktree(wtPath: string, origCwd?: string): Promise<WorktreeRepair> {
  const branch = agentBranchFor(wtPath);
  if (existsSync(wtPath)) {
    return { ok: true, branch, origCwd: origCwd ?? lookupWorktreeOrigin(wtPath) ?? '', recreated: false };
  }
  const repo = origCwd ?? lookupWorktreeOrigin(wtPath);
  if (!repo || !existsSync(repo)) {
    return {
      ok: false,
      error: `agent worktree is missing and its source repo is ${repo ? `gone (${repo})` : 'unknown'}: ${wtPath}`
        + ` — recreate it with: ${manualFix(wtPath, repo, branch)}`
    };
  }
  // `git worktree remove` prunes its own registration, but a hand-deleted (or
  // externally reaped) directory leaves a stale one behind that makes `worktree
  // add` refuse the path. `prune` only drops records whose directory is already
  // gone, so this can never disturb a live worktree — this agent's or anyone's.
  if (await isRegisteredWorktree(repo, wtPath)) await pruneWorktrees(repo);

  const hasBranch = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
  const add = hasBranch.ok
    // The branch outlived the worktree, so its commits come back with it.
    ? await runGit(repo, ['worktree', 'add', wtPath, branch])
    // No branch either (first spawn after a full cleanup) — cut a fresh one off
    // the repo's base branch, exactly as the original isolation did.
    : await runGit(repo, ['worktree', 'add', wtPath, '-b', branch, await defaultBaseBranch(repo)]);
  if (!add.ok) {
    return {
      ok: false,
      error: `could not recreate agent worktree ${wtPath}: ${add.error}`
        + ` — recreate it with: ${manualFix(wtPath, repo, branch)}`
    };
  }
  return { ok: true, branch, origCwd: repo, recreated: true };
}
