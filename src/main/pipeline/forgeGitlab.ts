/**
 * The GitLab side of the pipeline (spec 12.4; steel-thread ST-6): read an MR, count
 * a branch's open MRs, and merge at a sha.
 *
 * Every call is `glab api --hostname <host>` through execFile with an argument array,
 * no shell, and `/` as its working folder (so glab's `:placeholders` never come from
 * a repository the app happens to be in). glab authenticates with its own login, so no
 * token is ever on an argument list, in a URL, or in this process's logs.
 *
 * The merge passes `sha`, so GitLab itself refuses if the head moved between the
 * conductor's probe and the call. The conductor never arms auto-merge.
 *
 * How programs are chosen. git and glab are found only in SYSTEM_TOOL_DIRS, never
 * through the app's PATH, and never at, or through a link to, anything under a
 * forbidden folder (the hive root and agents' folders). They run with PATH set to
 * those same folders, so a program git or glab starts by name (a credential helper,
 * git started by glab) is found there too, and with every git variable and glab
 * host or config redirection removed from the environment.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ForgeMr } from './stage';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as { parseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } };

export interface RunResult { code: number; stdout: string; stderr: string }
export interface RunOptions { cwd: string }
/** Runs a program with arguments and no shell. Injected so tests can answer as GitLab did. */
export type Runner = (name: string, args: string[], opts?: RunOptions) => Promise<RunResult>;

/**
 * Where git and glab are looked for, in order. PATH is never consulted. A package
 * manager's install comes before /usr/bin, whose git on macOS is a shim that starts
 * xcrun on every call.
 */
export const SYSTEM_TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** [p] with links resolved in its longest existing part, in the disk's own case; the part not made yet is kept as given. */
function resolveExisting(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(head), ...rest); } catch { /* not there yet: go up */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    rest.unshift(basename(head));
    head = up;
  }
}

/** True when [path] is [root] or inside it, both compared after resolving links and case (also for a path not made yet). */
export function isUnder(path: string, root: string): boolean {
  const rel = relative(resolveExisting(root), resolveExisting(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** Throws unless [forbidden] is a list of absolute folders: the guard is never left off by default. */
export function requireForbidden(forbidden: unknown): string[] {
  if (!Array.isArray(forbidden) || !forbidden.every((f) => typeof f === 'string' && isAbsolute(f))) {
    throw new Error('a forbidden folder list (absolute paths; the hive root and agents\' folders) is required');
  }
  return forbidden;
}

/**
 * The absolute path of the program [name] in the first of [dirs] that has it, after
 * resolving links, or null. Relative folders are skipped, a name with a path in it is
 * refused, and a program that is (or links to) anything under [forbidden] is refused:
 * the app never runs a file an agent could have put there.
 */
export function resolveTool(name: string, dirs: string[], forbidden: string[]): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    let real: string;
    try { real = realpathSync.native(candidate); accessSync(real, constants.X_OK); } catch { continue; }
    if (forbidden.some((f) => isUnder(real, f) || isUnder(candidate, f))) continue;
    return real;
  }
  return null;
}

/** Environment names that point glab at another host or config folder. */
const GLAB_REDIRECTS = ['GITLAB_HOST', 'GITLAB_URI', 'GL_HOST', 'GLAB_CONFIG_DIR', 'XDG_CONFIG_HOME'];
/** Prefixes of variables that load a library into any program started (macOS and Linux). */
const LOADER_PREFIXES = ['DYLD_', 'LD_'];

/**
 * The environment git and glab run with: the app's, less every git variable (in any
 * case), every glab host or config redirection and every library-loader variable, with PATH set to the fixed tool
 * folders, no user or system git config, no prompts and no colour.
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    const up = k.toUpperCase();
    if (up.startsWith('GIT_') || up === 'PATH' || GLAB_REDIRECTS.includes(up) || LOADER_PREFIXES.some((p) => up.startsWith(p))) continue;
    env[k] = v;
  }
  return {
    ...env,
    PATH: [...SYSTEM_TOOL_DIRS, '/bin'].join(':'),
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_PROTOCOL_FROM_USER: '0',
    GLAB_NO_PROMPT: '1', NO_COLOR: '1',
  };
}

/**
 * The git credential helper for glab, naming glab by its absolute path so the shell
 * git runs it through looks nothing up. Null for a path that is not absolute or holds
 * a character that would need quoting.
 */
export function credentialHelper(glabPath: string): string | null {
  if (!isAbsolute(glabPath) || !/^[A-Za-z0-9._/+-]+$/.test(glabPath)) return null;
  return `!'${glabPath}' auth git-credential`;
}

/** A runner that finds each program with [resolveTool] (never PATH) and runs it with [toolEnv]. */
export function makeRunner(forbidden: string[], dirs: string[] = SYSTEM_TOOL_DIRS): Runner {
  requireForbidden(forbidden);
  return (name, args, opts) =>
    new Promise((done) => {
      const file = resolveTool(name, dirs, forbidden);
      if (!file) { done({ code: 127, stdout: '', stderr: `${name}: not found in ${dirs.join(', ')}` }); return; }
      execFile(file, args, { cwd: opts?.cwd ?? '/', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: toolEnv() },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
          done({ code, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

/** [obj]'s own field [key], never one inherited from a prototype. */
export function own(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

/**
 * A merge call's outcome. `refused`: GitLab answered with an HTTP error, so nothing
 * merged. `unknown`: anything else that is not a clear merge (a timeout, no status,
 * a success answer that does not say merged with a merge commit); the conductor must
 * read the MR again before deciding anything.
 */
export type MergeOutcome =
  | { ok: true; mergeCommit: string }
  | { ok: false; outcome: 'refused' | 'unknown'; status: string; error: string };

const SHA_RE = /^[0-9a-f]{40}$/;
const HOST_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const isIid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1;
/** A forge's message, cut short and with control characters removed, for a log line. */
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);

export class GitlabForge {
  private readonly host: string;
  private readonly project: string;
  private readonly run: Runner;

  constructor(opts: { host: string; project: string; forbidden: string[]; run?: Runner }) {
    const forbidden = requireForbidden(opts.forbidden);
    if (typeof opts.host !== 'string' || !HOST_RE.test(opts.host)) throw new Error(`not a GitLab host name: ${String(opts.host).slice(0, 80)}`);
    if (typeof opts.project !== 'string' || !/^[\w.-]+(\/[\w.-]+)+$/.test(opts.project)) throw new Error(`not a GitLab project path: ${String(opts.project).slice(0, 80)}`);
    this.host = opts.host;
    this.project = encodeURIComponent(opts.project);
    this.run = opts.run ?? makeRunner(forbidden);
  }

  /** The MR as the forge sees it now, or null when it cannot be read or [iid] is not an MR number. */
  async mr(iid: number): Promise<ForgeMr | null> {
    if (!isIid(iid)) return null;
    return toForgeMr(await this.api([`projects/${this.project}/merge_requests/${iid}`]));
  }

  /** How many open MRs have [branch] as their source, or null when unknown. */
  async openMrsForBranch(branch: string): Promise<number | null> {
    if (typeof branch !== 'string' || branch === '') return null;
    const r = await this.api([`projects/${this.project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`]);
    return Array.isArray(r) && r.every((m) => isIid(own(m, 'iid'))) ? r.length : null;
  }

  /**
   * PUT .../merge with sha=S. Merged only when GitLab answers with the MR merged and its
   * merge commit; an HTTP error is a refusal; anything else is unknown.
   */
  async merge(iid: number, sha: string): Promise<MergeOutcome> {
    if (!isIid(iid)) return { ok: false, outcome: 'refused', status: 'bad-iid', error: 'not an MR number' };
    if (typeof sha !== 'string' || !SHA_RE.test(sha)) return { ok: false, outcome: 'refused', status: 'bad-sha', error: 'the sha is not a full 40-hex sha' };
    const res = await this.run('glab', ['api', '--hostname', this.host, '--method', 'PUT', `projects/${this.project}/merge_requests/${iid}/merge`, '--raw-field', `sha=${sha}`], { cwd: '/' });
    const body = parse(res.stdout);
    const mc = own(body, 'merge_commit_sha');
    if (res.code === 0 && own(body, 'state') === 'merged' && typeof mc === 'string' && SHA_RE.test(mc)) return { ok: true, mergeCommit: mc };
    const http = /HTTP (\d{3})/.exec(`${res.stderr} ${res.stdout}`)?.[1];
    const msg = own(body, 'message');
    const error = printable(typeof msg === 'string' ? msg : res.stderr || res.stdout);
    if (res.code !== 0 && http && /^[45]/.test(http)) return { ok: false, outcome: 'refused', status: http, error };
    return { ok: false, outcome: 'unknown', status: http ?? (res.code === 0 ? 'unclear-answer' : 'no-answer'), error };
  }

  private async api(args: string[]): Promise<unknown> {
    const res = await this.run('glab', ['api', '--hostname', this.host, ...args], { cwd: '/' });
    if (res.code !== 0) return null;
    return parse(res.stdout);
  }
}

/** A strict parse: a name given twice, or anything not JSON, is no answer (null). */
function parse(text: string): unknown {
  const r = core.parseJson(text);
  return r.ok ? r.value : null;
}

/**
 * GitLab's MR JSON to the fields the stage machine reads. Each field is read from the
 * answer's own keys and checked; anything absent or of the wrong type makes the whole
 * MR unknown (null), never a default. The pipeline alone may be absent (null).
 */
export function toForgeMr(raw: unknown): ForgeMr | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const state = own(raw, 'state');
  const head = own(raw, 'sha');
  const source = own(raw, 'source_branch');
  const target = own(raw, 'target_branch');
  if (state !== 'opened' && state !== 'merged' && state !== 'closed' && state !== 'locked') return null;
  if (typeof head !== 'string' || !SHA_RE.test(head)) return null;
  if (typeof source !== 'string' || source === '' || typeof target !== 'string' || target === '') return null;
  // `draft` is current GitLab; `work_in_progress` is its older name. One must be stated.
  const d = own(raw, 'draft');
  const w = own(raw, 'work_in_progress');
  const draft = typeof d === 'boolean' ? d : typeof w === 'boolean' && d === undefined ? w : null;
  if (draft === null) return null;
  const hp = own(raw, 'head_pipeline');
  const [pid, psha, pstatus] = [own(hp, 'id'), own(hp, 'sha'), own(hp, 'status')];
  const pipeline = isIid(pid) && typeof psha === 'string' && SHA_RE.test(psha) && typeof pstatus === 'string' && pstatus !== ''
    ? { id: pid, sha: psha, status: pstatus }
    : null;
  const mc = own(raw, 'merge_commit_sha');
  return { state, draft, head, source, target, pipeline, mergeCommit: typeof mc === 'string' && SHA_RE.test(mc) ? mc : null };
}
