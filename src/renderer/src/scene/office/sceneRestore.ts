/**
 * Rebuilding the scene without replaying the walk-in.
 *
 * glRecovery.ts explains WHY the scene is rebuilt: Chromium evicts the oldest
 * WebGL context in the process, that is always the office floor's, and the only
 * fix Pixi leaves us is to tear the scene down and build it again. The rebuild
 * goes through the ordinary mount path, which is exactly what makes it safe —
 * and also what makes it visible. Every Character is constructed cold, so each
 * one appears at the office door and walks to a desk, and desks are re-claimed
 * in whatever order the agents happen to be rebuilt in, so an agent can come
 * back to somebody else's chair. Switching agents opens terminals, terminals
 * take contexts, and the floor visibly resets.
 *
 * This module is the memory across that gap: a placement snapshot taken at
 * teardown and read back when the characters are recreated. It is deliberately
 * free of Pixi, the map renderer and React — it takes plain numbers and
 * predicates — so the whole restore policy is testable against a Map literal
 * with no browser and no GPU, the same seam glRecovery.ts uses.
 *
 * It does NOT stop the eviction and it is not meant to; it removes the
 * annoyance, not the cause. See docs/investigations/T-071-floor-reset.md.
 */

export interface SnapshotTile { x: number; y: number }

export interface AgentPlacement {
  /** Index into the mount's ordered seat list, or null if it never got a desk. */
  seatIndex: number | null;
  /** The tile the avatar actually occupied when the scene was torn down. */
  tile: SnapshotTile;
}

export interface SceneSnapshot {
  /** The theme these placements were measured against. Seat indices and tiles
   *  are indices into ONE map; replaying them onto another map would seat
   *  agents inside walls, so a theme change discards the whole snapshot. */
  theme: string;
  agents: Record<string, AgentPlacement>;
}

/** What the capture reads off a live runtime — structural, so the real
 *  Runtime/Character satisfy it without either module importing the other. */
export interface PlacedRuntime {
  seatIndex: number | null;
  character: { getTilePosition(): SnapshotTile } | null | undefined;
}

/** What the restore needs to know about the floor being built right now. */
export interface FloorProbe {
  /** How many seats this mount's ordered seat list has. */
  seatCount: number;
  /** Has this seat not already been claimed by an earlier agent this mount? */
  isSeatFree(seatIndex: number): boolean;
  /** Can an avatar stand here on the current map? */
  isWalkable(x: number, y: number): boolean;
}

function finiteInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Snapshot where everyone is, for the next mount to read.
 *
 * Runs inside the effect cleanup, alongside the context-loss uninstall, against
 * characters that are about to be destroyed — so it must be total. A runtime
 * that is half torn down (no character, a getter that throws, a NaN position)
 * is SKIPPED rather than allowed to throw: taking the cleanup down with it
 * would leave the loss listener installed on a dead scene, which is a worse bug
 * than the reset this exists to fix.
 */
export function captureSceneSnapshot(
  theme: string,
  runtimes: Iterable<[string, PlacedRuntime]>
): SceneSnapshot {
  const agents: Record<string, AgentPlacement> = {};
  for (const [id, rt] of runtimes) {
    try {
      const tile = rt?.character?.getTilePosition?.();
      if (!tile || !finiteInt(tile.x) || !finiteInt(tile.y)) continue;
      agents[id] = {
        seatIndex: finiteInt(rt.seatIndex) ? rt.seatIndex : null,
        // Copy: the scene keeps ticking while it is being torn down.
        tile: { x: tile.x, y: tile.y }
      };
    } catch {
      // A character mid-destroy has nothing useful to say about its position.
      continue;
    }
  }
  return { theme, agents };
}

/**
 * Where this agent should be seeded on the mount being built, or `null` to fall
 * back to the cold path (claim the next free desk, walk in through the door).
 *
 * Each half degrades on its own: a desk taken by an earlier agent this mount
 * still leaves the position worth restoring, and a remembered tile that is not
 * walkable on this map still leaves the desk worth restoring.
 */
export function restorePlacement(
  snapshot: SceneSnapshot | null | undefined,
  theme: string,
  agentId: string,
  floor: FloorProbe
): { seatIndex: number | null; spawnTile: SnapshotTile | null } | null {
  if (!snapshot || snapshot.theme !== theme || !snapshot.agents) return null;
  const placement = snapshot.agents[agentId];
  if (!placement) return null;

  const seat = placement.seatIndex;
  const seatIndex =
    finiteInt(seat) && seat >= 0 && seat < floor.seatCount && floor.isSeatFree(seat)
      ? seat
      : null;

  const t = placement.tile;
  const spawnTile =
    t && finiteInt(t.x) && finiteInt(t.y) && floor.isWalkable(t.x, t.y)
      ? { x: t.x, y: t.y }
      : null;

  return { seatIndex, spawnTile };
}

/**
 * The placement to seed a character with on this mount, with the god rule
 * applied — what `addCharacter` actually calls.
 *
 * The seat and the position are separate rules and only the SEAT is Michael's.
 * Seat 0 is the god desk and `claimSeat` is the one place that rule lives, so
 * the god's remembered seat is dropped here and re-dealt there rather than
 * being restored (which would put a second copy of the rule on this path). His
 * POSITION is orthogonal, and restoring it is the whole point of the feature on
 * the agent most likely to be on screen: excluding the god from both halves
 * meant Michael marched in through the office door on every single eviction.
 */
export function seedPlacement(
  snapshot: SceneSnapshot | null | undefined,
  theme: string,
  agent: { id: string; isGod?: boolean },
  floor: FloorProbe
): { seatIndex: number | null; spawnTile: SnapshotTile | null } | null {
  const restored = restorePlacement(snapshot, theme, agent.id, floor);
  if (!restored) return null;
  return agent.isGod ? { seatIndex: null, spawnTile: restored.spawnTile } : restored;
}

/**
 * Fold a fresh capture into the one already remembered.
 *
 * Characters are built asynchronously (`await theme.cast.getFrames`), so an
 * eviction STORM — a second context loss inside the ~1.5s rebuild delay — can
 * tear a mount down before any of its characters exist. Capturing that mount
 * yields `{ theme, agents: {} }`, and assigning it straight onto the ref would
 * write an empty snapshot over a good one: the next rebuild would then be a full
 * cold start with everyone walking in through the door, which is exactly the
 * jank T-071 exists to remove. It is a LOSS, not a leak — and the storm is
 * precisely the case the feature targets, so it matters more than its narrow
 * window suggests.
 *
 * Keeping the older entries is safe because a placement is only ever consulted
 * for an agent still in the store: an agent that left leaves a dead entry that
 * `syncAgents` never looks up and that holds no seat claim.
 *
 * A THEME CHANGE still discards outright. Seat indices and tiles index ONE map,
 * so merging across themes would resurrect office placements onto the spaceship
 * and seat agents inside walls — including when the new capture is empty.
 */
export function mergeSceneSnapshot(
  previous: SceneSnapshot | null | undefined,
  fresh: SceneSnapshot
): SceneSnapshot {
  if (!previous || previous.theme !== fresh.theme || !previous.agents) return fresh;
  return { theme: fresh.theme, agents: { ...previous.agents, ...fresh.agents } };
}
