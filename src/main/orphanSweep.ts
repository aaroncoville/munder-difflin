/**
 * Startup migration (#57/#58): archive every agent entry that is `archived:false` but has NO live PTY. It runs in
 * bootstrapHiveServices, BEFORE the renderer can respawn anything, so at that point no agent owns a PTY and every
 * `archived:false` entry is a stale carry-over from a session that quit or crashed without archiving. Left as-is they
 * have no live PTY, so the breaker beat steers them and the steer bounces to god as a requires_reply god can't clear.
 *
 * It runs on the main thread after app ready and before the window exists, so it must never wait on git: a main thread
 * busy past ~12-16 s there stops Electron's network service from starting and the window never loads (#109). Each
 * setArchived only queues a hive commit (#106); the queue folds them into one background commit.
 *
 * God is never archived. A user's real agents are unaffected: the "restore team" flow respawns them through
 * ensureAgent, which re-clears `archived`.
 */
import type { HiveManager } from './hive';

/** Archives each orphan; returns the ids archived. `hasLivePty` is the app's PTY map. `onArchived` is told each id as
 *  soon as it is archived, so an error later in the sweep loses no record of the ones already done. */
export function archiveOrphanedAgents(
  hive: Pick<HiveManager, 'enabled' | 'registry' | 'setArchived'>,
  hasLivePty: (agentId: string) => boolean,
  onArchived: (agentId: string) => void = () => {}
): string[] {
  if (!hive.enabled()) return [];
  const reg = hive.registry();
  const archived: string[] = [];
  for (const [id, a] of Object.entries(reg.agents)) {
    if (a.archived) continue;
    if (id === reg.godId) continue;   // god is never archived
    if (hasLivePty(id)) continue;     // has a live PTY → genuinely active
    hive.setArchived(id, true);       // stale archived:false orphan → archive
    archived.push(id);
    onArchived(id);
  }
  return archived;
}
