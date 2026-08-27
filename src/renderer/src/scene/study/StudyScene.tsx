/**
 * The Study — the painted scene that replaces the pixel office floor under the
 * occult theme.
 *
 * The Study is a cross-section of a house, drawn flat and straight on: each
 * room is its own panel, panels sit side by side to make a storey, and the
 * storeys stack from the top of the building down with a band of masonry
 * between them. There is no single backdrop and no perspective. A house taller
 * than the window simply scrolls.
 *
 * Every room draws three stacked layers, bottom to top:
 *
 *   1. its panel image, contain-fitted so the whole painting is always visible
 *      and never cropped;
 *   2. a reserved slot for the ambiance canvas (flicker, motes, hearth smoke),
 *      which mounts nothing yet — it is `pointer-events: none` by contract, so
 *      that when it does arrive every click still belongs to the DOM;
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
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import {
  houseRows,
  loadRoomManifest,
  type AnchorKind,
  type Berth,
  type Room,
  type RoomManifest
} from './roomManifest';
import { AgentCard } from './AgentCard';
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

/** The width at which every storey draws at its natural height. */
export const HOUSE_NATURAL_WIDTH = STOREYS.length === 0 ? 0 : Math.max(
  ...STOREYS.map((rooms) => {
    const tallest = Math.max(...rooms.map((r) => r.natural.h));
    return rooms.reduce((sum, r) => sum + (r.natural.w / r.natural.h) * tallest, 0)
      + studyRoom.bandThickness * (rooms.length - 1);
  })
);

/**
 * Where the card, the book and the scroll sit inside one berth.
 *
 * A berth is the whole place setting, not the card — the room has a desk there,
 * and the card has to look like it is resting ON it with room left for a volume
 * beside it. The scroll floats clear above, outside the berth, which is why it
 * is the only piece allowed past those bounds.
 */
export function deskLayout(desk: Box):
{ card: Box; book: Box; scroll: { left: number; top: number; width: number } } {
  const cardW = desk.width * 0.62;
  return {
    card: {
      left: desk.left + (desk.width - cardW) / 2,
      top: desk.top,
      width: cardW,
      height: desk.height * 0.78
    },
    book: {
      left: desk.left + desk.width * 0.62,
      top: desk.top + desk.height * 0.78,
      width: desk.width * 0.34,
      height: desk.height * 0.2
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

/** Where the nth assistant at one berth sits. The first sits at the berth. */
export function stackedBerth(desk: Box, stackIndex: number): Box {
  return {
    ...desk,
    left: desk.left + desk.width * STACK_OFFSET.x * stackIndex,
    top: desk.top + desk.height * STACK_OFFSET.y * stackIndex
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
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  fontFamily: 'var(--cth-font-display)',
  fontSize: 'var(--cth-text-display-sm)',
  color: 'var(--cth-ink-900)'
};

/**
 * The measured width of the scroll host.
 *
 * This is the only measurement the house takes. Everything below it — every
 * storey's height, every panel's box — is arithmetic from this one number, so
 * the rooms stay hook-free and can be reasoned about (and rendered in a test)
 * as pure functions of the manifest. Falls back to the house's natural width
 * where there is no layout to measure.
 */
function useHouseWidth(hostRef: React.RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(HOUSE_NATURAL_WIDTH);
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => setWidth(host.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef]);
  return width;
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
        portraitSrc={portraitFor({ id: agent.id, name: agent.name, role: agent.role })}
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
      />
      <div data-study-layer="cards" style={{ position: 'absolute', inset: 0 }}>
        {typeof children === 'function' ? children(view) : children}
      </div>
    </div>
  );
}

export function StudyScene(): JSX.Element {
  // A house that could not be read is not a house that can be drawn half-way.
  // Throwing here hands the decision to the floor host's boundary, which puts
  // the office floor up — before any hook runs, so the throw is the whole render.
  if (studyRoomError) throw new Error(`the Study has no floor plan: ${studyRoomError}`);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const houseWidth = useHouseWidth(hostRef);
  const scene = useSceneState();
  const select = useStore((s) => s.select);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
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
    // Intercepted by the main process while terminals are alive — the same call
    // the office floor's clock makes.
    hearth: () => window.close()
  };

  const badgesFor = (kind: AnchorKind): React.ReactNode => {
    if (kind === 'cardTable') {
      return (
        <div style={BADGES}>
          {KANBAN_COLUMNS.map((column) => (
            <div
              key={column}
              title={column}
              style={{
                padding: '1px 4px',
                borderRadius: 'var(--cth-radius-badge)',
                background: 'var(--cth-paper-100)',
                boxShadow: 'var(--cth-panel-border)'
              }}
            >
              {scene.kanbanCounts[column]}
            </div>
          ))}
        </div>
      );
    }
    if (kind === 'writingDesk' && scene.openAskCount > 0) {
      return (
        <div style={BADGES}>
          <div
            style={{
              padding: '1px 5px',
              borderRadius: 'var(--cth-radius-badge)',
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
    if (room.kind === 'desk' || room.kind === 'godStudy') {
      return (
        <RoomPanel key={room.id} room={room} height={height}>
          {(view: ViewBox) => occupantsOf(room, view)}
        </RoomPanel>
      );
    }
    const kind = room.kind;
    return (
      <RoomPanel
        key={room.id}
        room={room}
        height={height}
        label={ANCHOR_LABEL[kind]}
        onClick={ANCHOR_CLICK[kind]}
      >
        {badgesFor(kind)}
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
        overflowY: 'auto',
        overflowX: 'hidden',
        background: 'var(--cth-cream-300)'
      }}
    >
      <div
        data-study-house=""
        style={{ display: 'flex', flexDirection: 'column', width: '100%' }}
      >
        {STOREYS.map((rooms, i) => {
          const height = storeyHeight(rooms, houseWidth, studyRoom.bandThickness);
          return (
          <Fragment key={rooms[0].id}>
            {i > 0 ? (
              <div
                data-study-band=""
                style={{
                  height: studyRoom.bandThickness,
                  flex: '0 0 auto',
                  background: 'var(--cth-ink-700)'
                }}
              />
            ) : null}
            <div
              data-study-storey={i}
              style={{
                display: 'flex',
                flex: '0 0 auto',
                justifyContent: 'center',
                gap: studyRoom.bandThickness,
                height
              }}
            >
              {rooms.map((room) => renderRoom(room, height))}
            </div>
          </Fragment>
          );
        })}
      </div>
    </div>
  );
}
