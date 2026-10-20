import { Container } from 'pixi.js';
import { framesElapsed, smoothingFactor } from './frameRate';

// Simplified port of shahar061/the-office (office/engine/camera.ts).
// Phase targeting is dropped (we have no project phases); kept: fit-to-screen,
// map-edge clamping, smooth lerp, a manual focus(), and nudgeToward() used to
// pan toward the selected agent.

/** Per 60 Hz frame. Applied through smoothingFactor so a pan takes the same
 *  wall time whatever the ticker's rate (the reduced path runs it at 15). */
export const LERP_SPEED = 0.08;

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
    this.currentX += (this.targetX - this.currentX) * k;
    this.currentY += (this.targetY - this.currentY) * k;
    this.currentZoom += (this.targetZoom - this.currentZoom) * k;

    if (this.nudgeDuration > 0) {
      this.nudgeElapsed += dt;
      const t = Math.min(this.nudgeElapsed / this.nudgeDuration, 1);
      const ease = 1 - t;
      // The offset was tuned as a per-60Hz-frame push; scale it by the frames
      // this tick stands for so the nudge covers the same ground per second
      // at any ticker rate.
      const push = ease * framesElapsed(dt);
      this.currentX += this.nudgeOffsetX * push;
      this.currentY += this.nudgeOffsetY * push;
      if (t >= 1) {
        this.nudgeDuration = 0;
        this.nudgeOffsetX = 0;
        this.nudgeOffsetY = 0;
      }
    }

    this.container.scale.set(this.currentZoom);
    this.container.x = this.viewWidth / 2 - this.currentX * this.currentZoom;
    this.container.y = this.viewHeight / 2 - this.currentY * this.currentZoom;

    const scaledW = this.mapWidth * this.currentZoom;
    const scaledH = this.mapHeight * this.currentZoom;
    if (scaledW <= this.viewWidth) {
      this.container.x = (this.viewWidth - scaledW) / 2;
    } else {
      this.container.x = Math.min(0, Math.max(this.viewWidth - scaledW, this.container.x));
    }
    if (scaledH <= this.viewHeight) {
      this.container.y = (this.viewHeight - scaledH) / 2;
    } else {
      this.container.y = Math.min(0, Math.max(this.viewHeight - scaledH, this.container.y));
    }
  }
}
