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
import { BaizeCards } from './BaizeCards';
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
 * on that edge. It used to stop at 78% of it, with the book filling the fifth
 * underneath, and the arithmetic of that is the float somebody sees: a setting
 * 460 panel pixels tall left the card a hundred pixels clear of the desk it was
 * supposed to be standing at, and the grandest berth in the house — the god's,
 * alone in its room — floated the furthest. The book moves to the card's right,
 * onto the same surface, which is where a volume laid out beside somebody
 * actually is.
 */
export const PLACE_SETTING = {
  /** How much of the setting's width the card is allowed, measured from its
   *  left. A guard rather than the size: the card is cut to the portrait's
   *  proportion, and this is only what stops a very short, very wide berth
   *  from putting the card through the volume beside it. */
  card: 0.62,
  /** The volume beside it: where it starts, and how much it takes. */
  book: { left: 0.66, width: 0.30, height: 0.22 }
} as const;

export function deskLayout(desk: Box):
{ card: Box; book: Box; scroll: { left: number; top: number; width: number } } {
  const book = PLACE_SETTING.book;
  // The card's height is the setting's, so its foot lands on the painted desk;
  // its WIDTH is the portrait's proportion of that height, so the frame is the
  // shape of the art in it. Taking a share of the setting's width instead is
  // what cut every card landscape — and a different landscape per room, since
  // the settings are not all the same shape.
  const cardW = Math.min(desk.height * CARD_ASPECT, desk.width * PLACE_SETTING.card);
  return {
    card: {
      left: desk.left + (desk.width * PLACE_SETTING.card - cardW) / 2,
      top: desk.top,
      width: cardW,
      height: desk.height
    },
    book: {
      left: desk.left + desk.width * book.left,
      top: desk.top + desk.height * (1 - book.height),
      width: desk.width * book.width,
      height: desk.height * book.height
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

/** The badge row a prop room carries, centred over its panel. */
const BADGES: React.CSSProperties = {
  position: 'absolute',
  // A printed count, not a control. It is drawn OVER whatever carries the
  // click — a room panel, or a prop standing in one — and a badge that ate the
  // pointer would make the middle of the prop the one part of it you cannot
  // press.
  pointerEvents: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'var(--cth-font-display)',
  color: 'var(--cth-ink-900)'
};

/**
 * How a number printed inside the house is sized.
 *
 * NOT from a type token. The house is laid out at its natural size and
 * letterboxed into the window as one scaled drawing, so a fixed CSS size
 * arrives on screen divided by that scale — `--cth-text-display-sm` is 8px,
 * which a 1280x720 floor delivers at two. A fraction of the plate the number
 * is printed on survives, because the plate is scaled by exactly the same
 * number the type would have been.
 */
export function countType(plate: { width: number; height: number }): React.CSSProperties {
  const size = plate.height * 0.52;
  return {
    fontSize: size,
    lineHeight: 1,
    padding: `${size * 0.12}px ${size * 0.4}px`,
    borderRadius: 'var(--cth-radius-badge)'
  };
}

/**
 * The patch of a prop room's panel its count is laid over.
 *
 * A badge is a position inside the painting like any other, so it goes through
 * the same projection a berth does. The room names ONE berth — the baize, the
 * open almanac, the stack of petitions, the armchair — and the count sits on
 * it, which is the difference between "3 tasks" printed on the card table and
 * "3 tasks" floating in the middle of the parlour's wall.
 *
 * A prop room that names no berth falls back to its whole panel, because the
 * centre of the room is the only honest guess when the manifest has not said
 * where in it the prop stands.
 */
export function badgeBox(room: Room, view: ViewBox): React.CSSProperties {
  return anchorFrame(room.berths[0], view);
}

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

/** One assistant's place setting: card, book, and what they are saying. */
function DeskPlace({ agent, desk, onSelect }: {
  agent: SceneAgent;
  desk: Box;
  onSelect: () => void;
}): JSX.Element {
  const { card, book, scroll } = deskLayout(desk);
  return (
    <>
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
      />
      {agent.bookState
        ? <DeskBook state={agent.bookState} title={agent.bookTitle} box={book} />
        : null}
    </>
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
    const frame = { ...BADGES, ...anchorFrame(berth, view) };
    if (kind === 'cardTable') {
      // The commissions themselves, dealt onto the baize the painting puts
      // there. They replace the four column totals that used to sit here: a
      // total could only ever mean "open the whole board", which is what
      // clicking the room already does.
      if (!berth) return null;
      return (
        <BaizeCards
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
    if (kind === 'writingDesk' && scene.openAskCount > 0) {
      const plate = berth ? berthToBox(berth, view) : { width: view.w, height: view.h };
      return (
        <div data-study-badges="" style={frame}>
          <div
            style={{
              ...countType(plate),
              background: 'var(--cth-status-blocked)',
              color: 'var(--cth-cream-50)'
            }}
          >
            {scene.openAskCount}
          </div>
        </div>
      );
    }
    return null;
  };

  /** The place settings a room holds: whoever the projection seated in it. */
  const occupantsOf = (room: Room, view: ViewBox): React.ReactNode =>
    room.berths.flatMap((berth) => {
      const desk = berthToBox(berth, view);
      return scene.agents
        .filter((agent) => agent.berthId === berth.id)
        .map((agent) => (
          <DeskPlace
            key={agent.id}
            agent={agent}
            desk={stackedBerth(desk, agent.stackIndex)}
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
