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
import type { CSSProperties } from 'react';
import type { Box } from './StudyScene';

/** The four states a card shows. Deliberately coarser than the store's status
 *  vocabulary: at desk-card size the distinction that reads is "at work / at
 *  rest / stuck / gone", and the fine-grained status has the roster to live on. */
export type CardStatus = 'idle' | 'working' | 'blocked' | 'archived';

export interface AgentCardProps {
  name: string;
  role?: string;
  status: CardStatus;
  /** Absent → monogram fallback. */
  portraitSrc?: string;
  box: Box;
  onClick?: () => void;
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
  name, role, status, portraitSrc, box, onClick
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
        ? { role: 'button', tabIndex: 0, onClick, title: role ? `${name} — ${role}` : name }
        : {})}
      data-study-card={name}
      style={root}
    >
      <div
        style={{
          flex: 1,
          minHeight: 0,
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
