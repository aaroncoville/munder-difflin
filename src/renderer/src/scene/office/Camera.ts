import { Container } from 'pixi.js';
import { effectiveFrames, smoothingFactor } from './frameRate';

// Simplified port of shahar061/the-office (office/engine/camera.ts).
// Phase targeting is dropped (we have no project phases); kept: fit-to-screen,
// map-edge clamping, smooth lerp, a manual focus(), and nudgeToward() used to
// pan toward the selected agent.

/** Per 60 Hz frame. Applied through smoothingFactor so a pan takes the same
 *  wall time whatever the ticker's rate (the reduced path runs it at 15). */
export const LERP_SPEED = 0.08;

/** How close the lerp has to get before it snaps to the target. An
 *  exponential lerp never arrives: after a pan it keeps writing the world's
 *  position by a millionth of a pixel a tick for seconds, invisible under
 *  roundPixels but a change the floor renders every tick (renderOnChange.ts).
 *  Below a thousandth of a pixel (a millionth in zoom) the next frame is the
 *  same pixels, so land there. */
export const SNAP_PX = 1e-3;
export const SNAP_ZOOM = 1e-6;

/** One lerp step toward `target`, landing exactly once within `snap`. */
function approach(current: number, target: number, k: number, snap: number): number {
  const d = target - current;
  return Math.abs(d) < snap ? target : current + d * k;
}

export class Camera {
  private container: Container;
  private currentX = 0;
  private currentY = 0;
  private currentZoom = 1;
  private targetX = 0;
  private targetY = 0;
  private targetZoom = 1;
  private viewWidth = 960;
  private viewHeight = 800;
  private mapWidth = 640;
  private mapHeight = 480;
  private manualOverride = false;

  private nudgeOffsetX = 0;
  private nudgeOffsetY = 0;
  private nudgeElapsed = 0;
  private nudgeDuration = 0;
  private readonly nudgeStrength = 0.4;

  constructor(container: Container) {
    this.container = container;
  }

  setMapSize(width: number, height: number): void {
    this.mapWidth = width;
    this.mapHeight = height;
  }

  setViewSize(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
    if (!this.manualOverride) this.fitToScreen();
  }

  private getMinZoom(): number {
    if (this.viewWidth === 0 || this.viewHeight === 0) return 1;
    return Math.min(this.viewWidth / this.mapWidth, this.viewHeight / this.mapHeight);
  }

  /** Fit the whole map to the viewport, centered. */
  fitToScreen(): void {
    this.manualOverride = false;
    this.targetX = this.mapWidth / 2;
    this.targetY = this.mapHeight / 2;
    this.targetZoom = this.getMinZoom();
  }

  /** Pan/zoom toward a world point (used when an agent is selected). */
  focusOn(worldX: number, worldY: number, zoom?: number): void {
    this.manualOverride = true;
    this.targetX = worldX;
    this.targetY = worldY;
    this.targetZoom = Math.max(this.getMinZoom(), Math.min(4, zoom ?? this.currentZoom));
  }

  /** A gentle, decaying pan toward a world point without taking manual control. */
  nudgeToward(worldX: number, worldY: number, duration = 1200): void {
    if (this.manualOverride) return;
    this.nudgeOffsetX = (worldX - this.targetX) * this.nudgeStrength;
    this.nudgeOffsetY = (worldY - this.targetY) * this.nudgeStrength;
    this.nudgeElapsed = 0;
    this.nudgeDuration = duration / 1000;
  }

  update(dt: number): void {
    const k = smoothingFactor(LERP_SPEED, dt);
    this.currentX = approach(this.currentX, this.targetX, k, SNAP_PX);
    this.currentY = approach(this.currentY, this.targetY, k, SNAP_PX);
    this.currentZoom = approach(this.currentZoom, this.targetZoom, k, SNAP_ZOOM);

    if (this.nudgeDuration > 0) {
      this.nudgeElapsed += dt;
      const t = Math.min(this.nudgeElapsed / this.nudgeDuration, 1);
      const ease = 1 - t;
      // The offset was tuned as a per-60Hz-frame push against the lerp above,
      // which eats part of every push before the next lands. Over a longer
      // tick, apply what that many per-frame pushes would have left standing
      // (effectiveFrames), so the nudge covers the same ground per second at
      // any ticker rate — and exactly today's at 60.
      const push = ease * effectiveFrames(LERP_SPEED, dt);
      this.currentX += this.nudgeOffsetX * push;
      this.currentY += this.nudgeOffsetY * push;
      if (t >= 1) {
        this.nudgeDuration = 0;
        this.nudgeOffsetX = 0;
        this.nudgeOffsetY = 0;
      }
    }

    // Clamp in locals and assign once. Pixi queues a container for the next
    // render on every write that changes a value, so writing the unclamped
    // position and then the clamped one marked the world changed on every
    // tick of a camera that had long settled (renderOnChange.ts).
    let x = this.viewWidth / 2 - this.currentX * this.currentZoom;
    let y = this.viewHeight / 2 - this.currentY * this.currentZoom;

    const scaledW = this.mapWidth * this.currentZoom;
    const scaledH = this.mapHeight * this.currentZoom;
    if (scaledW <= this.viewWidth) {
      x = (this.viewWidth - scaledW) / 2;
    } else {
      x = Math.min(0, Math.max(this.viewWidth - scaledW, x));
    }
    if (scaledH <= this.viewHeight) {
      y = (this.viewHeight - scaledH) / 2;
    } else {
      y = Math.min(0, Math.max(this.viewHeight - scaledH, y));
    }
    this.container.scale.set(this.currentZoom);
    this.container.x = x;
    this.container.y = y;
  }
}
