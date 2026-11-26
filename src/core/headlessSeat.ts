/**
 * A headless Claude seat: one non-interactive `claude -p` turn for one stream, run without the app's terminals.
 *
 * The launch is built from the same pieces an interactive seat uses, so both are confined the same way:
 *  - the write roots are the scoped seat roots (writeRoots.ts seatWriteRoots), given to Claude's sandbox for Bash and
 *    as additional directories for the edit tools. The sandbox fails closed: it refuses to start where it is not
 *    available, and a command that fails inside it is never retried outside it;
 *  - the settings file is written from memory into a private folder outside the hive (seatSettings.ts), and the
 *    working folder may not reach that folder or the staged hook runtime (hookRuntime.ts);
 *  - the hive gate hook is registered at PreToolUse with "onFailure": "block", so Claude Code itself blocks the call
 *    when the hook shim cannot start, times out or exits with an unexpected code. The shim's own fail-closed path is
 *    a second layer, not a replacement;
 *  - only project-independent settings load (--setting-sources user), as for a scoped interactive seat.
 *
 * The child's environment is an allowlist, never the parent's environment minus a few names: a launcher that runs
 * inside the Electron process carries ELECTRON_RUN_AS_NODE, NODE_OPTIONS and the parent Claude session's markers,
 * none of which a seat should see. CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME=1 is always set, so resuming this session
 * with --resume or --continue never runs a tool call that a hook deferred: the call has to be made again and pass the
 * gate afresh.
 *
 * Output is read with --output-format json: one result object carrying the result text, the session id and
 * total_cost_usd. --max-budget-usd is passed through when asked for; deciding a cap is the caller's business.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { CLAUDE_CONFIG_KEEP } from './claudeEnv';
import { hookCommandFor, overlaps, rootOverlap, verifyHookRuntime, type StagedHookRuntime } from './hookRuntime';
import { CLAUDE_USER_SOURCES, isPlainObject } from './launchLine';
import { privateDirsReach } from './privateDirs';
import { writeSeatSettings } from './seatSettings';
import { ownFolder, seatWriteRoots } from './writeRoots';

/** Variables passed from the parent environment when present: the user's identity, shell, locale and temp folder,
 *  and the operator's Claude configuration and credentials. Nothing else passes. */
export const HEADLESS_PARENT_ENV: readonly string[] = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  ...CLAUDE_CONFIG_KEEP, 'ANTHROPIC_API_KEY',
];

/** The seat's own hive values a caller may set (the same names the app gives an interactive seat). */
export const HEADLESS_SEAT_ENV: readonly string[] = [
  'AGENT_ID', 'AGENT_NAME', 'AGENT_DIR', 'HIVE_ROOT', 'HIVE_SOCK', 'HIVE_SPAWN_TOKEN', 'HIVE_SCOPED_ROOTS', 'HIVE_MEMORY_AGENT', 'HIVE_NODE',
];

/** Set on every headless launch: a resumed session never runs a tool call a hook deferred. */
export const DEFERRED_RESUME_ENV = 'CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME';

export type SpawnLike = (file: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface HeadlessSeatOptions {
  /** The turn's prompt: the launch line's one positional, last. */
  prompt: string;
  /** The hive root folder. */
  hiveRoot: string;
  agentId: string;
  isGod?: boolean;
  /** The seat's working folder (absolute); granted as a root when it is outside the hive. */
  cwd: string;
  /** A private folder outside the hive where the settings file is written. */
  settingsDir: string;
  /** The staged hook runtime whose command is the gate hook. */
  hookRuntime: StagedHookRuntime;
  model?: string;
  /** Passed to --max-budget-usd. */
  maxBudgetUsd?: number;
  /** Passed to --permission-mode. */
  permissionMode?: string;
  /** The seat's own hive values (names on HEADLESS_SEAT_ENV only). */
  seatEnv?: Record<string, string>;
  /** The environment the allowlist is taken from; defaults to process.env. */
  parentEnv?: Record<string, string | undefined>;
  /** The CLI to run; defaults to `claude` on PATH. */
  cliPath?: string;
  spawn?: SpawnLike;
  /** The file the stream's brief says the run produces, returned with the result for a later done-check. */
  outputFile?: string;
}

export interface HeadlessLaunch {
  /** The CLI then its arguments. */
  argv: string[];
  env: Record<string, string>;
  cwd: string;
  settingsFile: string;
  roots: string[];
}

export interface HeadlessRun {
  /** True only when the CLI exited 0 with a result object that is not an error. */
  ok: boolean;
  exitCode: number | null;
  signal: string | null;
  result: string | null;
  sessionId: string | null;
  totalCostUsd: number | null;
  /** The result's subtype: success, error_max_turns, error_max_budget_usd, ... */
  subtype: string | null;
  /** Why the run is not ok when the CLI did not say: a spawn error, a non-zero exit, unreadable output. */
  error: string | null;
  stdout: string;
  stderr: string;
  argv: string[];
  cwd: string;
  settingsFile: string;
  outputFile: string | null;
}

/** Refuses a headless launch that cannot be confined or run as asked. */
export class HeadlessSeatRefused extends Error {
  constructor(reason: string) {
    super(`Headless seat refused: ${reason}`);
    this.name = 'HeadlessSeatRefused';
  }
}

/** The generated settings: scoped sandbox roots, failing closed, and the gate hook at PreToolUse. */
export function headlessSeatSettings(roots: string[], hookCommand: string): Record<string, unknown> {
  return {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: roots } },
    permissions: { additionalDirectories: roots },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, onFailure: 'block' }] }] },
  };
}

/** The child environment: the allowlisted parent variables that are present, the seat's own values, and the
 *  deferred-resume switch. */
export function headlessEnv(parentEnv: Record<string, string | undefined>, seatEnv: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of HEADLESS_PARENT_ENV) {
    const v = parentEnv[k];
    if (typeof v === 'string') env[k] = v;
  }
  for (const [k, v] of Object.entries(seatEnv)) {
    if (!HEADLESS_SEAT_ENV.includes(k)) throw new HeadlessSeatRefused(`${k} is not a seat variable a headless seat may be given`);
    if (typeof v !== 'string') throw new HeadlessSeatRefused(`${k} is not text`);
    env[k] = v;
  }
  env[DEFERRED_RESUME_ENV] = '1';
  return env;
}

/** Check the seat can be confined, write its settings file and return the launch line. Throws HeadlessSeatRefused
 *  (or the hook runtime's or seat settings' own refusal) instead of launching anything less confined. */
export function buildHeadlessLaunch(o: HeadlessSeatOptions): HeadlessLaunch {
  if (typeof o.prompt !== 'string' || !o.prompt.trim()) throw new HeadlessSeatRefused('the prompt is empty');
  // The prompt is the one positional; one that starts with a dash would be read as an option.
  if (o.prompt.startsWith('-')) throw new HeadlessSeatRefused('the prompt starts with "-", which the CLI would read as an option');
  if (o.maxBudgetUsd !== undefined && !(typeof o.maxBudgetUsd === 'number' && Number.isFinite(o.maxBudgetUsd) && o.maxBudgetUsd > 0)) {
    throw new HeadlessSeatRefused('the budget is not a positive number of dollars');
  }
  if (typeof o.cwd !== 'string' || !isAbsolute(o.cwd)) throw new HeadlessSeatRefused('the working folder is not an absolute path');
  const ctx = { root: o.hiveRoot, agentId: o.agentId, isGod: o.isGod === true, cwd: o.cwd };
  if (!ownFolder(ctx)) throw new HeadlessSeatRefused(`the agent folder for ${o.agentId} is missing or not a real folder`);
  const roots = seatWriteRoots(ctx);
  const reach = [...roots, o.cwd].map((path) => ({ path, from: 'the headless seat\'s roots' }));
  verifyHookRuntime(o.hookRuntime);
  const rt = rootOverlap(o.hookRuntime, reach);
  if (rt) throw new HeadlessSeatRefused(rt);
  for (const r of reach) {
    if (overlaps(o.settingsDir, r.path as string)) throw new HeadlessSeatRefused(`the agent may write the seat settings folder through ${r.path}`);
  }
  const priv = privateDirsReach(reach);
  if (priv) throw new HeadlessSeatRefused(priv);
  const env = headlessEnv(o.parentEnv ?? process.env, o.seatEnv);
  const settings = headlessSeatSettings(roots, hookCommandFor(o.hookRuntime, true));
  // Its own file name, so it never replaces the settings of the same agent's interactive seat.
  const settingsFile = writeSeatSettings(o.settingsDir, o.hiveRoot, `headless:${o.agentId}`, JSON.stringify(settings, null, 2));
  const argv = [o.cliPath ?? 'claude', '-p', '--output-format', 'json', '--settings', settingsFile, '--setting-sources', CLAUDE_USER_SOURCES];
  if (o.model) argv.push('--model', o.model);
  if (o.maxBudgetUsd !== undefined) argv.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.permissionMode) argv.push('--permission-mode', o.permissionMode);
  argv.push(o.prompt);
  return { argv, env, cwd: o.cwd, settingsFile, roots };
}

/** The CLI's result object: the last line of stdout that is a JSON object of type "result". */
export function parseHeadlessOutput(stdout: string): { result: Record<string, unknown> | null } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    let v: unknown;
    try { v = JSON.parse(lines[i]); } catch { continue; }
    if (isPlainObject(v) && v.type === 'result') return { result: v };
  }
  return { result: null };
}

const text = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** Build the launch, run the CLI to completion and read its result. Resolves (never rejects) once the CLI has
 *  exited or could not be started; a refused launch throws before anything runs. */
export function runHeadlessSeat(o: HeadlessSeatOptions): Promise<HeadlessRun> {
  const launch = buildHeadlessLaunch(o);
  const spawn = o.spawn ?? nodeSpawn;
  return new Promise<HeadlessRun>((resolveRun) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      const r = spawnError ? null : parseHeadlessOutput(stdout).result;
      const cost = r && typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
      const isError = r ? r.is_error === true : true;
      let error = spawnError;
      if (!error && !r) error = 'the CLI printed no JSON result object';
      else if (!error && exitCode !== 0) error = `the CLI exited with ${exitCode === null ? `signal ${signal}` : `code ${exitCode}`}`;
      resolveRun({
        ok: !spawnError && exitCode === 0 && r !== null && !isError,
        exitCode, signal, result: r ? text(r.result) : null, sessionId: r ? text(r.session_id) : null, totalCostUsd: cost,
        subtype: r ? text(r.subtype) : null, error, stdout, stderr,
        argv: launch.argv, cwd: launch.cwd, settingsFile: launch.settingsFile, outputFile: o.outputFile ?? null,
      });
    };
    let child: ChildProcess;
    try {
      child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish(null, null, (e as Error).message); return; }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { stdout += d; });
    child.stderr?.on('data', (d: string) => { stderr += d; });
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}
