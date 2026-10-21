/**
 * The ASK ME board: the lilac board on the wall that shows how many tasks
 * are waiting on a question for the human (hive/tasks.json cards that are
 * blocked with an unanswered humanQA entry).
 *
 * While questions wait, the board's frame pulses for attention. That pulse
 * was redrawn every ticker tick — a Graphics rebuild, which is a change the
 * floor has to render (renderOnChange.ts) — and on a live floor there is
 * nearly always a question waiting, so the board alone held the floor at 15
 * renders a second with every avatar parked. Now the pulse steps on the
 * shared ambient beat (ambientBeat.ts) while the floor is active — someone is
 * working, so renders are happening anyway — and holds a steady attention
 * frame while nobody is, redrawn once when the count or the mode changes.
 */
import type { Graphics } from 'pixi.js';
import { STILL_FRAME, ambientBeatTime, ambientFrame } from './ambientBeat';

/** The pulse's alpha range around the board's frame while questions wait. */
export const ASK_PULSE_MIN_ALPHA = 0.35;
export const ASK_PULSE_ALPHA_RANGE = 0.3;
/** The frame while the pulse holds still: the pulse's midpoint. */
export const ASK_STEADY_ALPHA = ASK_PULSE_MIN_ALPHA + ASK_PULSE_ALPHA_RANGE / 2;

/** Which frame the board should show now. `floorActive` is whether any agent
 *  is actively working (Character.isActive). The board is redrawn only when
 *  this changes (or the count does): the beat while pulsing, STILL_FRAME while
 *  holding, and STILL_FRAME with no questions, where there is no pulse. */
export function askBoardFrame(askCount: number, floorActive: boolean): number {
  return ambientFrame(askCount > 0 && floorActive);
}

/** Paint the board for `askCount` waiting questions. `pulseT` is the time to
 *  draw the attention pulse for (ambientBeatTime), or null to hold the steady
 *  frame. The pulse's alpha is a function of `pulseT` alone, so a frame is a
 *  function of (askCount, pulseT). */
export function paintAskBoard(g: Graphics, askCount: number, pulseT: number | null): void {
  g.clear();
  // lilac-framed board with a big "?" identity
  g.rect(0, -8, 30, 22).fill(0x5b4a6b);
  g.rect(1, -7, 28, 3).fill(0xcdb4e8);
  g.rect(1, -4, 28, 17).fill(0xc9b083);
  if (askCount === 0) {
    // quiet: a faint "?" watermark
    g.rect(13, -1, 4, 2).fill({ color: 0x8a755f, alpha: 0.8 });
    g.rect(15, 1, 2, 4).fill({ color: 0x8a755f, alpha: 0.8 });
    g.rect(15, 7, 2, 2).fill({ color: 0x8a755f, alpha: 0.8 });
    return;
  }
  const n = Math.min(askCount, 8);
  for (let i = 0; i < n; i++) {
    const x = 3 + (i % 4) * 7;
    const y = -2 + Math.floor(i / 4) * 6;
    g.rect(x, y, 5, 4).fill(0xcdb4e8);
    g.rect(x + 2, y, 1, 1).fill(0x4a3b52);
  }
  // attention pulse around the frame while questions wait
  const a = pulseT === null
    ? ASK_STEADY_ALPHA
    : ASK_PULSE_MIN_ALPHA + ASK_PULSE_ALPHA_RANGE * (0.5 + 0.5 * Math.sin(pulseT * 4));
  g.rect(-2, -10, 34, 26).stroke({ color: 0xcdb4e8, width: 2, alpha: a });
}

export interface AskBoardOptions {
  /** The board's Graphics, already on the stage. */
  graphics: Graphics;
  /** Whether any agent is actively working right now (Character.isActive). */
  floorActive: () => boolean;
}

export interface AskBoard {
  /** How many questions the board shows. */
  readonly count: number;
  /** The ledger's new count. A change repaints at once, whatever the frame. */
  setCount(n: number): void;
  /** Called every tick: repaints only when the frame changes. */
  draw(): void;
}

/** The board's controller, as the floor drives it: `draw()` on every tick,
 *  `setCount()` from each ledger poll. Repaints only when the frame
 *  (askBoardFrame) or the count changes, so a waiting question costs one
 *  paint while nobody works and four a second while someone does. */
export function createAskBoard(opts: AskBoardOptions): AskBoard {
  let count = 0;
  // The frame last painted; NaN forces the next draw to paint.
  let painted = NaN;
  const draw = (): void => {
    const frame = askBoardFrame(count, opts.floorActive());
    if (frame === painted) return;
    painted = frame;
    paintAskBoard(opts.graphics, count, frame === STILL_FRAME ? null : ambientBeatTime());
  };
  draw();
  return {
    get count() { return count; },
    setCount(n) {
      if (n === count) return;
      count = n;
      painted = NaN;
      draw();
    },
    draw
  };
}

export { STILL_FRAME };
