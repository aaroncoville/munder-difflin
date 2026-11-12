/**
 * The merge-request pipeline's operator configuration (spec 9 and 11).
 *
 * It is read from the app's own config file (HarnessConfig.mrPipeline), which
 * agents cannot write, and normalized here. The pipeline is inert unless
 * `enabled` is literally true, and it never merges by itself unless `autoMerge`
 * is literally true: with it off, a card that is ready waits at `mergeable` and
 * god is told the sha.
 *
 * A repo entry that does not hold up is dropped rather than half-used. Some
 * values cannot be configured into the spec's anti-goals: fewer than two vendors
 * (a merge on one vendor's review), or a credential carried in a remote URL.
 */

export type Vendor = 'anthropic' | 'openai';
export const VENDORS: readonly Vendor[] = ['anthropic', 'openai'];

export interface LiveProbeConfig {
  kind: 'http-json';
  url: string;
  /** The JSON field holding the deployed commit. */
  field: string;
}

export interface RepoPipeline {
  forge: 'gitlab';
  /** The forge's path for the project, e.g. "wooden-bird/wayfarer". */
  project: string;
  /** The https clone URL the conductor's mirror fetches from. Never carries a credential. */
  remote: string;
  /** The branch MRs merge into. */
  target: string;
  live: LiveProbeConfig;
  /** Reviewer agent names per vendor, in order of preference (7.1). */
  panel: Record<Vendor, string[]>;
  minVendors: number;
  maxRounds: number;
  /** Globs: a diff touching any of these waits for the owner (section 9). */
  humanOnlyPaths: string[];
  /** Globs: a single-vendor merge here needs the owner (7.4). */
  sensitivePaths: string[];
}

export interface PipelineSettings {
  enabled: boolean;
  autoMerge: boolean;
  /** Seconds between conductor ticks. */
  tickSec: number;
  /** The steel thread's one fixed deadline per stage, after which it raises STALLED. */
  stageDeadlineMin: number;
  repos: Record<string, RepoPipeline>;
}

/**
 * Wayfarer, the pilot. The human-only paths are its CI definition, CI scripts,
 * deploy configuration and Dockerfiles as they are named in the repo: the Fly
 * configs live in deploy/fly/, so the spec's suggested `**\/fly*.toml` would not
 * have matched them.
 */
export const WAYFARER: RepoPipeline = deepFreeze({
  forge: 'gitlab',
  project: 'wooden-bird/wayfarer',
  remote: 'https://gitlab.com/wooden-bird/wayfarer.git',
  target: 'main',
  live: { kind: 'http-json', url: 'https://wayfarer-home.fly.dev/api/version', field: 'commit' },
  panel: { anthropic: ['orsolina'], openai: ['jannings', 'tryphon'] },
  minVendors: 2,
  maxRounds: 3,
  humanOnlyPaths: ['.gitlab-ci.yml', 'scripts/ci/**', 'deploy/**', '**/Dockerfile*'],
  // Migrations, the auth package, and the authorization and session code that lives outside it:
  // domain/Visibility.kt, and the session, sign-in, OAuth and PIN-reset routes and repositories.
  sensitivePaths: [
    'api/src/main/resources/db/migration/**', '**/auth/**', 'api/src/main/kotlin/io/wayfarer/domain/Visibility.kt',
    '**/*Auth*.kt', '**/*Session*.kt', '**/*PinReset*.kt',
  ],
});

/** Freezes [o] and everything in it, so a default handed out by reference cannot be changed by whoever holds it. */
function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** An https URL with no user, password, query or fragment: nowhere a credential could ride. */
function cleanHttps(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' || u.username !== '' || u.password !== '') return null;
    if (u.search !== '' || u.hash !== '' || /[?#]/.test(v)) return null;
    return v;
  } catch {
    return null;
  }
}

/** A list of non-empty globs, or null: a missing or malformed list drops the repo (the guards fail closed). */
const globs = (v: unknown): string[] | null =>
  Array.isArray(v) && v.every((g) => typeof g === 'string' && g.length > 0) ? [...(v as string[])] : null;

function repoEntry(raw: unknown): RepoPipeline | null {
  if (!isObject(raw)) return null;
  if (raw.forge !== 'gitlab') return null;
  if (typeof raw.project !== 'string' || !/^[\w.-]+(\/[\w.-]+)+$/.test(raw.project)) return null;
  const remote = cleanHttps(raw.remote);
  if (!remote) return null;
  if (typeof raw.target !== 'string' || raw.target === '') return null;
  const live = isObject(raw.live) ? raw.live : null;
  const liveUrl = live ? cleanHttps(live.url) : null;
  if (!live || live.kind !== 'http-json' || !liveUrl || typeof live.field !== 'string' || live.field === '') return null;
  if (!isObject(raw.panel)) return null;
  const panel = {} as Record<Vendor, string[]>;
  for (const vendor of VENDORS) {
    const list = raw.panel[vendor];
    if (!Array.isArray(list) || list.length === 0 || !list.every((n) => typeof n === 'string' && NAME_RE.test(n))) return null;
    panel[vendor] = [...(list as string[])];
  }
  // One agent cannot sit for two vendors.
  const seated = VENDORS.flatMap((v) => panel[v]);
  if (new Set(seated).size !== seated.length) return null;
  const humanOnlyPaths = globs(raw.humanOnlyPaths);
  const sensitivePaths = globs(raw.sensitivePaths);
  if (!humanOnlyPaths || !sensitivePaths) return null;
  const int = (v: unknown, d: number) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : d);
  return {
    forge: 'gitlab', project: raw.project, remote, target: raw.target,
    live: { kind: 'http-json', url: liveUrl, field: live.field },
    panel,
    // Never fewer than two: the conductor does not merge on one vendor's review.
    minVendors: Math.max(2, int(raw.minVendors, 2)),
    maxRounds: int(raw.maxRounds, 3),
    humanOnlyPaths,
    sensitivePaths,
  };
}

/** Reads HarnessConfig.mrPipeline into settings the conductor can trust. */
export function pipelineSettings(raw: unknown): PipelineSettings {
  const r = isObject(raw) ? raw : {};
  const repos: Record<string, RepoPipeline> = {};
  if (isObject(r.repos)) {
    for (const [id, entry] of Object.entries(r.repos)) {
      const repo = NAME_RE.test(id) ? repoEntry(entry) : null;
      if (repo) repos[id] = repo;
    }
  } else {
    repos.wayfarer = WAYFARER;
  }
  const minutes = (v: unknown, d: number, lo: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo ? v : d);
  return {
    enabled: r.enabled === true,
    autoMerge: r.autoMerge === true,
    tickSec: minutes(r.tickSec, 30, 5),
    stageDeadlineMin: minutes(r.stageDeadlineMin, 60, 5),
    repos,
  };
}

/** Matches a repo path against globs: `**` crosses directories, `*` stays within one, everything else is literal. */
export function matchesAny(path: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegExp(p).test(path));
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      // "**/" matches any number of whole directories, including none.
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') {
      re += '[^/]*';
    } else {
      re += ch.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}
