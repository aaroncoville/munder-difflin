/**
 * The one event the renderer may append to the hive log itself: a floor
 * performance sample (src/renderer/src/scene/office/floorPerf.ts). Main
 * accepts nothing else over that channel — the log is the hive's record,
 * and a renderer must not be able to write arbitrary kinds into it — and
 * caps the size so a runaway sample cannot bloat log.jsonl.
 */

export const FLOOR_PERF_KIND = 'floor-perf';
export const FLOOR_PERF_MAX_BYTES = 8 * 1024;

/** The event main appends, or null when the renderer's payload is refused:
 *  not an object, not kind 'floor-perf', or over the size cap. `ts` is
 *  main's (appendLog stamps it), so a renderer-supplied one is dropped. */
export function acceptFloorPerfEvent(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (event.kind !== FLOOR_PERF_KIND) return null;
  const { ts: _ts, ...rest } = event;
  let size: number;
  try { size = JSON.stringify(rest).length; } catch { return null; }
  if (size > FLOOR_PERF_MAX_BYTES) return null;
  return rest;
}
