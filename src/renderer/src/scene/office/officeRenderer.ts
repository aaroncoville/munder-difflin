/**
 * Which Pixi renderer the floor asks for.
 *
 * Throttling the floor (officeMotion.ts: 15 fps, 1x) cut the work per second
 * but not where the work is done. On a machine where Chromium backs WebGL
 * with SwiftShader there is no display compositor work left on the GPU
 * process — it is already software — yet the process still ran at 2.6–4.5
 * cores on WSLg with the throttled floor up, all of it SwiftShader worker
 * threads servicing the floor's draw calls: every sprite is still a GL draw
 * rasterised by a CPU pretending to be a GPU, through a mailbox round-trip to
 * another process. A probe put a single rotating triangle at 60 fps through
 * that path at ~0.8 cores, so a few hundred sprites at 15 fps account for the
 * rest.
 *
 * Pixi 8.18 ships a Canvas2D renderer (`autoDetectRenderer` with
 * `preference: 'canvas'`). Canvas2D on a software GPU is Skia rasterising on
 * the renderer's own thread: no GL, no GPU-process worker threads, no WebGL
 * context to be evicted when the terminals open theirs (glRecovery.ts). So on
 * the reduced path the floor asks for the canvas renderer and keeps WebGL
 * otherwise, where a real GPU does the work nearly for free.
 *
 * The choice is made once per build, when `Application.init` creates the
 * renderer; a mode change applied live (createOfficeMotionGate) changes the
 * frame cap and resolution of the renderer that exists, and the kind only on
 * the next rebuild. On the machines this is for — software GPU — 'auto' lands
 * on the reduced path from the first build, so that is the common case.
 *
 * Everything the office draws has a Canvas2D path in this Pixi: sprites cut
 * from an atlas (drawImage with the frame, `scaleMode: 'nearest'` honoured as
 * imageSmoothingEnabled = false), Text (CanvasTextPipe), Graphics
 * (CanvasGraphicsAdaptor), tint (a tinted copy per texture, cached), blend
 * modes ('add' → 'lighter'; the exotic ones fall back to source-over with one
 * warning) and the per-sprite Graphics crop mask (CanvasStencilMaskPipe clips
 * to a Graphics' fill paths; rectangles and circles are supported, inverse
 * masks are not and the floor has none). Nothing needed replacing.
 */
import type { WebglClassification } from '@/components/terminalRenderer';
import type { OfficeMotionMode } from './officeMotion';

/** The two renderers the floor chooses between. WebGPU is never asked for:
 *  a software GPU has none, and a hardware one is well served by WebGL. */
export type PixiRendererPreference = 'webgl' | 'canvas';

export interface RendererChoice {
  preference: PixiRendererPreference;
  /** Why, in a few words, for the init log line. */
  reason: string;
}

/** Canvas on a software GPU, whatever the setting — there is no hardware to
 *  force 'full' onto, and 'full' still lifts the frame cap and resolution.
 *  Canvas on the reduced path too (the setting, or the OS asking for reduced
 *  motion): at 15 fps and 1x Canvas2D is cheap on any machine. WebGL for a
 *  real GPU on the full path. 'unknown' counts as hardware, as everywhere. */
export function chooseRenderer(
  mode: OfficeMotionMode,
  classification: WebglClassification
): RendererChoice {
  if (classification === 'software') return { preference: 'canvas', reason: 'software GPU' };
  if (mode === 'reduced') return { preference: 'canvas', reason: 'reduced motion' };
  return {
    preference: 'webgl',
    reason: classification === 'hardware' ? 'hardware GPU' : 'GPU unknown, assumed hardware'
  };
}

/** The one line a scene logs when its renderer is up:
 *  `[office] pixi renderer: canvas (reduced, software GPU)`. Names the renderer
 *  Pixi actually built; when that is not the one asked for (Pixi fell through
 *  its preference list) the line says so, since that is the first thing to
 *  know when a floor is slower than expected. */
export function describeRendererChoice(
  scene: string,
  actual: string,
  mode: OfficeMotionMode,
  choice: RendererChoice
): string {
  const fallback = actual === choice.preference ? '' : `; asked for ${choice.preference}`;
  return `[${scene}] pixi renderer: ${actual} (${mode}, ${choice.reason}${fallback})`;
}
