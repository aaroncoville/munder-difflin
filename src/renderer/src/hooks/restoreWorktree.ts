export interface RestoreWorktreePlan {
  cwd: string;
  isolate: boolean;
  action: string;
}

export interface RestoredWorktreeResult {
  action: string;
  worktreePath: string | undefined;
}

/** Choose the checkout a restored agent runs in without ever degrading an
 * isolated agent to the shared base checkout. */
export function restoreWorktreePlan(
  baseCwd: string,
  worktreePath: string | undefined,
  worktreeIsRepo: boolean
): RestoreWorktreePlan {
  if (!worktreePath) return { cwd: baseCwd, isolate: false, action: 'starting up' };
  if (worktreeIsRepo) return { cwd: worktreePath, isolate: false, action: 'starting up' };
  return { cwd: baseCwd, isolate: true, action: 'worktree missing — recreating' };
}

/** A failed recreate still starts the terminal in the base repo, so make that
 * visible and do not retry the dead saved path on the next restore. */
export function restoredWorktreeResult(
  plan: RestoreWorktreePlan,
  spawnedWorktreePath: string | undefined,
  savedWorktreePath: string | undefined
): RestoredWorktreeResult {
  if (plan.isolate && !spawnedWorktreePath) {
    return { action: 'worktree gone — using base repo', worktreePath: undefined };
  }
  return { action: plan.action, worktreePath: spawnedWorktreePath ?? savedWorktreePath };
}
