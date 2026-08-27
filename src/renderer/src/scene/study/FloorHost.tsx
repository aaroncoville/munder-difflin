/**
 * Which floor the app is standing on.
 *
 * This is the entire shared surface between the Study and the rest of the
 * application: one conditional, defaulting to the pixel office. Everything else
 * the theme does is a token swap, so light and dark keep exactly the floor they
 * have always had, and a theme added later gets it too without touching this
 * file.
 *
 * Which of the two floors is code-split is not a matter of size. The office is
 * imported statically, because light and dark have always painted it on the
 * first frame and a lazy chunk would replace that with an empty window for as
 * long as the fetch takes — and for ever if the fetch fails. The Study takes
 * the chunk instead: it is reached from one theme, so the other two never pay
 * for its art, and a chunk that will not load costs the theme that asked for it
 * rather than the app.
 *
 * That last part is why the Study also renders under a boundary. It parses a
 * hand-edited floor plan and it is the youngest code in the renderer; a throw
 * anywhere beneath it would otherwise unmount the whole React tree and leave a
 * blank window with no way back — including for light and dark, one theme
 * switch later. The boundary's fallback is the office floor, so the worst the
 * Study can do is fail to be the Study.
 */
import { Component, lazy, Suspense, type ReactNode } from 'react';
import { useAppTheme, type AppTheme } from '@/design/theme';
import { OfficeFloor } from '@/scene/office/OfficeFloor';

export const StudySceneLazy = lazy(async () => ({
  default: (await import('./StudyScene')).StudyScene
}));

/** The occult theme is painted; everything else is the pixel office. */
export function floorForTheme(theme: AppTheme): 'study' | 'office' {
  return theme === 'occult' ? 'study' : 'office';
}

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
 * cached as failed — so a retry would flicker rather than recover. Switching
 * theme unmounts this and mounts a fresh one, which is the honest way back.
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
    // Falling back silently would make a broken Study look like a theme that
    // simply does not have one.
    console.error('the Study floor failed; falling back to the office floor', error);
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

export function FloorHost(): JSX.Element {
  const theme = useAppTheme();
  if (floorForTheme(theme) !== 'study') return <OfficeFloor />;
  return (
    <FloorErrorBoundary fallback={<OfficeFloor />}>
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
