/**
 * The Study's floor plan, as data.
 *
 * The Study is drawn as a cross-section of a house: rooms are flat panels, laid
 * out in rows from the top of the building down, with masonry between the
 * storeys. There is no single painting and no perspective — each room owns its
 * own image, and every position inside it (where an assistant's card rests,
 * where a candle burns) is a normalized rectangle in fractions of THAT panel's
 * natural size. The scene scales each room's berths onto the box that room
 * actually renders into, so a panel can be repainted, resized, or moved to
 * another storey without a line of component code changing.
 *
 * The manifest is authored by hand and shipped in the bundle, so it is not
 * untrusted input in the security sense — but it IS hand-edited, and a berth
 * that has drifted off its panel or a duplicated id produces a scene that is
 * subtly wrong rather than obviously broken (a card stacked invisibly on
 * another, an assistant drawn in two rooms at once). Validation turns those
 * into a loud failure at load, where they are cheap to find.
 */
import roomJson from './assets/room.json';
import { BOOK_BINDINGS, type BookBindingName } from './DeskBook';

/**
 * How a light marked in a panel burns.
 *
 * A candle unless the plan says otherwise. The distinction used to be carried
 * by the ROOM — the fire was the first light of the room whose kind was
 * `hearth` — which only worked while a hearth was a whole room. A prop stands
 * inside somebody else's panel, so a fire in the corner of a parlour is a
 * light among that parlour's candles and nothing about the room it is in says
 * which one it is. The plan has to say.
 */
export const LIGHT_KINDS = ['candle', 'hearth'] as const;

export type LightKind = (typeof LIGHT_KINDS)[number];

/** Where the ambiance layer hangs one glow, normalized to its own panel. */
export interface LightPoint {
  x: number;
  y: number;
  kind: LightKind;
}

/** A normalized rectangle inside one room's panel: origin plus size, all in 0..1. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Berth extends Rect {
  id: string;
  /**
   * The open book the PAINTER put on this desk, read off the panel.
   *
   * Optional because only some of the reading rooms were painted with one. A
   * berth that declares it is telling the scene that this piece of the painting
   * is already spoken for: the card standing at the berth stops at the volume's
   * top edge instead of at the desk surface, so the book stays visible in front
   * of the portrait rather than under it.
   */
  volume?: Rect;
  /**
   * The patch of painting a page turn is drawn over, and the clip that draws it.
   *
   * A desk whose painted book turns its pages does it with a short film of that
   * corner of the room, not with shapes of ours — see `BookTurn`. The rectangle
   * is bigger than the volume and is NOT derived from it: it was chosen per
   * berth to hold the book with room to move while keeping the room's candle
   * out of frame, because a generated flame in the film would burn beside the
   * one the ambiance layer already draws. That makes it read data, like the
   * volume, rather than arithmetic.
   *
   * Only berths whose painting put a book on the desk have one.
   */
  turn?: Rect & { clip: string };
}

/**
 * What a room is for.
 *
 * `desk` rooms hold the reading berths assistants are seated into, and there
 * are many of them. Every other kind is a singleton: the god's study, and the
 * five props the scene can be clicked on — which in this model are rooms too,
 * so clicking the room IS clicking the prop.
 */
export type RoomKind =
  | 'desk'
  | 'godStudy'
  /** The task board. */
  | 'cardTable'
  /** Ask Me — the stack of sealed letters awaiting the human. */
  | 'writingDesk'
  /** Triggers. */
  | 'almanac'
  /** Closing Time. */
  | 'hearth'
  /** The done archive. */
  | 'shelves';

/**
 * An anchor standing INSIDE somebody else's room.
 *
 * A room per function costs a whole storey, and the house is letterboxed as a
 * single drawing — so a storey spent on a stack of letters is paid for by every
 * assistant's card in the building. A prop is the other way of putting an
 * anchor in the house: a rectangle of an existing painting that carries the
 * same label, the same click and the same badge the room would have.
 */
export interface Prop {
  kind: AnchorKind;
  /** Where in the host's panel the prop stands, normalized to THAT panel. */
  berth: Berth;
}

export interface Room {
  id: string;
  kind: RoomKind;
  /** Path of this room's panel image, relative to this directory. */
  image: string;
  /** Natural size of that image — the frame this room's berths were authored in. */
  natural: { w: number; h: number };
  /** Storey, counted from the top of the house. */
  row: number;
  /** Position within the storey, left to right. */
  col: number;
  /** Normalized WITHIN this panel. May be empty: a prop room seats nobody. */
  berths: Berth[];
  /** Anchors that stand in this room rather than owning one. May be empty. */
  props: Prop[];
  /** Where the ambiance layer hangs this room's glows. May be empty. */
  lightPoints: LightPoint[];
  /**
   * How this room's desks bind their volumes, or absent for the default.
   *
   * A binding belongs to the ROOM because it is a fact about the painting — a
   * gilt volume reads on warm wood and vanishes on grey masonry — and, where
   * two rooms hang the same painting, it is also what tells them apart. Which of
   * those a room is is something only the panel knows. Declaring it here means
   * a repainted room changes its binding in the same file it changes its
   * berths in, and no component ever has to learn a room's name.
   */
  binding?: BookBindingName;
}

export interface RoomManifest {
  rooms: Room[];
  /** Thickness in px of the masonry band drawn between two storeys. */
  bandThickness: number;
}

/** The kinds that must appear exactly once, and that the scene navigates from. */
export const ANCHOR_KINDS = [
  'cardTable', 'writingDesk', 'almanac', 'hearth', 'shelves'
] as const;

export type AnchorKind = (typeof ANCHOR_KINDS)[number];

const ROOM_KINDS: readonly RoomKind[] = ['desk', 'godStudy', ...ANCHOR_KINDS];

/** The kinds there can only be one of — everything except a reading room. */
const SINGLETON_KINDS: readonly RoomKind[] = ['godStudy', ...ANCHOR_KINDS];

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`room manifest: ${what} must be an object, got ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function validateBerth(raw: unknown, roomId: string, what: string): Berth {
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
    throw new Error(
      `room manifest: ${id} hangs off the panel of ${roomId} (${out.x}+${out.w}, ${out.y}+${out.h})`
    );
  }
  if (o.volume !== undefined) out.volume = validateRect(o.volume, `${what}.volume`, roomId);
  if (o.turn !== undefined) {
    const rect = validateRect(o.turn, `${what}.turn`, roomId);
    const clip = asRecord(o.turn, `${what}.turn`).clip;
    if (typeof clip !== 'string' || !clip) {
      throw new Error(`room manifest: ${what}.turn needs a clip to play`);
    }
    // A turn over a desk the painter left bare has no book to turn the pages
    // of: it would be a film of somebody else's furniture laid on empty wood.
    if (out.volume === undefined) {
      throw new Error(`room manifest: ${what} has a turn but no volume to turn`);
    }
    out.turn = { ...rect, clip };
  }
  return out;
}

/** The same rules as a berth's own rectangle, for the ones that carry no id. */
function validateRect(raw: unknown, what: string, roomId: string): Rect {
  const o = asRecord(raw, what);
  const out = {} as Rect;
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    const v = o[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      throw new Error(
        `room manifest: ${what}.${k} must be normalized to 0..1, got ${JSON.stringify(v)}`);
    }
    out[k] = v;
  }
  if (out.w <= 0 || out.h <= 0) throw new Error(`room manifest: ${what} has no area`);
  if (out.x + out.w > 1 || out.y + out.h > 1) {
    throw new Error(`room manifest: ${what} hangs off the panel of ${roomId}`);
  }
  return out;
}

function validateLightPoints(raw: unknown, roomId: string): LightPoint[] {
  const list = raw === undefined ? [] : raw;
  if (!Array.isArray(list)) throw new Error(`room manifest: ${roomId}.lightPoints must be an array`);
  return list.map((p, i) => {
    const q = asRecord(p, `${roomId}.lightPoints[${i}]`);
    for (const k of ['x', 'y'] as const) {
      const v = q[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
        throw new Error(`room manifest: ${roomId}.lightPoints[${i}].${k} must be normalized to 0..1`);
      }
    }
    // Unmarked is a candle, because nearly every light in the house is one and
    // an omitted field should mean the ordinary case. A misspelt one is not:
    // `"kind": "herath"` would silently become another candle, and the missing
    // fire is exactly the failure that is invisible until somebody looks at
    // the running room.
    const kind = q.kind === undefined ? 'candle' : (q.kind as LightKind);
    if (!LIGHT_KINDS.includes(kind)) {
      throw new Error(
        `room manifest: ${roomId}.lightPoints[${i}].kind is unknown: ${JSON.stringify(q.kind)}`);
    }
    return { x: q.x as number, y: q.y as number, kind };
  });
}

function validateProps(raw: unknown, roomId: string): Prop[] {
  const list = raw === undefined ? [] : raw;
  if (!Array.isArray(list)) throw new Error(`room manifest: ${roomId}.props must be an array`);
  return list.map((p, i) => {
    const o = asRecord(p, `${roomId}.props[${i}]`);
    const kind = o.kind as AnchorKind;
    if (!ANCHOR_KINDS.includes(kind)) {
      throw new Error(`room manifest: ${roomId}.props[${i}] has unknown kind ${JSON.stringify(o.kind)}`);
    }
    return { kind, berth: validateBerth(o.berth, roomId, `${roomId}.props[${i}].berth`) };
  });
}

function validateWhole(raw: unknown, what: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`room manifest: ${what} must be a whole number from 0, got ${JSON.stringify(raw)}`);
  }
  return raw;
}

function validateRoom(raw: unknown, index: number): Room {
  const o = asRecord(raw, `rooms[${index}]`);
  const id = o.id;
  if (typeof id !== 'string' || !id) throw new Error(`room manifest: rooms[${index}] needs an id`);
  const kind = o.kind as RoomKind;
  if (!ROOM_KINDS.includes(kind)) {
    throw new Error(`room manifest: ${id} has unknown kind ${JSON.stringify(o.kind)}`);
  }
  if (typeof o.image !== 'string' || !o.image) {
    throw new Error(`room manifest: ${id}.image must be a non-empty path`);
  }
  const natural = asRecord(o.natural, `${id}.natural`);
  for (const k of ['w', 'h'] as const) {
    const v = natural[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      throw new Error(`room manifest: ${id}.natural.${k} must be a positive number`);
    }
  }
  if (!Array.isArray(o.berths)) throw new Error(`room manifest: ${id}.berths must be an array`);
  // Absent is the default binding, because most rooms want it — but a NAME
  // nobody has drawn is not. `"binding": "vellm"` would otherwise fall back to
  // the default and look exactly like a room that never asked, which is the
  // failure nobody sees until they are staring at the running house.
  if (o.binding !== undefined
    && !Object.prototype.hasOwnProperty.call(BOOK_BINDINGS, o.binding as string)) {
    throw new Error(`room manifest: ${id}.binding is unknown: ${JSON.stringify(o.binding)}`);
  }
  return {
    id,
    kind,
    ...(o.binding === undefined ? {} : { binding: o.binding as BookBindingName }),
    image: o.image,
    natural: { w: natural.w as number, h: natural.h as number },
    row: validateWhole(o.row, `${id}.row`),
    col: o.col === undefined ? 0 : validateWhole(o.col, `${id}.col`),
    berths: o.berths.map((b, i) => validateBerth(b, id, `${id}.berths[${i}]`)),
    props: validateProps(o.props, id),
    lightPoints: validateLightPoints(o.lightPoints, id)
  };
}

/** Parse and check one manifest, throwing with the offending field named. */
export function validateRoomManifest(raw: unknown): RoomManifest {
  const o = asRecord(raw, 'manifest');
  if (!Array.isArray(o.rooms) || o.rooms.length === 0) {
    throw new Error('room manifest: rooms must be a non-empty array');
  }
  if (typeof o.bandThickness !== 'number' || !Number.isFinite(o.bandThickness) || o.bandThickness < 0) {
    throw new Error('room manifest: bandThickness must be a number of pixels');
  }
  const rooms = o.rooms.map(validateRoom);

  const roomIds = new Set<string>();
  const spots = new Set<string>();
  // Berth ids are unique across the WHOLE house, not per room: the scene looks
  // an assistant's berth up by id, so two rooms sharing one would draw the same
  // person twice and the seating would silently depend on iteration order.
  const berthIds = new Set<string>();
  for (const r of rooms) {
    if (roomIds.has(r.id)) throw new Error(`room manifest: duplicate room id ${r.id}`);
    roomIds.add(r.id);
    const spot = `row ${r.row} col ${r.col}`;
    if (spots.has(spot)) throw new Error(`room manifest: ${r.id} stands on ${spot}, already taken`);
    spots.add(spot);
    for (const b of [...r.berths, ...r.props.map((p) => p.berth)]) {
      if (berthIds.has(b.id)) throw new Error(`room manifest: duplicate berth id ${b.id}`);
      berthIds.add(b.id);
    }
  }

  // An anchor is counted wherever it stands — as a room of that kind or as a
  // prop on somebody's wall. Counting the two together is what lets the house
  // gather its functions into one room without the plan claiming, or losing,
  // an anchor the scene navigates from.
  for (const kind of SINGLETON_KINDS) {
    const asRoom = rooms.filter((r) => r.kind === kind).length;
    const asProp = kind === 'godStudy'
      ? 0 : rooms.reduce((n, r) => n + r.props.filter((p) => p.kind === kind).length, 0);
    if (asRoom + asProp !== 1) {
      throw new Error(
        `room manifest: the house needs exactly one ${kind}, found ${asRoom + asProp}`);
    }
  }
  if (!rooms.some((r) => r.kind === 'desk')) {
    throw new Error('room manifest: the house needs at least one desk room');
  }
  // A reading room with no berth is furniture with nowhere to sit: the seating
  // hands out `deskBerths`, so a house of empty reading rooms leaves it
  // indexing an empty list. Together with the check above this guarantees at
  // least one reading berth exists, which is what lets the seating index one
  // without asking whether there is any.
  for (const room of rooms) {
    if (room.kind === 'desk' && room.berths.length === 0) {
      throw new Error(`room manifest: the reading room ${room.id} has no desk to sit at`);
    }
  }
  const study = rooms.find((r) => r.kind === 'godStudy') as Room;
  if (study.berths.length === 0) {
    throw new Error(`room manifest: the godStudy room ${study.id} has no berth to sit in`);
  }

  return { rooms, bandThickness: o.bandThickness };
}

/** The reading rooms, in the order they are authored — which is seating order. */
export function deskRooms(manifest: RoomManifest): Room[] {
  return manifest.rooms.filter((r) => r.kind === 'desk');
}

/** Every reading berth in the house, in seating priority order. */
export function deskBerths(manifest: RoomManifest): Berth[] {
  return deskRooms(manifest).flatMap((r) => r.berths);
}

/** The god's seat — the first berth in the one room that is his study. */
export function godBerth(manifest: RoomManifest): Berth {
  const study = manifest.rooms.find((r) => r.kind === 'godStudy');
  if (!study || !study.berths[0]) throw new Error('room manifest: no godStudy berth');
  return study.berths[0];
}

/** The one room of a singleton kind. */
export function roomOfKind(manifest: RoomManifest, kind: RoomKind): Room {
  const room = manifest.rooms.find((r) => r.kind === kind);
  if (!room) throw new Error(`room manifest: no ${kind} room`);
  return room;
}

/**
 * Where an anchor stands, and the room it stands in.
 *
 * The scene navigates from the five anchors, and each of them is now either a
 * room of its own kind or a prop inside one — so everything that has to know
 * where an anchor IS (its click target, the badge laid over it, the cards dealt
 * onto it) asks this rather than assuming a room. A room-kind anchor seats its
 * prop at its first berth, which is where the badge already went.
 */
export function anchorSeat(
  manifest: RoomManifest,
  kind: AnchorKind
): { room: Room; berth: Berth | undefined } {
  const own = manifest.rooms.find((r) => r.kind === kind);
  if (own) return { room: own, berth: own.berths[0] };
  for (const room of manifest.rooms) {
    const prop = room.props.find((p) => p.kind === kind);
    if (prop) return { room, berth: prop.berth };
  }
  throw new Error(`room manifest: no ${kind} anywhere in the house`);
}

/**
 * The house as storeys, top to bottom, each read left to right.
 *
 * The scene draws from this rather than from `rooms` directly, so the manifest
 * can be authored in whatever order reads best and the building still stacks
 * the way its `row`/`col` say it does.
 */
export function houseRows(manifest: RoomManifest): Room[][] {
  const byRow = new Map<number, Room[]>();
  for (const r of manifest.rooms) {
    const row = byRow.get(r.row);
    if (row) row.push(r);
    else byRow.set(r.row, [r]);
  }
  return [...byRow.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, rooms]) => [...rooms].sort((a, b) => a.col - b.col));
}

/** A floor plan that was read, or the reason it could not be. */
export type ManifestLoad =
  | { ok: true; manifest: RoomManifest }
  | { ok: false; error: string };

/**
 * Read a floor plan — the shipped one unless another is passed — as a result.
 *
 * `validateRoomManifest` throws, and should: a hand-edited manifest is worth
 * failing loudly over, with the offending field named. But the Study reads its
 * plan while its own module is being evaluated, and a module that throws as it
 * is imported takes its importer down with it. Turning the throw into a value
 * here keeps a broken plan a decision the scene can make — draw nothing, and
 * let the floor fall back — instead of an exception nobody is positioned to
 * catch.
 */
export function loadRoomManifest(raw: unknown = roomJson): ManifestLoad {
  try {
    return { ok: true, manifest: validateRoomManifest(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
