// Theme loader: resolves the office ThemeConfig into a ready-to-render map,
// parsing its Tiled JSON and patching the appended tileset atlases with their
// inline metadata.

import type { TiledMap } from './TiledMapRenderer';
import { OFFICE_THEME, type ThemeConfig } from './themeRegistry';

/** Parse a theme's raw Tiled JSON and patch its tileset array.
 *  `embedded` atlases keep the map's own inline metadata; the rest are replaced
 *  by the theme's inline metadata (firstgid + image dimensions). The result's
 *  tileset order matches the texture-load order (texture[i] ↔ tilesets[i]). */
export function resolveThemeMap(theme: ThemeConfig): TiledMap {
  const m = JSON.parse(theme.mapRaw) as TiledMap;
  return {
    ...m,
    tilesets: theme.tilesets.map((t, i) => {
      if (t.embedded) return m.tilesets[i];
      // Strip the renderer-only fields (url/embedded); the rest is Tiled metadata.
      const { url: _url, embedded: _embedded, ...meta } = t;
      return meta as TiledMap['tilesets'][number];
    }),
  };
}

/** The ordered tileset image URLs to load as textures, matching the map's
 *  tileset order (so texture[i] lines up with tilesets[i]). */
export function themeTilesetUrls(theme: ThemeConfig): string[] {
  return theme.tilesets.map((t) => t.url);
}

/** The office theme, ready to render. Async so the scene's start-up keeps
 *  one shape; there is nothing to fetch. */
export async function loadTheme(): Promise<ThemeConfig> {
  return OFFICE_THEME;
}
