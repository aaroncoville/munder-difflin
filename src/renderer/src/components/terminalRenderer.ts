/**
 * Which painter a terminal gets: xterm's WebGL addon or its DOM renderer.
 *
 * The pool leases a WebGL renderer for every on-screen terminal (see
 * leaseWebglRenderer in terminalPool.ts) because it keeps VT323's uneven glyphs
 * on a fixed cell grid. That is a win only when a GPU does the painting. On a
 * machine with no usable GPU — WSL2/WSLg, a VM, a headless box — Chromium
 * still hands out WebGL contexts, but backs them with SwiftShader (or Mesa's
 * llvmpipe), a software rasterizer running in the GPU process. Every terminal
 * then costs CPU cores of continuous rasterisation just to sit there, where the
 * DOM renderer costs almost nothing. Measured on WSLg: ~3.6 cores in the GPU
 * process for a floor of idle terminals.
 *
 * So the lease is now a decision with three inputs: the user's setting
 * (`terminalRenderer` in config: 'auto' | 'dom' | 'webgl'), a one-time probe of
 * what WebGL is actually backed by, and the Arabic switch, which terminalPool
 * still checks on its own because it wants the DOM renderer for a different
 * reason (bidi, not speed).
 *
 * The pure parts — `classifyWebglRenderer` and `shouldLeaseWebgl` — have no DOM
 * dependency so node:test can exercise them (test/terminal-renderer.test.cjs).
 * Only `probeWebglRenderer` touches the document, and only when called.
 */

/** The user's setting. 'auto' is the default: WebGL on a real GPU, DOM otherwise. */
export type TerminalRendererPref = 'auto' | 'dom' | 'webgl';

/** What the probe found behind WebGL. 'unknown' is the honest answer when the
 *  debug extension is unavailable, and it is treated as hardware so that the
 *  behaviour on a Mac — where the extension may be masked — is unchanged. */
export type WebglClassification = 'hardware' | 'software' | 'unknown';

/** Renderer strings that mean "a CPU is pretending to be a GPU". SwiftShader is
 *  Chromium's own fallback (what WSLg gets); llvmpipe/softpipe are Mesa's; the
 *  rest cover the generic spellings ANGLE and Mesa use for offscreen/software
 *  backends. Hardware strings name a vendor part (NVIDIA, AMD, Intel, Apple M*,
 *  Adreno, Mali) and never match. */
export const SOFTWARE_WEBGL_RE = /swiftshader|llvmpipe|softpipe|software|mesa offscreen/i;

/** Classify an UNMASKED_RENDERER_WEBGL string. `null` (extension unavailable,
 *  or no WebGL at all) is 'unknown', never 'software': without evidence we keep
 *  today's behaviour. */
export function classifyWebglRenderer(rendererString: string | null): WebglClassification {
  if (rendererString == null) return 'unknown';
  const s = rendererString.trim();
  if (!s) return 'unknown';
  return SOFTWARE_WEBGL_RE.test(s) ? 'software' : 'hardware';
}

/** The decision. 'webgl' and 'dom' are the user overriding the probe in either
 *  direction; 'auto' skips the lease only on a POSITIVE software finding. */
export function shouldLeaseWebgl(
  pref: TerminalRendererPref | undefined,
  classification: WebglClassification
): boolean {
  switch (pref) {
    case 'dom': return false;
    case 'webgl': return true;
    case 'auto':
    default:
      return classification !== 'software';
  }
}

export interface WebglProbeResult {
  classification: WebglClassification;
  /** UNMASKED_RENDERER_WEBGL, or null when it could not be read. */
  renderer: string | null;
  /** UNMASKED_VENDOR_WEBGL, or null when it could not be read. */
  vendor: string | null;
}

/** The debug extension's constants (WEBGL_debug_renderer_info). Spelled out so
 *  the probe does not depend on the extension object's shape beyond these. */
const UNMASKED_VENDOR_WEBGL = 0x9245;
const UNMASKED_RENDERER_WEBGL = 0x9246;

/** Ask the browser what backs WebGL, on a throwaway canvas. Never throws: a
 *  browser with no WebGL, or one that masks the renderer, yields 'unknown'.
 *  The probe context is released straight away so it never counts against
 *  Chromium's live-context cap that leaseWebglRenderer is so careful about. */
export function probeWebglRenderer(): WebglProbeResult {
  let renderer: string | null = null;
  let vendor: string | null = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = (canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl')) as
      WebGLRenderingContext | null;
    if (gl) {
      try {
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        if (info) {
          const r = gl.getParameter(UNMASKED_RENDERER_WEBGL);
          const v = gl.getParameter(UNMASKED_VENDOR_WEBGL);
          renderer = typeof r === 'string' ? r : null;
          vendor = typeof v === 'string' ? v : null;
        }
        // Chromium unmasks RENDERER itself in recent versions; take that when the
        // extension is gone but the plain parameter still names the backend.
        if (renderer == null) {
          const r = gl.getParameter(gl.RENDERER);
          if (typeof r === 'string' && SOFTWARE_WEBGL_RE.test(r)) renderer = r;
        }
      } finally {
        try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
      }
    }
  } catch { /* no DOM, or WebGL is disabled — 'unknown' is the right answer */ }
  return { classification: classifyWebglRenderer(renderer), renderer, vendor };
}

let probed: WebglProbeResult | null = null;

/** The probe result, taken once per renderer process and cached. What backs
 *  WebGL does not change while the process lives, and the probe is not free. */
export function webglRendererInfo(): WebglProbeResult {
  if (!probed) probed = probeWebglRenderer();
  return probed;
}

/** The user's setting, mirrored from config by App.tsx (initial load and every
 *  config:changed). A module variable rather than a store read because the
 *  lease decision runs synchronously on attach, which can happen before the
 *  first config read resolves; until then 'auto' is the right default. */
let pref: TerminalRendererPref = 'auto';

export function getTerminalRendererPref(): TerminalRendererPref {
  return pref;
}

/** Record the setting. Returns true when it changed, so the caller can tell the
 *  open terminals (see notifyTerminalRendererChangeAll in terminalPool). */
export function setTerminalRendererPref(next: TerminalRendererPref | undefined): boolean {
  const normalized: TerminalRendererPref =
    next === 'dom' || next === 'webgl' || next === 'auto' ? next : 'auto';
  if (normalized === pref) return false;
  pref = normalized;
  return true;
}

let skipLogged = false;

/** The call site's one question: lease WebGL for this terminal now? Logs the
 *  software-GPU skip once per process, with the renderer string, so the reason a
 *  floor is on the DOM renderer is in the console rather than a mystery. */
export function wantsWebglRenderer(): boolean {
  const info = webglRendererInfo();
  const lease = shouldLeaseWebgl(pref, info.classification);
  if (!lease && pref === 'auto' && !skipLogged) {
    skipLogged = true;
    console.info(`[terminal] webgl renderer skipped: software GPU (${info.renderer ?? 'unknown'}) — using DOM renderer`);
  }
  return lease;
}
