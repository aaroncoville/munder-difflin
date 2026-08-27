/**
 * The Study's floor plan, as data.
 *
 * Every position in the painted scene — where an assistant's card rests, where
 * the card table stands, where a candle burns — is a normalized rectangle in
 * `assets/room.json`, in fractions of the backdrop's natural size. The scene
 * scales them onto whatever box the backdrop actually renders into, so the
 * painting can be recomposed, re-generated at another aspect, or swapped
 * wholesale without a line of component code changing.
 *
 * The manifest is authored by hand and shipped in the bundle, so it is not
 * untrusted input in the security sense — but it IS hand-edited, and a berth
 * that has drifted off the canvas or a duplicated id produces a scene that is
 * subtly wrong rather than obviously broken (a card stacked invisibly on
 * another, an anchor hanging past the frame). Validation turns those into a
 * loud failure at load, where they are cheap to find.
 */
import roomJson from './assets/room.json';

/** A normalized rectangle on the backdrop: origin plus size, all in 0..1. */
export interface Berth {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The five fixed props the scene can be clicked on, beyond the desks. */
export interface RoomAnchors {
  /** The task board. */
  cardTable: Berth;
  /** Ask Me — the stack of sealed letters awaiting the human. */
  writingDesk: Berth;
  /** Triggers. */
  almanac: Berth;
  /** Closing Time. */
  hearth: Berth;
  /** The done archive. */
  shelves: Berth;
}

export interface RoomManifest {
  /** Path of the backdrop image, relative to this directory. */
  backdrop: string;
  /** One assistant each, in seating priority order. */
  deskBerths: Berth[];
  /** The god's seat, foreground and larger than the rest. */
  godBerth: Berth;
  anchors: RoomAnchors;
  /** Where the ambiance layer hangs its glows. May be empty. */
  lightPoints: { x: number; y: number }[];
}

const ANCHOR_KEYS = ['cardTable', 'writingDesk', 'almanac', 'hearth', 'shelves'] as const;

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`room manifest: ${what} must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function validateBerth(raw: unknown, what: string): Berth {
  const o = asRecord(raw, what);
  const id = o.id;
  if (typeof id !== 'string' || !id) throw new Error(`room manifest: ${what} needs a non-empty id`);
  const out = { id } as Berth;
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new Error(`room manifest: ${id}.${k} must be a number, got ${JSON.stringify(v)}`);
    }
    if (v < 0 || v > 1) {
      throw new Error(`room manifest: ${id}.${k} must be normalized to 0..1, got ${v}`);
    }
    out[k] = v;
  }
  if (out.w <= 0 || out.h <= 0) throw new Error(`room manifest: ${id} has no area`);
  if (out.x + out.w > 1 || out.y + out.h > 1) {
    throw new Error(`room manifest: ${id} hangs off the backdrop (${out.x}+${out.w}, ${out.y}+${out.h})`);
  }
  return out;
}

/** Parse and check one manifest, throwing with the offending field named. */
export function validateRoomManifest(raw: unknown): RoomManifest {
  const o = asRecord(raw, 'manifest');
  if (typeof o.backdrop !== 'string' || !o.backdrop) {
    throw new Error('room manifest: backdrop must be a non-empty path');
  }
  if (!Array.isArray(o.deskBerths)) throw new Error('room manifest: deskBerths must be an array');
  const deskBerths = o.deskBerths.map((b, i) => validateBerth(b, `deskBerths[${i}]`));
  const seen = new Set<string>();
  for (const b of deskBerths) {
    if (seen.has(b.id)) throw new Error(`room manifest: duplicate berth id ${b.id}`);
    seen.add(b.id);
  }
  const godBerth = validateBerth(o.godBerth, 'godBerth');
  const anchorsRaw = asRecord(o.anchors, 'anchors');
  const anchors = {} as RoomAnchors;
  for (const key of ANCHOR_KEYS) {
    if (anchorsRaw[key] === undefined) throw new Error(`room manifest: anchors.${key} is missing`);
    anchors[key] = validateBerth(anchorsRaw[key], `anchors.${key}`);
  }
  const lightRaw = o.lightPoints === undefined ? [] : o.lightPoints;
  if (!Array.isArray(lightRaw)) throw new Error('room manifest: lightPoints must be an array');
  const lightPoints = lightRaw.map((p, i) => {
    const q = asRecord(p, `lightPoints[${i}]`);
    for (const k of ['x', 'y'] as const) {
      const v = q[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`room manifest: lightPoints[${i}].${k} must be normalized to 0..1`);
      }
    }
    return { x: q.x as number, y: q.y as number };
  });
  return { backdrop: o.backdrop, deskBerths, godBerth, anchors, lightPoints };
}

/** The shipped floor plan. Throws if room.json has been edited into nonsense. */
export function loadRoomManifest(): RoomManifest {
  return validateRoomManifest(roomJson);
}
