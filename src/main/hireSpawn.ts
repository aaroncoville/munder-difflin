/**
 * Spawning an ephemeral god-hired worker AS A HIRE — i.e. instantiating one of
 * the shipped hire manifests instead of a roleless ad-hoc agent.
 *
 * A spawn-request may name a hire by ID (`"hire": "dwight-qa"`); this module
 * turns that id into a validated `HireManifest` plus a "plan" describing what
 * the spawn is allowed to apply. Pure except for the one file read, and free of
 * any `electron` import, so it unit-tests as a plain Node module (same approach
 * as hire.ts / workerLaunch.ts).
 *
 * SECURITY MODEL — a spawn-request is NOT human consent.
 *
 *  - ID, NEVER A PATH. The manifest spec already commits to "references into
 *    curated allowlists, never raw values" for skills / mcpServers / commandFlags;
 *    a path field in an LLM-authored queue file would re-open "point the loader at
 *    any JSON on disk". The id charset excludes path separators and `..`, and the
 *    resolved path is asserted to be inside the hires directory anyway.
 *  - MCP CONSENT GATE. The manifest spec pre-fills safe-readonly servers but
 *    surfaces write/secret ones for HUMAN consent at import; they are never
 *    auto-enabled. god authoring a spawn-request is not that human, so this module
 *    derives the enable-set by re-checking each id's catalog TIER itself (it does
 *    not trust the validator's `consentRequired` list) and drops write/secret ids
 *    into `mcpSkipped`. The merge helper re-checks the tier a SECOND time before
 *    writing `enabled: true`, so no caller can arm a keyed server through this path.
 *    A human's explicit `enabled:false` is likewise never overridden by a manifest.
 *  - commandFlags stay behind the existing SAFE_FLAG_NAMES allowlist: they can only
 *    reach here through `validateHireManifest`, which rejects the whole manifest on
 *    an unsafe flag.
 */
import { isAbsolute, join, resolve, sep } from 'node:path';
import { readHireManifestFile } from './hire';
import { isSafeReadonlyMcp } from '../shared/mcpCatalog';
import type { HireManifest } from '../shared/hire';

/** Hire ids as they appear on disk (`dwight-qa` → `dwight-qa.hire.json`). Letters,
 *  digits and `. _ -` only: no `/`, no `\`, no whitespace, and (below) no `..`. */
const HIRE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/;

/** The filename suffix every shipped manifest uses. Accepted on input too, so
 *  `"hire": "dwight-qa.hire.json"` and `"hire": "dwight-qa"` both resolve. */
const HIRE_SUFFIX = '.hire.json';

/** What a spawn is allowed to apply from a manifest. `mcpEnable` is already
 *  tier-filtered; `mcpSkipped` is what was withheld pending human consent. */
export interface HirePlan {
  manifest: HireManifest;
  /** Catalog ids safe to auto-enable for this worker (safe-readonly tier only). */
  mcpEnable: string[];
  /** Write/secret catalog ids the manifest asked for and we deliberately did NOT
   *  enable — a spawn-request is not human consent. Reported, never armed. */
  mcpSkipped: string[];
}

export type HirePlanResult = { ok: true; plan: HirePlan } | { ok: false; error: string };

/** Resolve a hire id to its manifest path inside `dir`. Rejects anything that
 *  isn't a bare id, and (belt and braces) anything that escapes `dir`. */
export function resolveHireManifestPath(dir: string, hire: string): { ok: true; path: string } | { ok: false; error: string } {
  const raw = typeof hire === 'string' ? hire.trim() : '';
  if (!raw) return { ok: false, error: '"hire" must be a non-empty hire id' };
  const id = raw.toLowerCase().endsWith(HIRE_SUFFIX) ? raw.slice(0, -HIRE_SUFFIX.length) : raw;
  if (!HIRE_ID_RE.test(id) || id.includes('..')) {
    return { ok: false, error: `"hire" must be a bare hire id like "dwight-qa" (got ${JSON.stringify(raw)}) — paths are not accepted` };
  }
  if (!dir || !isAbsolute(dir)) return { ok: false, error: 'hire manifests directory is not configured' };
  const path = join(dir, `${id}${HIRE_SUFFIX}`);
  // The regex already forbids separators, so this can only fail if `dir` itself is
  // odd — keep it anyway: it is the invariant that actually matters.
  const root = resolve(dir);
  if (!resolve(path).startsWith(root + sep)) {
    return { ok: false, error: `"hire" resolves outside the hires directory` };
  }
  return { ok: true, path };
}

/**
 * Split a validated manifest's `mcpServers` into what a spawn-request may
 * auto-enable and what it must withhold. The tier is re-derived from the catalog
 * here rather than taken from the validator's `consentRequired`, so this decision
 * never depends on a caller passing the right list along.
 */
export function planHireMcp(manifest: HireManifest): { mcpEnable: string[]; mcpSkipped: string[] } {
  const mcpEnable: string[] = [];
  const mcpSkipped: string[] = [];
  for (const id of manifest.mcpServers ?? []) {
    if (isSafeReadonlyMcp(id)) mcpEnable.push(id);
    else mcpSkipped.push(id); // write/secret — human consent only, never a spawn-request
  }
  return { mcpEnable, mcpSkipped };
}

/**
 * Load + validate the manifest named by a spawn-request's `hire` field and build
 * its plan. An invalid or unknown manifest returns `ok:false` — the caller must
 * reject the spawn rather than falling back to a roleless worker, so a typo'd
 * hire id can never silently produce an agent with no role.
 */
export function loadHirePlan(dir: string, hire: string): HirePlanResult {
  const path = resolveHireManifestPath(dir, hire);
  if (!path.ok) return path;
  const read = readHireManifestFile(path.path);
  if (!read.ok) {
    // Never leak the absolute path (logs/Slack) — the id is the useful half.
    return { ok: false, error: `hire "${hire}": ${read.error.split(path.path).join(`${hire}${HIRE_SUFFIX}`)}` };
  }
  return { ok: true, plan: { manifest: read.manifest, ...planHireMcp(read.manifest) } };
}

/**
 * Merge a hire's auto-enable ids over the live global consent map for ONE spawn.
 *
 * Second gate: every id is tier-checked AGAIN here, so even an id that reached
 * this function some other way can never arm a write/secret server. An explicit
 * human decision in `base` wins — `enabled:false` stays false (a manifest may not
 * re-enable something the human switched off), and an already-true entry is left
 * exactly as the human set it.
 */
export function mergeHireMcpDefaults(
  base: { [id: string]: { enabled: boolean } } | undefined,
  enableIds: readonly string[]
): { [id: string]: { enabled: boolean } } | undefined {
  const safe = enableIds.filter((id) => isSafeReadonlyMcp(id));
  if (safe.length === 0) return base;
  const out: { [id: string]: { enabled: boolean } } = { ...(base ?? {}) };
  for (const id of safe) {
    if (out[id] !== undefined) continue; // an explicit human choice (either way) stands
    out[id] = { enabled: true };
  }
  return out;
}
