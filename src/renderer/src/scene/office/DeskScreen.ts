import { Container, Graphics, Sprite } from 'pixi.js';
import type { TiledMapRenderer } from './TiledMapRenderer';
import type { MonitorConfig } from './themeRegistry';
import { BEAT_S, advanceAmbientClock, ambientClock, ambientFrame, STILL_FRAME } from './ambientBeat';

// The office tileset ships every desk PC twice: a dark, switched-off monitor
// (gids 365/366 + 381/382 — what the map paints) and the SAME monitor with a
// lit blue desktop (367/368 + 383/384). DeskScreen overlays the lit variant on
// a desk's monitor block while its agent is seated, plus a tiny screen-life
// animation (scrolling lines + a blinking cursor) so the PC visibly works when
// its owner does. Hidden, the map's off art shows through — no state to undo.

/** gid of the OFF monitor block's top-left tile, as painted in the office map.
 *  Default for the office theme; a theme supplies its own via MonitorConfig. */
export const MONITOR_OFF_TOPLEFT_GID = 365;
/** Matching ON tiles for the office theme, laid out 2×2 directly right of the
 *  off block — used when no per-theme MonitorConfig is passed. */
const DEFAULT_ON_GIDS: ReadonlyArray<readonly [number, number, number]> = [
  // [gid, dx, dy] in tiles relative to the block's top-left
  [367, 0, 0], [368, 1, 0],
  [383, 0, 1], [384, 1, 1]
];

/** Screen interior of the 2×2 (32×32px) block, in local pixels — where the
 *  blue desktop is drawn in the tile art. The animation stays inside it. */
const SCREEN = { x: 3, y: 5, w: 25, h: 12 };

/** The screen-life animation steps on the floor's shared 4 Hz beat
 *  (ambientBeat.ts). It was drawn afresh every tick, which on the reduced path
 *  (renderOnChange.ts) meant a Graphics redraw — a change to render — fifteen
 *  times a second per lit monitor, for lines that only move a pixel ~3 times
 *  a second and a cursor that blinks twice. Stepping the clock at 4 Hz loses
 *  nothing visible (Math.round already stepped the lines at ~3 Hz) and,
 *  because the beat is shared, every monitor on the floor redraws on the same
 *  ticks: at most four draws a second for all of them together, rather than
 *  fifteen for any one.
 *
 *  And only while the owner is working. The animation is there so the PC
 *  visibly works when its owner does; an agent parked at the desk between
 *  tasks — the god running the floor, a worker waiting on a reply — got the
 *  same four redraws a second for a monitor nobody was typing at, which on a
 *  software GPU is four full rasterisations of the floor. Still, the screen
 *  stays lit and shows the animation's first frame, drawn once. */
export const SCREEN_BEAT_S = BEAT_S;

export class DeskScreen {
  /** Advance the shared animation clock. The floor calls this once per tick,
   *  before it updates any screen. */
  static advance(dt: number): void {
    advanceAmbientClock(dt);
  }
  /** For tests: the shared clock, in seconds. */
  static get clock(): number { return ambientClock(); }

  readonly container = new Container();
  private anim = new Graphics();
  private on = false;
  /** The shared clock when the screen lit, so each monitor keeps its own
   *  phase (the moment its owner sat down), as it did with a private clock. */
  private onAt = 0;
  private drawnBeat = -1;

  constructor(mapRenderer: TiledMapRenderer, topLeft: { x: number; y: number }, monitor?: MonitorConfig) {
    const ts = mapRenderer.tileSize;
    const onGids = monitor?.onGids ?? DEFAULT_ON_GIDS;
    for (const [gid, dx, dy] of onGids) {
      const tex = mapRenderer.textureForGid(gid);
      if (!tex) continue;
      const s = new Sprite(tex);
      s.x = dx * ts;
      s.y = dy * ts;
      this.container.addChild(s);
    }
    this.anim.eventMode = 'none';
    this.container.addChild(this.anim);
    this.container.x = topLeft.x * ts;
    this.container.y = topLeft.y * ts;
    // Sort with the characters: the block's bottom edge sits above the seated
    // agent's anchor row, so the avatar's head draws over the keyboard, not
    // under it — same painter's order the map art implies.
    this.container.zIndex = (topLeft.y + 2) * ts - 1;
    this.container.visible = false;
    this.container.eventMode = 'none';
  }

  /** Light the screen (agent sat down) or cut it (stood up / left). */
  setOn(on: boolean): void {
    if (on === this.on) return;
    this.on = on;
    this.container.visible = on;
    if (on) { this.onAt = ambientClock(); this.drawnBeat = -1; }
    else this.anim.clear();
  }

  /** Redraw the screen-life frame if the shared beat moved since the last
   *  one. Between beats the Graphics is left alone, so nothing is queued.
   *  `animate` false (the owner is seated but not working) draws the first
   *  frame once and then leaves the Graphics alone until it is true again. */
  update(animate = true): void {
    if (!this.on) return;
    const beat = ambientFrame(animate);
    if (beat === this.drawnBeat) return;
    this.drawnBeat = beat;
    const t = beat === STILL_FRAME ? 0 : Math.max(0, beat * SCREEN_BEAT_S - this.onAt);
    const g = this.anim;
    g.clear();
    // Two faint "output" lines scrolling up the desktop, wrapping around —
    // the eternal build log — plus a cursor blinking in the lower left.
    for (let i = 0; i < 2; i++) {
      const phase = (t * 3.2 + i * (SCREEN.h / 2)) % SCREEN.h;
      const y = SCREEN.y + SCREEN.h - 1 - phase;
      const w = 6 + ((i * 7 + Math.floor(t / 1.7)) % 9);
      g.rect(SCREEN.x + 2, Math.round(y), w, 1).fill({ color: 0xcfe6ff, alpha: 0.55 });
    }
    if (Math.floor(t / 0.53) % 2 === 0) {
      g.rect(SCREEN.x + 2, SCREEN.y + SCREEN.h - 2, 2, 2).fill({ color: 0xffffff, alpha: 0.9 });
    }
  }

  /** Sprites only. The glyph textures belong to the TiledMapRenderer that cut
   *  them and go with the scene (releaseTextures). */
  destroy(): void {
    this.container.destroy({ children: true });
  }
}
