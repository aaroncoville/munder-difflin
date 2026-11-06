import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const refreshedRoots = new WeakMap<object, Set<string>>();

/**
 * Runs `ensureIgnore` on every agent folder of the hive at `root`, once per `owner` and root.
 *
 * Semantic memory mining honours each agent's ignore file, and a stopped agent never passes through
 * spawn, so its file has to be brought up to date at startup. That used to happen only inside the
 * first hive commit, which a hive with commits turned off never makes.
 */
export function refreshMineIgnoresOnce(owner: object, root: string, ensureIgnore: (agentDir: string) => void): void {
  let roots = refreshedRoots.get(owner);
  if (!roots) {
    roots = new Set();
    refreshedRoots.set(owner, roots);
  }
  if (roots.has(root)) return;
  roots.add(root);
  const agentsDir = join(root, 'agents');
  if (!existsSync(agentsDir)) return;
  try {
    for (const id of readdirSync(agentsDir)) ensureIgnore(join(agentsDir, id));
  } catch { /* best-effort, as the refresh it replaces */ }
}
