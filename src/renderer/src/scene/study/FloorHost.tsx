/**
 * The floor the app stands on: the Study.
 *
 * It is reached through a lazy chunk so its art is fetched after the chrome has
 * painted, and it renders under a boundary. It parses a hand-edited floor plan
 * and it is the youngest code in the renderer; a throw anywhere beneath it
 * would otherwise unmount the whole React tree and leave a blank window with no
 * way back. The boundary's fallback is a plain panel saying the room could not
 * be drawn, so the worst the Study can do is fail to be the Study — the chrome
 * around it, the agents and their terminals all keep working.
 */
import { Component, lazy, Suspense, type ReactNode } from 'react';

export const StudySceneLazy = lazy(async () => ({
  default: (await import('./StudyScene')).StudyScene
}));

interface BoundaryProps {
  /** What to draw instead once something below has thrown. */
  fallback: ReactNode;
  children?: ReactNode;
}

/**
 * Puts `fallback` up when the floor below it throws.
 *
 * A class, because `getDerivedStateFromError` has no hook equivalent — React
 * offers no other way to catch a render error. It also catches a lazy chunk
 * that rejects, which Suspense does NOT: Suspense handles a chunk that has not
 * arrived yet, and has nothing to say about one that never will.
 *
 * There is no retry. A floor plan that does not validate will not validate on
 * the next render either, and a chunk that failed to load has already been
 * cached as failed — so a retry would flicker rather than recover.
 */
export class FloorErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    // The panel says only that the room could not be drawn; the reason belongs
    // where someone debugging it will look.
    console.error('the Study floor failed to draw', error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** What stands where the Study would have been, once it has failed. */
export function StudyUnavailable(): JSX.Element {
  return (
    <div
      role="status"
      style={{
        width: '100%', height: '100%',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--cth-space-4)',
        background: 'var(--cth-cream-300)',
        color: 'var(--cth-ink-500)',
        fontFamily: 'var(--cth-font-ui)',
        fontSize: 'var(--cth-text-body-md)',
        textAlign: 'center'
      }}
    >
      The room could not be drawn.
    </div>
  );
}

export function FloorHost(): JSX.Element {
  return (
    <FloorErrorBoundary fallback={<StudyUnavailable />}>
      <Suspense
        fallback={
          <div style={{ width: '100%', height: '100%', background: 'var(--cth-cream-300)' }} />
        }
      >
        <StudySceneLazy />
      </Suspense>
    </FloorErrorBoundary>
  );
}
