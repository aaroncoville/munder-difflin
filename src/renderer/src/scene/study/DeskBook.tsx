/**
 * A task, as the book open on an assistant's desk.
 *
 * The three states are the three things a reader can be doing with a volume,
 * and they are drawn rather than labelled: a closed book shows only its spine,
 * an open one shows two pages, and a book whose work is impeded is closed with
 * a ribbon seal across it. At desk scale that reads across the room without any
 * text at all.
 *
 * Pure CSS shapes, no images — so the book recolours with the theme and costs
 * nothing to load, and so the art track never has to produce three sprites per
 * task state.
 */
import type { CSSProperties } from 'react';
import type { Box } from './StudyScene';

export type BookState = 'closed' | 'open' | 'sealed';

export interface DeskBookProps {
  state: BookState;
  /** The task's title, shown on hover. */
  title?: string;
  box: Box;
}

const COVER: CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: 'var(--cth-gilt-soft)',
  borderRadius: 'var(--cth-radius-badge)',
  boxShadow: 'var(--cth-panel-border)'
};

export function DeskBook({ state, title, box }: DeskBookProps): JSX.Element {
  const root: CSSProperties = {
    position: 'absolute',
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    // Inside a layer that takes no pointer — see the place setting in
    // StudyScene — so the book takes it back, or it loses its own tooltip.
    pointerEvents: 'auto',
    transition: 'left var(--cth-dur-slow) var(--cth-ease-glide), top var(--cth-dur-slow) var(--cth-ease-glide)'
  };
  return (
    <div
      data-book-state={state}
      {...(title ? { title } : {})}
      style={root}
    >
      <div style={COVER} />
      {state === 'open' ? (
        <>
          <div
            data-book-page="left"
            style={{
              position: 'absolute',
              left: '6%', top: '12%', width: '42%', height: '76%',
              background: 'var(--cth-cream-50)',
              borderRadius: 'var(--cth-radius-badge)'
            }}
          />
          <div
            data-book-page="right"
            style={{
              position: 'absolute',
              right: '6%', top: '12%', width: '42%', height: '76%',
              background: 'var(--cth-cream-50)',
              borderRadius: 'var(--cth-radius-badge)'
            }}
          />
        </>
      ) : (
        <div
          data-book-spine=""
          style={{
            position: 'absolute',
            left: '14%', top: 0, width: '10%', height: '100%',
            background: 'var(--cth-gilt)'
          }}
        />
      )}
      {state === 'sealed' ? (
        <div
          data-book-ribbon=""
          style={{
            position: 'absolute',
            left: 0, top: '42%', width: '100%', height: '16%',
            background: 'var(--cth-status-blocked)',
            boxShadow: 'var(--cth-panel-border)'
          }}
        />
      ) : null}
    </div>
  );
}
