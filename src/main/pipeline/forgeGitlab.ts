/**
 * The GitLab side of the pipeline (spec 12.4; steel-thread ST-6): read an MR, count
 * a branch's open MRs, and merge at a sha.
 *
 * Every call is `glab api` through execFile with an argument array and no shell.
 * glab authenticates with its own keyring login, so no token is ever on an
 * argument list, in a URL, or in this process's logs.
 *
 * The merge passes `sha`, so GitLab itself refuses if the head moved between the
 * conductor's probe and the call. The conductor never arms auto-merge.
 */
import { execFile } from 'node:child_process';
import { accessSync, constants, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ForgeMr } from './stage';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as { parseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } };

export interface RunResult { code: number; stdout: string; stderr: string }
/** Runs a program with arguments and no shell. Injected so tests can answer as GitLab did. */
export type Runner = (file: string, args: string[]) => Promise<RunResult>;

/**
 * Where git and glab are looked for, in order. PATH is never consulted. A package
 * manager's install comes before /usr/bin, whose git on macOS is a shim that starts
 * xcrun on every call.
 */
export const SYSTEM_TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

/** [p] with links resolved in its longest existing part; the part that does not exist yet is kept as given. */
function resolveExisting(p: string): string {
  let head = resolve(p);
  const rest: string[] = [];
  for (;;) {
    try { return join(realpathSync(head), ...rest); } catch { /* not there yet: go up */ }
    const up = dirname(head);
    if (up === head) return resolve(p);
    rest.unshift(basename(head));
    head = up;
  }
}

/** True when [path] is [root] or inside it, both compared after resolving links (also for a path not made yet). */
export function isUnder(path: string, root: string): boolean {
  const rel = relative(resolveExisting(root), resolveExisting(path));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The absolute path of the program [name] in the first of [dirs] that has it, after
 * resolving links, or null. Relative folders are skipped, a name with a path in it is
 * refused, and a program that is (or links to) anything under [forbidden] is refused:
 * the app never runs a file an agent could have put there.
 */
export function resolveTool(name: string, dirs: string[] = SYSTEM_TOOL_DIRS, forbidden: string[] = []): string | null {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  for (const dir of dirs) {
    if (!isAbsolute(dir)) continue;
    const candidate = join(dir, name);
    let real: string;
    try { real = realpathSync(candidate); accessSync(real, constants.X_OK); } catch { continue; }
    if (forbidden.some((f) => isUnder(real, f) || isUnder(candidate, f))) continue;
    return real;
  }
  return null;
}

/**
 * The environment git and glab run with: the app's, less every GIT_ variable, and with
 * no user or system git config, no prompts and no colour. A GIT_DIR, a
 * GIT_CONFIG_PARAMETERS or a config file's core.fsmonitor could otherwise point git at
 * another repository or make it run a program.
 */
export function toolEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('GIT_')) env[k] = v;
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GLAB_NO_PROMPT: '1', NO_COLOR: '1' };
}

/** A runner that finds each program with [resolveTool] (never PATH) and runs it with [toolEnv]. */
export function makeRunner(forbidden: string[] = [], dirs: string[] = SYSTEM_TOOL_DIRS): Runner {
  return (name, args) =>
    new Promise((resolve) => {
      const file = resolveTool(name, dirs, forbidden);
      if (!file) { resolve({ code: 127, stdout: '', stderr: `${name}: not found in ${dirs.join(', ')}` }); return; }
      execFile(file, args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000, env: toolEnv() },
        (err, stdout, stderr) => {
          const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
          resolve({ code, stdout: String(stdout), stderr: String(stderr) });
        });
    });
}

export const execRunner: Runner = makeRunner();

/** [obj]'s own field [key], never one inherited from a prototype. */
export function own(obj: unknown, key: string): unknown {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
}

export type MergeOutcome =
  | { ok: true; mergeCommit: string }
  | { ok: false; status: string; error: string };

const SHA_RE = /^[0-9a-f]{40}$/;

export class GitlabForge {
  private readonly project: string;

  constructor(project: string, private readonly run: Runner = execRunner) {
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(project)) throw new Error(`not a GitLab project path: ${project}`);
    this.project = encodeURIComponent(project);
  }

  /** The MR as the forge sees it now, or null when it cannot be read. */
  async mr(iid: number): Promise<ForgeMr | null> {
    const r = await this.api(['api', `projects/${this.project}/merge_requests/${iid}`]);
    if (!r) return null;
    return toForgeMr(r);
  }

  /** How many open MRs have [branch] as their source. */
  async openMrsForBranch(branch: string): Promise<number | null> {
    const r = await this.api(['api', `projects/${this.project}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`]);
    return Array.isArray(r) ? r.length : null;
  }

  /**
   * PUT .../merge with sha=S. GitLab answers 200 with the merge commit, or refuses:
   * 409 when the sha no longer matches the head, 405 or 422 when it is not mergeable.
   */
  async merge(iid: number, sha: string): Promise<MergeOutcome> {
    if (!SHA_RE.test(sha)) return { ok: false, status: 'bad-sha', error: 'the sha is not a full 40-hex sha' };
    const res = await this.run('glab', ['api', '--method', 'PUT', `projects/${this.project}/merge_requests/${iid}/merge`, '--raw-field', `sha=${sha}`]);
    const body = parse(res.stdout);
    const mc = own(body, 'merge_commit_sha');
    if (res.code === 0 && typeof mc === 'string' && SHA_RE.test(mc)) return { ok: true, mergeCommit: mc };
    const status = /HTTP (\d{3})/.exec(`${res.stderr} ${res.stdout}`)?.[1] ?? 'error';
    const msg = own(body, 'message');
    const message = typeof msg === 'string' ? msg : '';
    return { ok: false, status, error: (message || res.stderr || res.stdout).trim().slice(0, 300) };
  }

  private async api(args: string[]): Promise<unknown> {
    const res = await this.run('glab', args);
    if (res.code !== 0) return null;
    return parse(res.stdout);
  }
}

/** A strict parse: a name given twice, or anything not JSON, is no answer (null). */
function parse(text: string): unknown {
  const r = core.parseJson(text);
  return r.ok ? r.value : null;
}

/** GitLab's MR JSON to the fields the stage machine reads. Anything malformed reads as unknown (null). */
export function toForgeMr(raw: unknown): ForgeMr | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const state = own(raw, 'state');
  const head = own(raw, 'sha');
  const source = own(raw, 'source_branch');
  const target = own(raw, 'target_branch');
  if (state !== 'opened' && state !== 'merged' && state !== 'closed' && state !== 'locked') return null;
  if (typeof head !== 'string' || !SHA_RE.test(head)) return null;
  if (typeof source !== 'string' || typeof target !== 'string') return null;
  const hp = own(raw, 'head_pipeline');
  const [pid, psha, pstatus] = [own(hp, 'id'), own(hp, 'sha'), own(hp, 'status')];
  const pipeline = typeof pid === 'number' && typeof psha === 'string' && SHA_RE.test(psha) && typeof pstatus === 'string'
    ? { id: pid, sha: psha, status: pstatus }
    : null;
  const mc = own(raw, 'merge_commit_sha');
  return {
    state,
    draft: own(raw, 'draft') === true || own(raw, 'work_in_progress') === true,
    head,
    source,
    target,
    pipeline,
    mergeCommit: typeof mc === 'string' && SHA_RE.test(mc) ? mc : null,
  };
}
