/**
 * An assistant, as a gilt-framed portrait card resting at a reading desk.
 *
 * The Study has no walking sprites and no animation frames — a card is a
 * painted portrait in a frame, and the only movement it ever makes is gliding
 * from one berth to another when something real happens (a summons, a
 * reseating). That glide is a CSS transition on `left`/`top` over the shared
 * motion tokens, so the browser owns every frame of it and no per-card JS runs
 * on the floor.
 *
 * A portrait is optional. Rather than render a broken image for an assistant
 * with no art, the frame falls back to a monogram in the display face — the
 * card is still a card, just an unillustrated one.
 */
import type { CSSProperties, KeyboardEvent } from 'react';
import type { Box } from './StudyScene';

/** The four states a card shows. Deliberately coarser than the store's status
 *  vocabulary: at desk-card size the distinction that reads is "at work / at
 *  rest / stuck / gone", and the fine-grained status has the roster to live on. */
export type CardStatus = 'idle' | 'working' | 'blocked' | 'archived';

/**
 * The proportion the portrait pack is painted at, width over height.
 *
 * Every face in `assets/portraits` is 5:6 — 500×600 or 512×614 — and the frame
 * they are drawn in has to be the same, or `object-fit: cover` crops a band out
 * of the middle of each one. The berth cannot supply it: a place setting is
 * more than twice as wide as it is tall, so a card that takes a fixed share of
 * one comes out landscape and a different landscape in every room.
 */
export const PORTRAIT_ASPECT = 5 / 6;

/**
 * How much of the card's height the caption under the portrait takes.
 *
 * A name, and a role under it when there is one. It is the difference between
 * the shape of the CARD and the shape of the frame inside it, which is why the
 * two proportions are not the same number.
 */
const CAPTION_SHARE = 0.28;

/** The proportion the whole card is cut to: the frame plus its caption. */
export const CARD_ASPECT = PORTRAIT_ASPECT * (1 - CAPTION_SHARE);

export interface AgentCardProps {
  name: string;
  role?: string;
  status: CardStatus;
  /** Absent → monogram fallback. */
  portraitSrc?: string;
  box: Box;
  onClick?: () => void;
  /**
   * Called with `true` while the pointer is over the card or the keyboard is
   * on it, and `false` when it leaves.
   *
   * A card at a shared desk is dealt back behind the one above it and shows
   * only the band that one leaves clear. Telling the scene when the card is
   * being looked at is what lets it bring that card forward — the card itself
   * cannot, because the order it is drawn in is not its own to change.
   */
  onLook?: (looking: boolean) => void;
}

const STATUS_COLOR: Record<CardStatus, string> = {
  idle: 'var(--cth-status-idle)',
  working: 'var(--cth-status-working)',
  blocked: 'var(--cth-status-blocked)',
  archived: 'var(--cth-status-ghost)'
};

/** First letter of the name, uppercased; '?' when there is nothing to take. */
export function monogramFor(name: string): string {
  const first = (name || '').trim().charAt(0);
  return first ? first.toUpperCase() : '?';
}

export function AgentCard({
  name, role, status, portraitSrc, box, onClick, onLook
}: AgentCardProps): JSX.Element {
  const interactive = typeof onClick === 'function';
  const root: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    // The place setting is drawn in a layer that takes no pointer, so that the
    // room underneath stays clickable everywhere a setting is laid. The card is
    // the thing in it that IS pressed, so it takes the pointer back.
    pointerEvents: 'auto',
    boxSizing: 'border-box',
    padding: 2,
    background: 'var(--cth-paper-100)',
    boxShadow: 'var(--cth-panel-border-dialog)',
    borderRadius: 'var(--cth-radius-panel)',
    // Archived assistants stay on the floor as a faded presence rather than
    // vanishing — the desk they held is still part of the room's history.
    opacity: status === 'archived' ? 0.45 : 1,
    cursor: interactive ? 'pointer' : 'default',
    transition: [
      'left var(--cth-dur-slow) var(--cth-ease-glide)',
      'top var(--cth-dur-slow) var(--cth-ease-glide)',
      'opacity var(--cth-dur-slow) var(--cth-ease-glide)'
    ].join(', ')
  };

  return (
    <div
      {...(interactive
        ? {
          role: 'button',
          tabIndex: 0,
          onClick,
          // A real <button> answers Enter and Space for free; `role="button"`
          // only promises that it does. Without this the card is reachable by
          // keyboard and inert once you get there. The target check keeps a key
          // pressed on something nested inside from reading as a press of the
          // card — the same guard the roster's card uses.
          onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            onClick?.();
          },
          title: role ? `${name} — ${role}` : name
        }
        : {})}
      {...(onLook
        ? {
          onMouseEnter: () => onLook(true),
          onMouseLeave: () => onLook(false),
          // The keyboard reaches a buried card exactly as the pointer does —
          // it is a tab stop — and would otherwise land on one nobody can see.
          onFocus: () => onLook(true),
          onBlur: () => onLook(false)
        }
        : {})}
      data-study-card={name}
      style={root}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
          // The frame is cut to the portrait, not to whatever height is left
          // over once the caption has taken its share — otherwise a card that
          // is the right shape still crops the face inside it. `alignSelf`
          // stops the column stretching it back to full width, and the cap
          // keeps a very short card from pushing the frame past the card's edge.
          alignSelf: 'center',
          aspectRatio: `${PORTRAIT_ASPECT * 6} / 6`,
          maxWidth: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
          background: 'var(--cth-paper-200)',
          borderRadius: 'var(--cth-radius-control)'
        }}
      >
        {portraitSrc ? (
          <img
            src={portraitSrc}
            alt=""
            aria-hidden
            draggable={false}
            style={{ width: '100%', height: '100%', objectFit: 'cover', userSelect: 'none' }}
          />
        ) : (
          <div
            style={{
              fontFamily: 'var(--cth-font-display)',
              fontSize: 'var(--cth-text-display-md)',
              color: 'var(--cth-gilt)',
              userSelect: 'none'
            }}
          >
            {monogramFor(name)}
          </div>
        )}
      </div>
      <div
        style={{
          flexShrink: 0,
          paddingTop: 2,
          textAlign: 'center',
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
          fontFamily: 'var(--cth-font-display)',
          fontSize: 'var(--cth-text-display-sm)',
          color: 'var(--cth-ink-900)'
        }}
      >
        {name}
      </div>
      {role ? (
        <div
          style={{
            flexShrink: 0,
            textAlign: 'center',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            fontFamily: 'var(--cth-font-ui)',
            fontSize: 'var(--cth-text-body-sm)',
            color: 'var(--cth-ink-500)'
          }}
        >
          {role}
        </div>
      ) : null}
      <div
        title={status}
        data-study-card-status={status}
        style={{
          position: 'absolute',
          right: 3,
          top: 3,
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: STATUS_COLOR[status],
          boxShadow: 'var(--cth-panel-border)'
        }}
      />
    </div>
  );
}
