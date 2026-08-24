/** Highest accepted per-agent token ceiling across manifests and config IPC. */
export const MAX_AGENT_TOKEN_CAP = 10_000_000_000;

/** Config-level default worker cap, sanitised. Only a positive finite number is a
 *  cap; ANYTHING else — 0, negative, NaN, Infinity, a string from a hand-edited
 *  config.json — resolves to 0, which downstream means UNLIMITED (never throttle).
 *  0 is the deliberate escape hatch: running a worker uncapped stays available as
 *  an explicit decision. */
export function resolveDefaultWorkerTokenCap(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/** Effective TOTAL-token cap for one ephemeral worker. A worker's own positive cap
 *  always wins — the config default must never override a deliberate per-worker
 *  choice — otherwise the sanitised config default applies. 0 = unlimited. */
export function effectiveWorkerTokenCap(workerCap: unknown, configDefault: unknown): number {
  const own = resolveDefaultWorkerTokenCap(workerCap);
  return own > 0 ? own : resolveDefaultWorkerTokenCap(configDefault);
}
