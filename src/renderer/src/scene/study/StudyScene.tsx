/**
 * The Study — the painted scene that replaces the pixel office floor under the
 * occult theme.
 *
 * Three stacked layers, bottom to top:
 *
 *   1. the backdrop image, contain-fitted so the whole painting is always
 *      visible and never cropped;
 *   2. a reserved slot for the ambiance canvas (flicker, motes, hearth smoke),
 *      which mounts nothing yet — it is `pointer-events: none` by contract, so
 *      that when it does arrive every click still belongs to the DOM;
 *   3. the card layer: an assistant at each occupied berth, the book of what
 *      they are working on, what they are saying, and the room's five props.
 *
 * Because the backdrop is letterboxed rather than stretched, the layout can NOT
 * be expressed in CSS percentages: a berth at x=0.5 is halfway across the
 * *image*, which is not halfway across the container unless the aspects happen
 * to match. Every position therefore goes through `berthToBox`, against the
 * measured box the image actually occupies.
 */
import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import backdropUrl from './assets/backdrop-placeholder.png';
import { loadRoomManifest, type Berth } from './roomManifest';
import { AgentCard } from './AgentCard';
import { DeskBook } from './DeskBook';
import { SpeechScroll } from './SpeechScroll';
import { portraitFor } from './portraits';
import { useSceneState, type SceneAgent } from './useSceneState';

/** Where the backdrop actually landed inside the container, in px. */
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

/** Natural size of the shipped backdrop — the frame the berths were authored in. */
export const BACKDROP_NATURAL = { w: 1344, h: 768 };

/** The image the scene renders. Exported so a test can hold it against the
 *  path room.json declares; the two drifting apart would put every berth on a
 *  painting they were not authored for. */
export const BACKDROP_SRC: string = backdropUrl;

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

/** A normalized berth, projected onto the box the backdrop occupies. */
export function berthToBox(berth: Berth, view: ViewBox): Box {
  return {
    left: view.x + berth.x * view.w,
    top: view.y + berth.y * view.h,
    width: berth.w * view.w,
    height: berth.h * view.h
  };
}

/** The floor plan the scene is drawn from — parsed once, shared by its children. */
export const studyRoom = loadRoomManifest();

/**
 * Where the card, the book and the scroll sit inside one berth.
 *
 * A berth is the whole place setting, not the card — the painting has a desk
 * there, and the card has to look like it is resting ON it with room left for a
 * volume beside it. The scroll floats clear above, outside the berth, which is
 * why it is the only piece allowed past those bounds.
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
 * What each prop in the room is called and what clicking it does.
 *
 * These read in the Study's own idiom rather than the app's — an Ask Me board
 * is a writing desk of unanswered petitions here. They are English literals
 * for now: the Secret Histories locale that will own this vocabulary arrives
 * with the rest of the voice work, and keying them into the shared catalog
 * before that exists would put occult wording in front of light and dark too.
 */
export const ANCHOR_LABEL = {
  cardTable: 'Tasks',
  writingDesk: 'Petitions',
  almanac: 'Triggers',
  hearth: 'Closing Time',
  shelves: 'The Archive'
} as const;

const KANBAN_COLUMNS = ['todo', 'doing', 'blocked', 'done'] as const;

const ZONE: React.CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 3,
  boxSizing: 'border-box',
  borderRadius: 'var(--cth-radius-panel)',
  fontFamily: 'var(--cth-font-display)',
  fontSize: 'var(--cth-text-display-sm)',
  color: 'var(--cth-ink-900)'
};

/** The measured backdrop box. Falls back to the natural size where there is no
 *  layout to measure (node tests), so the projection is still exercisable. */
function useViewBox(hostRef: React.RefObject<HTMLDivElement | null>): ViewBox {
  const [view, setView] = useState<ViewBox>(() => containFit(BACKDROP_NATURAL, BACKDROP_NATURAL));
  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const measure = (): void => {
      setView(containFit({ w: host.clientWidth, h: host.clientHeight }, BACKDROP_NATURAL));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, [hostRef]);
  return view;
}

/** A clickable prop. Anchors that only mark a place render without the button
 *  semantics, so a screen reader is not offered a control that does nothing. */
function AnchorZone({ label, box, onClick, children }: {
  label: string;
  box: Box;
  onClick?: () => void;
  children?: React.ReactNode;
}): JSX.Element {
  const interactive = typeof onClick === 'function';
  return (
    <div
      title={label}
      aria-label={label}
      {...(interactive ? { role: 'button', tabIndex: 0, onClick } : {})}
      style={{
        ...ZONE,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        cursor: interactive ? 'pointer' : 'default',
        boxShadow: 'var(--cth-panel-border)'
      }}
    >
      {children}
    </div>
  );
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

export function StudyScene(): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const view = useViewBox(hostRef);
  const scene = useSceneState();
  const select = useStore((s) => s.select);
  const requestCommandCenterTab = useStore((s) => s.requestCommandCenterTab);
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id);

  const berths = new Map<string, Berth>(
    [...studyRoom.deskBerths, studyRoom.godBerth].map((b) => [b.id, b])
  );
  const anchorBox = (key: keyof typeof ANCHOR_LABEL): Box =>
    berthToBox(studyRoom.anchors[key], view);

  /** The petitions are the god's to answer, so opening them selects him too —
   *  the same pair of actions the office floor's ASK ME board fires. */
  const openPetitions = (): void => {
    if (godId) select(godId);
    requestCommandCenterTab('human');
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
      <img
        src={BACKDROP_SRC}
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
        <AnchorZone
          label={ANCHOR_LABEL.cardTable}
          box={anchorBox('cardTable')}
          onClick={() => requestCommandCenterTab('tasks')}
        >
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
        </AnchorZone>
        <AnchorZone
          label={ANCHOR_LABEL.writingDesk}
          box={anchorBox('writingDesk')}
          onClick={openPetitions}
        >
          {scene.openAskCount > 0 ? (
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
          ) : null}
        </AnchorZone>
        <AnchorZone
          label={ANCHOR_LABEL.almanac}
          box={anchorBox('almanac')}
          onClick={() => requestCommandCenterTab('triggers')}
        />
        <AnchorZone
          label={ANCHOR_LABEL.hearth}
          box={anchorBox('hearth')}
          // Intercepted by the main process while terminals are alive — the
          // same call the office floor's clock makes.
          onClick={() => window.close()}
        />
        <AnchorZone label={ANCHOR_LABEL.shelves} box={anchorBox('shelves')} />
        {scene.agents.map((agent) => {
          const berth = berths.get(agent.berthId);
          if (!berth) return null;
          return (
            <DeskPlace
              key={agent.id}
              agent={agent}
              desk={berthToBox(berth, view)}
              onSelect={() => select(agent.id)}
            />
          );
        })}
      </div>
    </div>
  );
}
