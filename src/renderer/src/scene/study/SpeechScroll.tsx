/**
 * What an assistant is saying, as a slip of parchment above its card — the
 * Study's replacement for the office floor's thought and tool bubbles.
 *
 * Two rules keep it from taking over the room. It renders nothing at all when
 * there is nothing to say, so a quiet floor stays a painting rather than a wall
 * of empty boxes; and it is capped and clipped, so a long stretch of reasoning
 * cannot grow up over the shelves.
 *
 * It is `pointer-events: none` on purpose: the scroll sits over the card it
 * belongs to, and a click there means "open this assistant", not "select this
 * text".
 */
import type { CSSProperties } from 'react';

export interface SpeechScrollProps {
  text: string;
  /** Height is the text's own — only the anchor and the width are placed. */
  box: { left: number; top: number; width: number };
}

export function SpeechScroll({ text, box }: SpeechScrollProps): JSX.Element | null {
  const body = (text || '').trim();
  if (!body) return null;
  const style: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    boxSizing: 'border-box',
    padding: '3px 5px',
    background: 'var(--cth-cream-50)',
    color: 'var(--cth-ink-700)',
    fontFamily: 'var(--cth-font-ui)',
    fontSize: 'var(--cth-text-body-sm)',
    lineHeight: 1.25,
    borderRadius: 'var(--cth-radius-panel)',
    boxShadow: 'var(--cth-panel-border)',
    // A long thought is clipped, not scrolled: the scene is a painting, and a
    // scrollbar in the middle of it would be the only one in the room.
    maxHeight: '3.75em',
    overflow: 'hidden',
    pointerEvents: 'none',
    transition: 'left var(--cth-dur-slow) var(--cth-ease-glide), top var(--cth-dur-slow) var(--cth-ease-glide)'
  };
  return <div data-study-speech="" style={style}>{body}</div>;
}
