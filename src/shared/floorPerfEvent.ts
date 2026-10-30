/**
 * The one event the renderer may append to the hive log itself: a floor
 * performance sample (src/renderer/src/scene/office/floorPerf.ts). Main
 * accepts nothing else over that channel — the log is the hive's record,
 * and a renderer must not be able to write arbitrary kinds into it — and
 * caps the size, in UTF-8 bytes as the log is written, so a runaway sample
 * cannot bloat log.jsonl. The sampler applies the same check before the
 * IPC, so an oversized sample is never sent.
 */

export const FLOOR_PERF_KIND = 'floor-perf';
export const FLOOR_PERF_MAX_BYTES = 8 * 1024;

/** The UTF-8 length of `s`: TextEncoder in the renderer, Buffer in main. */
export function utf8Bytes(s: string): number {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  return Buffer.byteLength(s, 'utf8');
}

/** The event main appends, or null when the renderer's payload is refused:
 *  not an object, not kind 'floor-perf', or over the size cap. `ts` is
 *  main's (appendLog stamps it), so a renderer-supplied one is dropped. */
export function acceptFloorPerfEvent(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (event.kind !== FLOOR_PERF_KIND) return null;
  const { ts: _ts, ...rest } = event;
  let text: string;
  try { text = JSON.stringify(rest); } catch { return null; }
  if (typeof text !== 'string' || utf8Bytes(text) > FLOOR_PERF_MAX_BYTES) return null;
  return rest;
}
