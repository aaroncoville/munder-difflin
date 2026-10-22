/**
 * The tileset atlases, loaded once per process.
 *
 * The floor is rebuilt from scratch more often than it looks: a WebGL context
 * eviction, a GPU-process restart, an afternoon behind a fullscreen terminal
 * (floorRelease.ts) and a theme change all tear the Application down and build
 * it again. Each build used to load its atlases afresh, and `Texture.from(img)`
 * registers every new Image in Pixi's global Cache — keyed by the Image object,
 * so no two loads ever collide — which means every rebuild left the previous
 * atlases (and their GPU uploads, until the context went) retained for the
 * life of the process. A floor that lost its context three times held four
 * copies of every tileset.
 *
 * Loaded here instead, keyed by URL, the atlas is one TextureSource for the
 * life of the process and a rebuild reuses it. The sub-textures cut from it
 * per scene (tiles, and the monitor glyphs textureForGid hands out) belong to
 * the TiledMapRenderer that cut them and go with it — releaseTextures(), the
 * one call the floor makes on teardown — because each one subscribes to the
 * source's 'resize' event and would otherwise hang off the shared atlas for
 * as long as it lives.
 */
import { Texture } from 'pixi.js';

const cache = new Map<string, Promise<Texture>>();

/** Load a texture via an <img> element. Unlike Pixi's Assets.load(), this
 *  handles extension-less data: URLs (Vite inlines small assets like the a5
 *  tileset as base64), which the Assets resolver fails to type-detect. A
 *  failed load is not cached, so the next build tries again. */
export function loadTexture(url: string): Promise<Texture> {
  const hit = cache.get(url);
  if (hit) return hit;
  const pending = new Promise<Texture>((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const tex = Texture.from(img);
      tex.source.scaleMode = 'nearest';
      resolve(tex);
    };
    img.onerror = () => reject(new Error('failed to load ' + url.slice(0, 40)));
    img.src = url;
  });
  cache.set(url, pending);
  pending.catch(() => { if (cache.get(url) === pending) cache.delete(url); });
  return pending;
}

/** How many atlases are held. For tests. */
export function cachedTextureCount(): number {
  return cache.size;
}
