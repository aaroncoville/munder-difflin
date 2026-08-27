/**
 * Which floor the app is standing on.
 *
 * This is the entire shared surface between the Study and the rest of the
 * application: one conditional, defaulting to the pixel office. Everything else
 * the theme does is a token swap, so light and dark keep exactly the floor they
 * have always had, and a theme added later gets it too without touching this
 * file.
 *
 * The office is reached through a dynamic import rather than a static one, and
 * that is not tidiness — Pixi and the tileset atlases are the single largest
 * thing the renderer loads, and under the occult theme not one pixel of them is
 * drawn. A static import would have the Study download the whole office in
 * order to render a painting instead of it.
 */
import { lazy, Suspense } from 'react';
import { useAppTheme, type AppTheme } from '@/design/theme';
import { StudyScene } from './StudyScene';

export const OfficeFloorLazy = lazy(async () => ({
  default: (await import('@/scene/office/OfficeFloor')).OfficeFloor
}));

/** The occult theme is painted; everything else is the pixel office. */
export function floorForTheme(theme: AppTheme): 'study' | 'office' {
  return theme === 'occult' ? 'study' : 'office';
}

export function FloorHost(): JSX.Element {
  const theme = useAppTheme();
  if (floorForTheme(theme) === 'study') return <StudyScene />;
  return (
    <Suspense
      fallback={
        <div style={{ width: '100%', height: '100%', background: 'var(--cth-cream-200)' }} />
      }
    >
      <OfficeFloorLazy />
    </Suspense>
  );
}
