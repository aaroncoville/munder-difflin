'use strict';

// Who owns which texture across a rebuild of the office floor.
//
// The floor is rebuilt on a WebGL context eviction, a GPU-process restart, an
// afternoon behind a fullscreen terminal and a theme change. Each build used to
// load the tileset atlases afresh, and Texture.from(img) registers every Image
// in Pixi's global Cache, so every rebuild retained the previous atlases for the
// life of the process. Now the atlases are loaded once per process (keyed by
// URL) and the sub-textures cut from them — tiles, monitor glyphs — belong to
// the scene, which destroys them: each one subscribes to its atlas source's
// 'resize' event and would otherwise hang off the shared atlas forever.
//
// Driven with a pixi that only counts: textures made, textures destroyed, and
// the listeners left on each atlas source.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');

function countingPixi() {
  class Container {
    constructor() {
      this.children = []; this.destroyed = false;
      this.x = 0; this.y = 0; this.rotation = 0; this.visible = true;
      this.scale = { x: 1, y: 1, set() {} }; this.anchor = { set() {} };
    }
    addChild(c) { this.children.push(c); c.parent = this; return c; }
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); }
    destroy() { this.destroyed = true; for (const c of this.children) c.destroy?.(); }
  }
  class Sprite extends Container { constructor(texture) { super(); this.texture = texture; } }
  class Graphics extends Container {
    rect() { return this; } roundRect() { return this; } circle() { return this; }
    fill() { return this; } stroke() { return this; } clear() { return this; }
    moveTo() { return this; } lineTo() { return this; }
  }
  class Rectangle { constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); } }
  class Source { constructor() { this.listeners = 0; this.scaleMode = 'linear'; } on() { this.listeners += 1; } off() { this.listeners -= 1; } }
  const made = [];
  class Texture {
    constructor({ source, frame } = {}) {
      this.source = source ?? new Source();
      this.frame = frame; this.destroyed = false;
      this.source.on();
      made.push(this);
    }
    destroy() { if (this.destroyed) throw new Error('destroyed twice'); this.destroyed = true; this.source.off(); }
    static from(resource) { const t = new Texture(); t.resource = resource; return t; }
  }
  return { made, Source, module: { __esModule: true, Container, Sprite, Graphics, Rectangle, Texture } };
}

/** Run `fn` with the counting pixi standing in for the real one. */
function withPixi(fn) {
  const fake = countingPixi();
  const id = require.resolve('pixi.js');
  const had = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: fake.module };
  try { return fn(fake); } finally {
    if (had) require.cache[id] = had; else delete require.cache[id];
  }
}

// A 3×2 map: four tiles on the floor, one on the walls, one empty cell.
const MAP = {
  width: 3, height: 2, tilewidth: 16, tileheight: 16,
  tilesets: [{ firstgid: 1, columns: 4, tilewidth: 16, tileheight: 16, tilecount: 16 }],
  layers: [
    { name: 'floor', type: 'tilelayer', data: [1, 2, 3, 4, 0, 5] },
    { name: 'walls', type: 'tilelayer', data: [0, 0, 0, 0, 6, 0] }
  ]
};

test('a scene releases every tile it cut from the atlas, and leaves the atlas alone', () => withPixi((pixi) => {
  const { TiledMapRenderer } = loadTs.fresh('src/renderer/src/scene/office/TiledMapRenderer.ts');
  const atlas = new pixi.module.Texture();
  assert.equal(atlas.source.listeners, 1, 'the atlas itself listens to its source');

  const map = new TiledMapRenderer(MAP, [atlas]);
  const tiles = pixi.made.filter((t) => t !== atlas);
  assert.equal(tiles.length, 6, 'six painted cells, six tile textures');
  assert.equal(atlas.source.listeners, 1 + 6, 'each tile listens to the shared source');

  // What the floor does on teardown: the Application destroys the sprites
  // (texture: false), then the scene lets go of its tiles.
  map.getContainer().destroy({ children: true });
  map.releaseTextures();
  assert.ok(tiles.every((t) => t.destroyed), 'a tile survived the release');
  assert.equal(atlas.destroyed, false, 'the release destroyed the atlas');
  assert.equal(atlas.source.listeners, 1, 'listeners left on the atlas after the release');

  // A second build on the SAME atlas starts clean — this is the rebuild case.
  const again = new TiledMapRenderer(MAP, [atlas]);
  assert.equal(atlas.source.listeners, 1 + 6);
  again.releaseTextures();
  again.releaseTextures(); // idempotent: nothing is destroyed twice
  assert.equal(atlas.source.listeners, 1);
}));

test('the scene\'s one release path covers the desk screens\' glyphs too', () => withPixi((pixi) => {
  // A real map renderer, real desk screens built on it exactly as the floor
  // builds them (their constructor calls textureForGid), and the one call the
  // floor makes on teardown: mapRenderer.releaseTextures(). The screens'
  // own destroy() is NOT on that path — the floor never calls it on teardown,
  // only when an agent is removed mid-scene — so the glyphs have to come out
  // with the tiles.
  const { TiledMapRenderer } = loadTs.fresh('src/renderer/src/scene/office/TiledMapRenderer.ts');
  const { DeskScreen } = loadTs.fresh('src/renderer/src/scene/office/DeskScreen.ts');
  const atlas = new pixi.module.Texture();
  const map = new TiledMapRenderer(MAP, [atlas]);
  const tiles = pixi.made.length - 1;
  assert.equal(atlas.source.listeners, 1 + tiles);

  const monitor = { onGids: [[7, 0, 0], [8, 1, 0], [9, 0, 1]] };
  const screens = [
    new DeskScreen(map, { x: 0, y: 0 }, monitor),
    new DeskScreen(map, { x: 2, y: 0 }, monitor)
  ];
  const glyphs = pixi.made.slice(1 + tiles);
  assert.equal(glyphs.length, 6, 'three glyphs per screen, two screens');
  assert.equal(atlas.source.listeners, 1 + tiles + 6, 'each glyph listens to the shared atlas');
  // A screen's sprites are destroyed with the Application's stage (texture:
  // false) — the glyph textures must survive that, they are not the sprite's.
  for (const s of screens) s.container.destroy({ children: true });
  assert.ok(glyphs.every((t) => !t.destroyed), 'destroying the sprites destroyed the shared glyphs');

  // Teardown: the one call.
  map.releaseTextures();
  assert.ok(glyphs.every((t) => t.destroyed), 'a glyph survived the scene');
  assert.equal(atlas.destroyed, false);
  assert.equal(atlas.source.listeners, 1, 'listeners left on the atlas after the release');

  // An agent removed mid-scene: its screen's destroy() takes the sprites and
  // leaves the glyphs to the scene — never a double destroy at teardown.
  const again = new TiledMapRenderer(MAP, [atlas]);
  const removed = new DeskScreen(again, { x: 0, y: 0 }, monitor);
  removed.destroy();
  assert.equal(atlas.source.listeners, 1 + tiles + 3, 'destroy() of a screen must not touch the glyphs');
  again.releaseTextures();
  assert.equal(atlas.source.listeners, 1);
}));

test('an atlas is loaded once per process and a failed load is not remembered', async () => {
  await withPixi(async (pixi) => {
    const images = [];
    const hadImage = 'Image' in globalThis;
    const previousImage = globalThis.Image;
    globalThis.Image = class {
      constructor() { images.push(this); }
      set src(url) {
        this._src = url;
        queueMicrotask(() => (url.includes('missing') ? this.onerror() : this.onload()));
      }
    };
    try {
      const { loadTexture, cachedTextureCount } = loadTs.fresh('src/renderer/src/scene/office/textureCache.ts');
      const a = await loadTexture('data:image/png;base64,AAAA');
      const b = await loadTexture('data:image/png;base64,AAAA');
      assert.equal(a, b, 'the same URL loaded twice');
      assert.equal(images.length, 1, 'one URL, one Image');
      assert.equal(a.source.scaleMode, 'nearest', 'pixel art must stay crisp');
      assert.equal(pixi.made.length, 1, 'one URL, one Texture');

      await loadTexture('tiles/other.png');
      assert.equal(images.length, 2);
      assert.equal(cachedTextureCount(), 2);

      await assert.rejects(loadTexture('tiles/missing.png'), /failed to load/);
      assert.equal(cachedTextureCount(), 2, 'a failed load was cached');
      await assert.rejects(loadTexture('tiles/missing.png'));
      assert.equal(images.length, 4, 'the retry did not try again');
    } finally {
      if (hadImage) globalThis.Image = previousImage; else delete globalThis.Image;
    }
  });
});

test('the floor loads its atlases through the cache and releases its tiles on teardown', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/scene/office/OfficeFloor.tsx'), 'utf8');
  assert.match(src, /import \{ loadTexture \} from '\.\/textureCache';/);
  assert.doesNotMatch(src, /Texture\.from\(/, 'the floor registers atlases in the global cache again');
  assert.match(src, /__releaseTextures = \(\) => mapRenderer\.releaseTextures\(\);/);
  const cleanup = src.slice(src.indexOf('safeDestroy(a);'), src.indexOf('appRef.current = null;'));
  assert.match(cleanup, /__releaseTextures\?\.\(\)/, 'teardown never releases the tiles');
});
