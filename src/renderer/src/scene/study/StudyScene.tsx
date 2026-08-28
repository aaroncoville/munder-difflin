/**
 * The Study — the painted scene that replaces the pixel office floor under the
 * occult theme.
 *
 * The Study is a cross-section of a house, drawn flat and straight on: each
 * room is its own panel, panels sit side by side to make a storey, and the
 * storeys stack from the top of the building down with a band of masonry
 * between them. There is no single backdrop and no perspective. The whole
 * building is then letterboxed into the window, so it is always visible end to
 * end and there is nothing to scroll.
 *
 * Every room draws three stacked layers, bottom to top:
 *
 *   1. its panel image, contain-fitted so the whole painting is always visible
 *      and never cropped;
 *   2. the ambiance canvas — candlelight at the points the manifest marks,
 *      dust drifting in it, the hearth's own fire. It is `pointer-events: none`
 *      by contract, and pixi's event system is off at its root as well, because
 *      everything clickable in the Study is a DOM element beneath it;
 *   3. the card layer: an assistant at each occupied berth with the book of
 *      what they are working on and what they are saying — or, in a prop room,
 *      the badge that room carries.
 *
 * Because each panel is letterboxed rather than stretched, positions inside it
 * can NOT be expressed in CSS percentages: a berth at x=0.5 is halfway across
 * the *image*, which is not halfway across the panel unless the aspects happen
 * to match. Every position therefore goes through `berthToBox`, against the box
 * that room's image actually occupies.
 *
 * The prop rooms ARE the props: clicking the card table's room opens Tasks, so
 * there is no invisible hotspot to keep in step with the painting.
 *
 * A function does not have to own a room to be one of those props, though. The
 * house is letterboxed whole, so a storey given over to a stack of letters is
 * paid for by every assistant's card in the building — which is why the plan
 * also lets an anchor stand INSIDE another room, as a rectangle of that
 * painting carrying the same label, click and badge a room of its own would.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import {
  ANCHOR_KINDS,
  houseRows,
  loadRoomManifest,
  type AnchorKind,
  type Berth,
  type Room,
  type RoomManifest
} from './roomManifest';
import { AgentCard, CARD_ASPECT } from './AgentCard';
import { AmbianceLayer } from './AmbianceLayer';
import { BaizeStacks } from './BaizeStacks';
import { ShelfArchive } from './ShelfArchive';
import { DeskBook } from './DeskBook';
import { SpeechScroll } from './SpeechScroll';
import { portraitFor } from './portraits';
import { useSceneState, type SceneAgent } from './useSceneState';
import { ROOM_SRC } from './roomImages';

/** Re-exported so a test can hold the shipped imports against the paths
 *  room.json names: an image with no import behind it paints as a hole. */
export { ROOM_SRC };

/** Where a room's panel image actually landed inside its box, in px. */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Letterbox `natural` inside `container`, the way `object-fit: contain` does. */
export function containFit(
  container: { w: number; h: number },
  natural: { w: number; h: number }
): ViewBox {
  if (!(container.w > 0) || !(container.h > 0) || !(natural.w > 0) || !(natural.h > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const scale = Math.min(container.w / natural.w, container.h / natural.h);
  const w = natural.w * scale;
  const h = natural.h * scale;
  return { x: (container.w - w) / 2, y: (container.h - h) / 2, w, h };
}

/** A berth normalized to one room's panel, projected onto the box it occupies. */
export function berthToBox(berth: Berth, view: ViewBox): Box {
  return {
    left: view.x + berth.x * view.w,
    top: view.y + berth.y * view.h,
    width: berth.w * view.w,
    height: berth.h * view.h
  };
}

const HOUSE = loadRoomManifest();

/**
 * The floor plan the house is built from — parsed once, shared by its rooms.
 *
 * A plan that failed validation leaves an empty house here rather than an
 * exception, so importing the Study always succeeds. Nothing ever draws that
 * empty house: `StudyScene` refuses to render while `studyRoomError` is set,
 * and the floor host puts the office floor up in its place.
 */
export const studyRoom: RoomManifest = HOUSE.ok ? HOUSE.manifest : { rooms: [], bandThickness: 0 };

/** Why the house could not be built, or `null` when it could. */
export const studyRoomError: string | null = HOUSE.ok ? null : HOUSE.error;

/** The storeys, top to bottom, each read left to right. */
const STOREYS = houseRows(studyRoom);

/**
 * How tall a storey is at a given width.
 *
 * Every room in a storey is drawn at the same height, so the storey's width at
 * height H is the sum of its rooms' aspect ratios times H, plus the mortar
 * between them. Inverting that gives the height at which the storey exactly
 * fills the house — capped at the tallest natural size in the row, because
 * blowing a panel up past its own art gains nothing and would make a wide
 * window produce an absurdly tall building.
 */
export function storeyHeight(rooms: readonly Room[], width: number, band: number): number {
  const aspect = rooms.reduce((sum, r) => sum + r.natural.w / r.natural.h, 0);
  const tallest = Math.max(...rooms.map((r) => r.natural.h));
  if (!(width > 0) || !(aspect > 0)) return tallest;
  const fitted = (width - band * (rooms.length - 1)) / aspect;
  return Math.max(1, Math.min(fitted, tallest));
}

/**
 * The width of the ROOMS at which every storey draws at its natural height —
 * the inside of the building, with no outer wall counted.
 */
export const HOUSE_INNER_WIDTH = STOREYS.length === 0 ? 0 : Math.max(
  ...STOREYS.map((rooms) => {
    const tallest = Math.max(...rooms.map((r) => r.natural.h));
    return rooms.reduce((sum, r) => sum + (r.natural.w / r.natural.h) * tallest, 0)
      + studyRoom.bandThickness * (rooms.length - 1);
  })
);

/** The inside height: every storey, and the masonry between. */
const HOUSE_INNER_HEIGHT = STOREYS.reduce(
  (sum, rooms) => sum + storeyHeight(rooms, HOUSE_INNER_WIDTH, studyRoom.bandThickness),
  Math.max(0, STOREYS.length - 1) * studyRoom.bandThickness
);

/**
 * The whole building, outer wall included.
 *
 * The wall is the same thickness as every other course of masonry in the house
 * and it is what the letterbox measures, so the top storey's ceiling and the
 * end rooms' outer walls are drawn rather than merely being where the painting
 * stops. It is added here, once, so that `houseFit` and the element's own
 * `width` cannot disagree about whether the wall is inside the number.
 */
export const HOUSE_NATURAL_WIDTH = HOUSE_INNER_WIDTH === 0
  ? 0 : HOUSE_INNER_WIDTH + studyRoom.bandThickness * 2;
export const HOUSE_NATURAL_HEIGHT = HOUSE_INNER_HEIGHT === 0
  ? 0 : HOUSE_INNER_HEIGHT + studyRoom.bandThickness * 2;

/**
 * Masonry, as a paint.
 *
 * One style for every division in the house — the bands between storeys, the
 * walls between rooms, and the wall around the outside — because the moment
 * they are authored separately they drift apart in thickness or in colour, and
 * a cross-section whose walls are not all the same wall stops reading as a
 * building. The courses are a repeating gradient rather than an image: it costs
 * nothing, and it is what keeps a plain bar from reading as a gap.
 */
const MASONRY = {
  background: 'var(--cth-ink-700)',
  backgroundImage:
    'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0 1px, transparent 1px 9px),'
    + ' repeating-linear-gradient(90deg, rgba(0,0,0,0.22) 0 1px, transparent 1px 26px)'
} as const;

/**
 * Where the whole house lands on the floor it is given.
 *
 * The house is a fixed drawing, so making it fit a window is the same problem
 * as making a panel fit its room, one storey up: letterbox the natural size
 * into what there is and centre it. That is what the office floor does with
 * its camera, and it is why nothing here scrolls — a building that is too tall
 * for the window is drawn smaller, not clipped and handed a scrollbar, so the
 * hearth at the bottom is as visible as the shelves at the top.
 *
 * Laying the house out at its natural size and scaling the result, rather than
 * recomputing every storey against the window, is what keeps the proportions
 * honest: at any window size the rooms stay the size they were painted
 * relative to each other, and every berth inside them comes along for free.
 */
export function houseFit(host: { w: number; h: number }): ViewBox {
  return containFit(host, { w: HOUSE_NATURAL_WIDTH, h: HOUSE_NATURAL_HEIGHT });
}

/**
 * Where the card, the book and the scroll sit inside one berth.
 *
 * A berth is the whole place setting, not the card — the room has a desk there,
 * and the card has to look like it is resting ON it with room left for a volume
 * beside it. The scroll floats clear above, outside the berth, which is why it
 * is the only piece allowed past those bounds.
 *
 * The berth's BOTTOM EDGE is the painted desk surface — that is how every berth
 * in the manifest was read off its painting, and it is the one thing the whole
 * illusion rests on. So the card runs the full height of the setting and stands
 * on that edge, or on the top edge of the volume the painter left standing
 * there — see `volumeBox`. It used to stop at 78% of it, with the book filling the fifth
 * underneath, and the arithmetic of that is the float somebody sees: a setting
 * 460 panel pixels tall left the card a hundred pixels clear of the desk it was
 * supposed to be standing at, and the grandest berth in the house — the god's,
 * alone in its room — floated the furthest. The book moves to the card's right,
 * onto the same surface, which is where a volume laid out beside somebody
 * actually is.
 *
 * ACROSS the setting the card is centred, because the middle of a place setting
 * is where its chair is: every berth was read off a painting by putting its box
 * around one seat at one desk. The card used to be centred in the LEFT 62% of
 * the setting instead — the share reserved for it while the book took the rest
 * — and so every assistant in the house stood a card's width to the left of the
 * chair they were sitting in, most visibly in the two rooms whose paintings
 * have chairs at all. The book keeps its own share; it is measured from the
 * card's right edge now rather than from a fixed fraction, so the two cannot
 * collide whatever shape the setting is.
 */
export const PLACE_SETTING = {
  /** How much of the setting's width the card is allowed. A guard rather than
   *  the size: the card is cut to the portrait's proportion, and this is only
   *  what stops a very short, very wide berth from filling its whole desk. */
  card: 0.62,
  /** The volume beside it: the clear desk left between card and book, how much
   *  wider than tall it lies open, and the most of the setting's height it may
   *  stand. */
  book: { gap: 0.04, aspect: 0.62, height: 0.22 }
} as const;

/**
 * The book the PAINTING already put on this desk, projected onto its panel.
 *
 * A berth's bottom edge is the desk surface, and in two of the reading rooms
 * the painter drew an open book lying on that surface directly in front of the
 * chair — which is where the card, centred on the chair, then stands. Aaron:
 * *"Cards are centered at the desks now (but they do cover the book)."*
 *
 * Beside the book is not somewhere the card can go: it is wider than the desk
 * left on either side of the volume, so sliding it clear would take it off the
 * chair it was centred on and undo the fix that centred it. BEHIND the book is,
 * and it is what a desk actually looks like — so the card's foot rises to the
 * volume's top edge and the painted book lies open in front of the portrait.
 *
 * `null` where the painter left the desk bare, which is most of the house.
 */
export function volumeBox(berth: Berth, view: ViewBox): Box | null {
  if (!berth.volume) return null;
  const v = berth.volume;
  return {
    left: view.x + v.x * view.w,
    top: view.y + v.y * view.h,
    width: v.w * view.w,
    height: v.h * view.h
  };
}

export function deskLayout(desk: Box, volume: Box | null = null):
{ card: Box; book: Box; scroll: { left: number; top: number; width: number } } {
  const book = PLACE_SETTING.book;
  // What is left of the setting once the painting has had its share. The card
  // stands on THIS floor; the drawn book stays down on the desk surface, where
  // a second volume actually lies, and starts clear of the painted one.
  const clear = volume
    ? Math.max(0, Math.min(desk.height, desk.top + desk.height - volume.top))
    : 0;
  const height = Math.max(1, desk.height - clear);
  // The card's height is the setting's, so its foot lands on the painted desk;
  // its WIDTH is the portrait's proportion of that height, so the frame is the
  // shape of the art in it. Taking a share of the setting's width instead is
  // what cut every card landscape — and a different landscape per room, since
  // the settings are not all the same shape.
  const cardW = Math.min(height * CARD_ASPECT, desk.width * PLACE_SETTING.card);
  const cardLeft = desk.left + (desk.width - cardW) / 2;
  // Whatever is left of the setting to the card's right, less a hand's width of
  // clear desk at each end — the far end matters as much as the near one, since
  // a berth is read out to the corner of its desk and a book flush with that
  // corner hangs over the edge of it. The book was a fixed share of the setting
  // starting at 66% of it, which only did not collide with the card while the
  // card was pinned to the left; measured from the card, the two cannot overlap
  // however the setting is shaped.
  //
  // It starts past the painted volume as well, where there is one: the card
  // rises above that book but this one lies on the same surface it does, so
  // nothing but the width of the desk keeps the two apart.
  const past = Math.max(cardLeft + cardW, volume ? volume.left + volume.width : 0);
  const bookLeft = past + desk.width * book.gap;
  const bookW = Math.max(0, desk.left + desk.width - bookLeft - desk.width * book.gap);
  const bookH = Math.min(bookW * book.aspect, desk.height * book.height);
  return {
    card: {
      left: cardLeft,
      top: desk.top,
      width: cardW,
      height
    },
    book: {
      left: bookLeft,
      top: desk.top + desk.height - bookH,
      width: bookW,
      height: bookH
    },
    scroll: {
      left: desk.left - desk.width * 0.2,
      top: desk.top - desk.height * 0.62,
      width: desk.width * 1.4
    }
  };
}

/**
 * How far each extra occupant of one berth is dealt back from the one below,
 * in fractions of the place setting.
 *
 * A berth is one desk, and a house with more assistants than desks is a real
 * state — so desks get shared. Sharing has to LOOK like sharing: cards drawn at
 * identical coordinates are one card as far as the eye is concerned, and as far
 * as the pointer is concerned the ones underneath do not exist at all, because
 * the topmost covers them edge to edge. Dealing each one back and down leaves a
 * band of every card below it clear, and that band is what you click.
 *
 * Down as well as across, because a stack offset on one axis only reads as a
 * misprint rather than a pile.
 */
export const STACK_OFFSET = { x: 0.14, y: 0.1 };

/**
 * How many times a berth may be dealt back before the pile stops receding.
 *
 * Each step eats a fixed share of the setting, so the steps cannot go on: at
 * seven the width is gone and at ten the height is, and a berth dealt past
 * either is inside out — a card with a negative height has its foot above its
 * head. The seating will produce those depths, because it round-robins and a
 * house may hold many times its desks. So the recession stops here and the
 * deepest occupants share a place. That is a worse drawing than a deeper pile
 * would be; it is not a card through the floor.
 */
export const STACK_DEEPEST = 4;

/**
 * Where the nth assistant at one berth sits. The first sits at the berth.
 *
 * The berth SHRINKS by exactly what it is dealt back, so its bottom and right
 * edges never move. The bottom edge is the painted desk surface and the whole
 * place setting is measured down from it — a berth moved down without being
 * shortened is a full-height card whose foot is below the desk, which is what
 * every shared desk in the house used to draw once the seating wrapped round
 * and started handing out stack index 1. Holding the far corner still means a
 * pile leans back INTO the room: shorter and narrower the deeper it goes, and
 * standing on the same surface all the way down.
 */
export function stackedBerth(desk: Box, stackIndex: number): Box {
  const depth = Math.min(Math.max(stackIndex, 0), STACK_DEEPEST);
  const back = desk.width * STACK_OFFSET.x * depth;
  const down = desk.height * STACK_OFFSET.y * depth;
  return {
    left: desk.left + back,
    top: desk.top + down,
    width: desk.width - back,
    height: desk.height - down
  };
}

/**
 * What each prop room is called and what clicking it does.
 *
 * These read in the Study's own idiom rather than the app's — an Ask Me board
 * is a writing desk of unanswered petitions here. They are English literals
 * for now: the Secret Histories locale that will own this vocabulary arrives
 * with the rest of the voice work, and keying them into the shared catalog
 * before that exists would put occult wording in front of light and dark too.
 */
export const ANCHOR_LABEL: Record<AnchorKind, string> = {
  cardTable: 'Tasks',
  writingDesk: 'Petitions',
  almanac: 'Triggers',
  hearth: 'Closing Time',
  shelves: 'The Archive'
};

const KANBAN_COLUMNS = ['todo', 'doing', 'blocked', 'done'] as const;

/** The same patch, for an anchor that stands as a prop and so has no room of
 *  its own to fall back to. */
export function anchorFrame(
  berth: Berth | undefined,
  view: ViewBox
): React.CSSProperties {
  if (!berth) return { inset: 0 };
  const box = berthToBox(berth, view);
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

/**
 * The measured floor the house stands on.
 *
 * This is the only measurement the house takes. Everything below it — every
 * storey's height, every panel's box — is arithmetic from the manifest, and
 * this box only decides how big the finished drawing is drawn, so the rooms
 * stay hook-free and can be reasoned about (and rendered in a test) as pure
 * functions of the manifest.
 *
 * A host with no layout yet reports 0×0, which would scale the house away to
 * nothing; its natural size stands in until there is something real to measure,
 * which is also what a test with no ResizeObserver sees.
 */
function useHouseBox(hostRef: React.RefObject<HTMLDivElement | null>): { w: number; h: number } {
  const [box, setBox] = useState({ w: HOUSE_NATURAL_WIDTH, h: HOUSE_NATURAL_HEIGHT });
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (w > 0 && h > 0) setBox({ w, h });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef]);
  return box;
}

/**
 * Where a place setting is drawn in the pile at its desk.
 *
 * A shared desk deals each occupant back from the one below it, and the one
 * dealt back is drawn OVER the one it was dealt back from — so the card at the
 * bottom of the pile shows only the band the others leave clear. Aaron asked
 * for that band to be enough: hovering it should bring the buried card
 * forward, and moving away should put it back exactly where it was.
 *
 * So it is a z-order and nothing else. Nothing moves, nothing resizes, and no
 * neighbour is pushed aside — the buried card is drawn whole already, it is
 * merely underneath, and being looked at is the only thing that changes.
 *
 * The depth is capped for the same reason `stackedBerth` caps the recession:
 * the seating will hand out depths past it, and they share a place.
 */
export function placeDepth(stackIndex: number): number {
  return Math.min(Math.max(stackIndex, 0), STACK_DEEPEST);
}

/** Above every place in the pile, and only ever one at a time. */
export const LOOKED_AT_Z = STACK_DEEPEST + 1;

/** One assistant's place setting: card, book, and what they are saying. */
function DeskPlace({ agent, desk, volume, raised, onLook, onSelect }: {
  agent: SceneAgent;
  desk: Box;
  /** The book the painting has already put on this desk, or null. */
  volume: Box | null;
  raised: boolean;
  onLook: (looking: boolean) => void;
  onSelect: () => void;
}): JSX.Element {
  const { card, book, scroll } = deskLayout(desk, volume);
  return (
    <div
      data-study-place={agent.id}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: raised ? LOOKED_AT_Z : placeDepth(agent.stackIndex),
        // The layer spans the whole room, because that is the frame every piece
        // in it is positioned against. It must therefore take no pointer at
        // all, or the room underneath would stop being clickable everywhere a
        // place setting is drawn — which is everywhere there is one. The pieces
        // that ARE pressed take the pointer back themselves.
        pointerEvents: 'none'
      }}
    >
      <SpeechScroll text={agent.speech} box={scroll} />
      <AgentCard
        name={agent.name}
        role={agent.role}
        status={agent.status}
        portraitSrc={portraitFor({
          id: agent.id, name: agent.name, role: agent.role, isGod: agent.isGod
        })}
        box={card}
        onClick={onSelect}
        onLook={onLook}
      />
      {agent.bookState
        ? <DeskBook state={agent.bookState} title={agent.bookTitle} box={book} />
        : null}
    </div>
  );
}

/**
 * One room of the house.
 *
 * A room that navigates somewhere carries the button semantics itself. A room
 * that only marks a place — the archive, a reading room — renders without them,
 * so a screen reader is not offered a control that does nothing.
 */
function RoomPanel({ room, height, label, onClick, children }: {
  room: Room;
  /** The storey's height in px; the panel's width follows from its aspect. */
  height: number;
  label?: string;
  onClick?: () => void;
  /** A function child is handed the panel's letterboxed view box, which is
   *  what a berth has to be projected against and is only known in here. */
  children?: React.ReactNode | ((view: ViewBox) => React.ReactNode);
}): JSX.Element {
  const width = (room.natural.w / room.natural.h) * height;
  const view = containFit({ w: width, h: height }, room.natural);
  const interactive = typeof onClick === 'function';
  return (
    <div
      data-study-room={room.id}
      data-study-kind={room.kind}
      {...(label ? { title: label, 'aria-label': label } : {})}
      {...(interactive
        ? {
          role: 'button',
          tabIndex: 0,
          onClick,
          // A room that carries button semantics has to behave like a button
          // from the keyboard too. The target check matters more here than
          // anywhere: every assistant's card is nested inside a room, and
          // without it pressing Enter on a card would open the room as well.
          onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onClick?.();
          }
        }
        : {})}
      style={{
        position: 'relative',
        flex: '0 0 auto',
        width,
        height,
        overflow: 'hidden',
        boxSizing: 'border-box',
        borderRadius: 'var(--cth-radius-panel)',
        boxShadow: 'var(--cth-panel-border)',
        cursor: interactive ? 'pointer' : 'default'
      }}
    >
      <img
        data-study-panel={room.id}
        src={ROOM_SRC[room.image]}
        alt=""
        aria-hidden
        draggable={false}
        style={{
          position: 'absolute',
          left: view.x,
          top: view.y,
          width: view.w,
          height: view.h,
          userSelect: 'none'
        }}
      />
      <div
        data-study-slot="ambiance"
        style={{
          position: 'absolute',
          left: view.x,
          top: view.y,
          width: view.w,
          height: view.h,
          pointerEvents: 'none'
        }}
      >
        <AmbianceLayer room={room} view={view} />
      </div>
      <div data-study-layer="cards" style={{ position: 'absolute', inset: 0 }}>
        {typeof children === 'function' ? children(view) : children}
      </div>
    </div>
  );
}

/**
 * An anchor standing inside another room: the clickable patch of painting.
 *
 * It carries exactly what a prop ROOM carries — the label, the button
 * semantics, the keyboard handling — over a rectangle instead of a panel. The
 * one addition is that a press has to STOP here: the host room is itself a
 * button (the parlour opens the board), so a door that did not stop its click
 * would open the board behind the window it just closed.
 */
function PropPlate({ kind, label, box, onClick }: {
  kind: AnchorKind;
  label: string;
  box: React.CSSProperties;
  onClick?: () => void;
}): JSX.Element {
  const press = (stop: () => void): void => { stop(); onClick?.(); };
  return (
    <div
      data-study-prop=""
      data-study-kind={kind}
      title={label}
      aria-label={label}
      role="button"
      tabIndex={0}
      onClick={(event: React.MouseEvent) => press(() => event.stopPropagation())}
      onKeyDown={(event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        press(() => event.stopPropagation());
      }}
      style={{ position: 'absolute', cursor: 'pointer', ...box }}
    />
  );
}

export function StudyScene(): JSX.Element {
  // A house that could not be read is not a house that can be drawn half-way.
  // Throwing here hands the decision to the floor host's boundary, which puts
  // the office floor up — before any hook runs, so the throw is the whole render.
  if (studyRoomError) throw new Error(`the Study has no floor plan: ${studyRoomError}`);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fit = houseFit(useHouseBox(hostRef));
  const scene = useSceneState();
  const select = useStore((s) => s.select);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const openTaskDetail = useStore((s) => s.openTaskDetail);
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id);
  /** The one place setting being looked at, if any — see `DeskPlace`. */
  const [lookingAt, setLookingAt] = useState<string | null>(null);

  /** The petitions are the god's to answer, so opening them selects him too —
   *  the same pair of actions the office floor's ASK ME board fires. */
  const openPetitions = (): void => {
    if (godId) select(godId);
    requestCommandCenterTab('human');
  };

  /** What clicking each prop room does. The archive is deliberately absent: the
   *  spec gives it one scripted animation and no destination of its own yet. */
  const ANCHOR_CLICK: Partial<Record<AnchorKind, () => void>> = {
    cardTable: () => requestCommandCenterTab('tasks'),
    writingDesk: openPetitions,
    almanac: () => requestCommandCenterTab('triggers'),
    // The quit dialog, never the quit itself — the same call the office floor's
    // clock makes. `window.close()` was NOT that: on a floor window it closes
    // that floor, and on the primary with no terminal alive it quits outright,
    // so pressing the fire ended the app with nothing asked.
    hearth: () => { void window.cth.requestQuit(); }
  };

  /** What one anchor draws on the patch of painting it stands on — whether
   *  that patch is a whole prop room or a prop inside somebody else's. */
  const anchorContent = (
    kind: AnchorKind, room: Room, berth: Berth | undefined, view: ViewBox
  ): React.ReactNode => {
    if (kind === 'cardTable') {
      // The commissions themselves, piled on the baize the painting puts
      // there. They replace the four column totals that used to sit here: a
      // total could only ever mean "open the whole board", which is what
      // clicking the room already does.
      if (!berth) return null;
      return (
        <BaizeStacks
          tasks={scene.tasks}
          baize={berthToBox(berth, view)}
          onOpen={openTaskDetail}
        />
      );
    }
    if (kind === 'shelves') {
      // Finished work, darkening the painted volumes it lands on — which are
      // rectangles of this very panel, so the mark is one of the wall's own
      // books rather than a book drawn over the wall.
      return <ShelfArchive books={scene.archive} panelSrc={ROOM_SRC[room.image]} view={view} />;
    }
    return null;
  };

  /** The place settings a room holds: whoever the projection seated in it. */
  const occupantsOf = (room: Room, view: ViewBox): React.ReactNode =>
    room.berths.flatMap((berth) => {
      const desk = berthToBox(berth, view);
      const volume = volumeBox(berth, view);
      return scene.agents
        .filter((agent) => agent.berthId === berth.id)
        .map((agent) => (
          <DeskPlace
            key={agent.id}
            agent={agent}
            desk={stackedBerth(desk, agent.stackIndex)}
            volume={volume}
            raised={lookingAt === agent.id}
            onLook={(looking: boolean) =>
              setLookingAt((was) => (looking ? agent.id : was === agent.id ? null : was))}
            onSelect={() => select(agent.id)}
          />
        ));
    });

  const renderRoom = (room: Room, height: number): JSX.Element => {
    const own = ANCHOR_KINDS.find((k) => k === room.kind);
    return (
      <RoomPanel
        key={room.id}
        room={room}
        height={height}
        {...(own ? { label: ANCHOR_LABEL[own], onClick: ANCHOR_CLICK[own] } : {})}
      >
        {(view: ViewBox) => (
          <>
            {own ? anchorContent(own, room, room.berths[0], view) : null}
            {occupantsOf(room, view)}
            {room.props.map((prop) => (
              <Fragment key={prop.kind}>
                <PropPlate
                  kind={prop.kind}
                  label={ANCHOR_LABEL[prop.kind]}
                  box={anchorFrame(prop.berth, view)}
                  onClick={ANCHOR_CLICK[prop.kind]}
                />
                {anchorContent(prop.kind, room, prop.berth, view)}
              </Fragment>
            ))}
          </>
        )}
      </RoomPanel>
    );
  };

  return (
    <div
      ref={hostRef}
      data-study-scene=""
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--cth-cream-300)'
      }}
    >
      <div
        data-study-house=""
        style={{
          position: 'absolute',
          left: fit.x,
          top: fit.y,
          width: HOUSE_NATURAL_WIDTH,
          height: HOUSE_NATURAL_HEIGHT,
          transform: `scale(${HOUSE_NATURAL_WIDTH > 0 ? fit.w / HOUSE_NATURAL_WIDTH : 1})`,
          transformOrigin: 'top left',
          display: 'flex',
          flexDirection: 'column',
          padding: studyRoom.bandThickness,
          boxSizing: 'border-box',
          ...MASONRY
        }}
      >
        {STOREYS.map((rooms, i) => {
          const height = storeyHeight(rooms, HOUSE_INNER_WIDTH, studyRoom.bandThickness);
          return (
          <Fragment key={rooms[0].id}>
            {i > 0 ? (
              <div
                data-study-band=""
                style={{
                  height: studyRoom.bandThickness,
                  flex: '0 0 auto',
                  ...MASONRY
                }}
              />
            ) : null}
            <div
              data-study-storey={i}
              style={{
                display: 'flex',
                flex: '0 0 auto',
                justifyContent: 'center',
                height
              }}
            >
              {rooms.map((room, j) => (
                <Fragment key={room.id}>
                  {/* The wall between two rooms. A CSS `gap` here painted
                      nothing — the rooms were separated by whatever showed
                      through the house, so the building had storeys but no
                      walls. */}
                  {j > 0 ? (
                    <div
                      data-study-wall=""
                      style={{
                        width: studyRoom.bandThickness,
                        flex: '0 0 auto',
                        alignSelf: 'stretch',
                        ...MASONRY
                      }}
                    />
                  ) : null}
                  {renderRoom(room, height)}
                </Fragment>
              ))}
            </div>
          </Fragment>
          );
        })}
      </div>
    </div>
  );
}
