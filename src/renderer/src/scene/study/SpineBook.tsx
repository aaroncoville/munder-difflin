/**
 * A commission seen end-on: the bound volume both the card table and a reading
 * desk draw it as.
 *
 * It was the card table's alone, drawn inline where the piles are laid out, and
 * a desk drew its waiting volumes as something else — its own boards, its own
 * room's binding, no printed handle. Two alphabets for one object. A commission
 * nobody has opened is the same thing whichever surface it is standing on, and
 * the surface is already saying the thing that differs: on the felt nobody has
 * picked it up, on a desk somebody is holding it.
 *
 * So it lives here, and both surfaces render THIS. Not a shared stylesheet or a
 * copied block — the same component, so the two cannot drift apart into looking
 * nearly alike, which is worse than looking different.
 *
 * The volume in HAND is not this. It is an open book, bound for its room, with
 * its pages turning — see `DeskBook`. That difference is the whole signal.
 */
import { PETITION_EDGE, SPINE_FACES, spineMark, spineType, type Box } from './BaizeStacks';
import type { HiveTask } from '@/components/TasksKanban';
import {
  NOTHING_PULLED, bookIsPulled, pullHands, pullRing, PULL_Z, type PulledBooks
} from './pulledBooks';

export interface SpineBookProps {
  id: string;
  title: string;
  status: HiveTask['status'];
  /** Waiting on the human: wears the petition head instead of the status one. */
  petition?: boolean;
  box: Box;
  /**
   * Which surface it is standing on.
   *
   * Drawn identically on both — that is the point of this component — but the
   * house has to be able to ASK. The felt holds what nobody has picked up and a
   * desk holds what somebody is holding, and telling those apart is the whole
   * of the placement rule; a mark that named only the object would make every
   * question about the card table quietly answer for the desks as well.
   */
  surface: 'felt' | 'desk';
  onOpen: (id: string) => void;
  /** Which book each hand is on, and how to say a hand has moved — see
   *  `pulledBooks`. Omitted where a spine is drawn as scenery. */
  pulled?: PulledBooks;
  onPull?: (next: PulledBooks) => void;
}

export function SpineBook({
  id, title, status, petition, box, surface, onOpen, pulled, onPull
}: SpineBookProps): JSX.Element {
  const face = SPINE_FACES[status];
  const n = spineMark({ id });
  const { fontSize } = spineType(box, n);
  // Stopping the event is what keeps the surface underneath — a room that opens
  // the board, a place setting that selects an assistant — from firing as well.
  const open = (stop: () => void): void => { stop(); onOpen(id); };
  const hands = pulled ?? NOTHING_PULLED;
  const held = bookIsPulled(hands, id);
  return (
    <div
      data-spine-book={id}
      data-spine-on={surface}
      {...(petition ? { 'data-spine-petition': '' } : {})}
      role="button"
      tabIndex={0}
      title={petition ? `${title} — ${status}, awaiting you` : `${title} — ${status}`}
      aria-label={title}
      onClick={(e: React.MouseEvent) => open(() => e.stopPropagation())}
      onKeyDown={(e: React.KeyboardEvent) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        open(() => e.stopPropagation());
      }}
      {...pullHands(id, hands, onPull)}
      style={{
        position: 'absolute',
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        // Forward while a hand is on it: books overlap on both surfaces this is
        // drawn on — the felt leans them, a desk pile stacks them — so a ring
        // drawn in place would be overpainted by the next book along.
        ...(held ? { zIndex: PULL_Z } : {}),
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        boxSizing: 'border-box',
        borderRadius: 'var(--cth-radius-badge)',
        cursor: 'pointer',
        userSelect: 'none',
        // Takes the pointer back for itself, the way every other pressable
        // piece in the house does. A place setting is drawn as one layer
        // spanning its whole room and that layer takes NO pointer, or the room
        // underneath would stop being clickable everywhere somebody is sitting.
        // A book standing on a desk therefore inherits "untouchable" unless it
        // says otherwise, and said nothing — so it was drawn correctly, wore
        // the right face, carried a handler, and was dead to the mouse. On the
        // felt there is no such layer, which is why the identical component
        // worked on one surface and not the other.
        pointerEvents: 'auto',
        background: face.background,
        // The head band at the spine's near end, and a hairline all round so
        // one book has an edge against the next. Proportional, for the same
        // reason the type is.
        // The head band and the hairline are INSET, so the ring — which is
        // outset — is another layer rather than a replacement: a held book keeps
        // its own edges and gains one.
        boxShadow: `inset ${Math.max(2, box.width * 0.06)}px 0 0 `
          + `${petition ? PETITION_EDGE : face.edge}, `
          + `inset 0 0 0 ${Math.max(1, box.height * 0.06)}px var(--cth-ink-300)`
          + (held ? `, ${pullRing(box)}` : '')
      }}
    >
      <div
        data-spine-number=""
        style={{
          // Turned a quarter, the way a title is printed on a book that is
          // lying down: the digits run across the thickness of the spine rather
          // than along its length.
          transform: 'rotate(90deg)',
          fontFamily: 'var(--cth-font-display)',
          fontSize,
          lineHeight: 1,
          color: face.color,
          pointerEvents: 'none'
        }}
      >
        {n}
      </div>
    </div>
  );
}
