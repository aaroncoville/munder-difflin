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
 *  - only project-independent settings load (--setting-sources user), as for a scoped interactive seat. Claude still
 *    merges the owner's managed and user settings into the session, so, as for a scoped interactive seat, the launch is
 *    refused when they add a write root outside the seat's roots (claudeSettingsAdmission.ts), or when where the CLI
 *    will read them cannot be told from the child's environment;
 *  - the settings carry the agent's enabledPlugins map, which switches off every plugin the owner has not kept for
 *    agents. Without it the owner's user-level plugins would all load, with their hooks (which run as their own
 *    processes, outside the Bash sandbox), MCP servers and skills, so a launch without the map is refused.
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
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { CLAUDE_CONFIG_KEEP } from './claudeEnv';
import { claudeSettingsExcess, MANAGED_CLAUDE_SETTINGS } from './claudeSettingsAdmission';
import { hookCommandFor, overlaps, rootOverlap, verifyHookRuntime, type StagedHookRuntime } from './hookRuntime';
import { CLAUDE_USER_SOURCES, isPlainObject, launchPlaces } from './launchLine';
import { privateDirsReach } from './privateDirs';
import { writeSeatSettings } from './seatSettings';
import { ownFolder, seatWriteRoots } from './writeRoots';

/** Backend switches on the shared keep-list that a headless seat does not pass. Each needs its provider's own
 *  credentials and region variables (AWS_*, ANTHROPIC_VERTEX_PROJECT_ID, CLOUD_ML_REGION, ...), which the allowlist
 *  does not carry, so passing the switch alone could only turn a working launch into one that fails at sign-in. */
const HEADLESS_UNSUPPORTED_BACKENDS: ReadonlySet<string> = new Set(['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX']);

/** Variables passed from the parent environment when present: the user's identity, shell, locale and temp folder,
 *  and the operator's Claude configuration and credentials. Nothing else passes. */
export const HEADLESS_PARENT_ENV: readonly string[] = [
  'HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
  ...[...CLAUDE_CONFIG_KEEP].filter((k) => !HEADLESS_UNSUPPORTED_BACKENDS.has(k)), 'ANTHROPIC_API_KEY',
];

/** The seat's own hive values a caller may set (the same names the app gives an interactive seat). */
export const HEADLESS_SEAT_ENV: readonly string[] = [
  'AGENT_ID', 'AGENT_NAME', 'AGENT_DIR', 'HIVE_ROOT', 'HIVE_SOCK', 'HIVE_SPAWN_TOKEN', 'HIVE_SCOPED_ROOTS', 'HIVE_MEMORY_AGENT', 'HIVE_NODE',
];

/** The --permission-mode values a headless seat may run with. bypassPermissions is left out: the edit tools are held
 *  to the seat roots (permissions.additionalDirectories) by the permission layer, not by the Bash sandbox, and that
 *  mode lets them write anywhere without asking. In a -p run nobody can answer a prompt, so the other modes refuse
 *  such a write instead. */
export const HEADLESS_PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'dontAsk'];

/** The default bound on each of the CLI's stdout and stderr, in bytes. The JSON result of one turn is far smaller; a
 *  stream past this is a CLI gone wrong, and keeping all of it would grow the app's memory without limit. */
export const HEADLESS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

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
  /** The agent's plugin map, the same one an interactive seat's settings carry: every plugin the owner has, each on
   *  only when it is kept for agents. Required. */
  enabledPlugins: Record<string, boolean>;
  model?: string;
  /** Passed to --max-budget-usd. */
  maxBudgetUsd?: number;
  /** Passed to --permission-mode; one of HEADLESS_PERMISSION_MODES. */
  permissionMode?: string;
  /** The seat's own hive values (names on HEADLESS_SEAT_ENV only). */
  seatEnv?: Record<string, string>;
  /** The environment the allowlist is taken from; defaults to process.env. */
  parentEnv?: Record<string, string | undefined>;
  /** The CLI to run; defaults to `claude` on PATH. */
  cliPath?: string;
  spawn?: SpawnLike;
  /** The machine-wide Claude settings file the owner's roots are read from; defaults to the platform's. */
  managedSettingsFile?: string;
  /** The bound on each of stdout and stderr, in bytes (default HEADLESS_MAX_OUTPUT_BYTES). Past it the CLI is killed
   *  and the run fails. */
  maxOutputBytes?: number;
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

export type HeadlessOutcome = 'success' | 'budget-stop' | 'failed';

/** The result subtype the CLI gives a run stopped by --max-budget-usd. */
export const BUDGET_STOP_SUBTYPE = 'error_max_budget_usd';

export interface HeadlessRun {
  /** True only when the CLI exited 0 and its last line is a well-formed result object with is_error false and subtype
   *  success. */
  ok: boolean;
  /** success when ok; budget-stop when the result's subtype is error_max_budget_usd, whatever is_error and the exit
   *  code say; failed otherwise. */
  outcome: HeadlessOutcome;
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

/** The generated settings: scoped sandbox roots, failing closed, the gate hook at PreToolUse, and the agent's plugin
 *  map, which outranks the owner's user-level enabledPlugins for this session. */
export function headlessSeatSettings(roots: string[], hookCommand: string, enabledPlugins: Record<string, boolean>): Record<string, unknown> {
  return {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: roots } },
    permissions: { additionalDirectories: roots },
    hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: hookCommand, onFailure: 'block' }] }] },
    enabledPlugins: { ...enabledPlugins },
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
  // --model takes the next argument whatever it is; a value that starts with a dash would hide an option in it.
  if (o.model !== undefined && (typeof o.model !== 'string' || o.model.startsWith('-'))) {
    throw new HeadlessSeatRefused('the model is not text or starts with "-", which the CLI would read as an option');
  }
  if (o.permissionMode !== undefined && !HEADLESS_PERMISSION_MODES.includes(o.permissionMode)) {
    throw new HeadlessSeatRefused(`the permission mode is not one of ${HEADLESS_PERMISSION_MODES.join(', ')}`);
  }
  if (o.maxBudgetUsd !== undefined && !(typeof o.maxBudgetUsd === 'number' && Number.isFinite(o.maxBudgetUsd) && o.maxBudgetUsd > 0)) {
    throw new HeadlessSeatRefused('the budget is not a positive number of dollars');
  }
  if (!isPlainObject(o.enabledPlugins) || !Object.values(o.enabledPlugins).every((v) => typeof v === 'boolean')) {
    throw new HeadlessSeatRefused('no plugin map (enabledPlugins) was given, so every plugin the owner enabled would load');
  }
  if (o.maxOutputBytes !== undefined && !(Number.isSafeInteger(o.maxOutputBytes) && o.maxOutputBytes > 0)) {
    throw new HeadlessSeatRefused('the output bound is not a positive whole number of bytes');
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
  // The owner's managed and user settings are merged into the session: every write root they add must be inside the
  // seat's roots (or a temp folder the CLI's sandbox grants anyway), read where the child's environment points the CLI.
  const places = launchPlaces('claude', env, homedir());
  if ('unknown' in places) throw new HeadlessSeatRefused(`where Claude will read the owner's settings cannot be told: ${places.unknown}`);
  const excess = claudeSettingsExcess({
    managedFile: o.managedSettingsFile ?? MANAGED_CLAUDE_SETTINGS, userDir: places.claudeUserDir,
    allowed: [...roots, ...places.tmpDirs], cwd: o.cwd, home: places.home,
  });
  if (excess) throw new HeadlessSeatRefused(`the owner's ${excess.why} adds a write root outside the seat's roots${excess.root ? `: ${excess.root}` : ''}`);
  const settings = headlessSeatSettings(roots, hookCommandFor(o.hookRuntime, true), o.enabledPlugins);
  // Its own file name, so it never replaces the settings of the same agent's interactive seat.
  const settingsFile = writeSeatSettings(o.settingsDir, o.hiveRoot, `headless:${o.agentId}`, JSON.stringify(settings, null, 2));
  const argv = [o.cliPath ?? 'claude', '-p', '--output-format', 'json', '--settings', settingsFile, '--setting-sources', CLAUDE_USER_SOURCES];
  if (o.model) argv.push('--model', o.model);
  if (o.maxBudgetUsd !== undefined) argv.push('--max-budget-usd', String(o.maxBudgetUsd));
  if (o.permissionMode !== undefined) argv.push('--permission-mode', o.permissionMode);
  argv.push(o.prompt);
  return { argv, env, cwd: o.cwd, settingsFile, roots };
}

/** The CLI's result object: the last non-empty line of stdout, when it is a JSON object of type "result". Earlier
 *  lines (a warning printed first) are ignored; anything after the result means the output did not end as a finished
 *  run's does, so there is no result. */
export function parseHeadlessOutput(stdout: string): { result: Record<string, unknown> | null } {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { result: null };
  let v: unknown;
  try { v = JSON.parse(lines[lines.length - 1]); } catch { return { result: null }; }
  return { result: isPlainObject(v) && v.type === 'result' ? v : null };
}

/** What is wrong with a result object's shape, or null when it has the fields a run is judged on: subtype (text),
 *  is_error (a boolean), session_id (text), and on a success the result text. */
export function headlessResultProblem(r: Record<string, unknown>): string | null {
  if (typeof r.subtype !== 'string') return 'subtype is not text';
  if (typeof r.is_error !== 'boolean') return 'is_error is not a boolean';
  if (typeof r.session_id !== 'string') return 'session_id is not text';
  if (r.subtype === 'success' && typeof r.result !== 'string') return 'a success has no result text';
  return null;
}

const text = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** Build the launch, run the CLI to completion and read its result. Resolves (never rejects) once the CLI has
 *  exited or could not be started; a refused launch throws before anything runs. A CLI whose stdout or stderr passes
 *  the output bound is killed, and the run fails saying so. */
export function runHeadlessSeat(o: HeadlessSeatOptions): Promise<HeadlessRun> {
  const launch = buildHeadlessLaunch(o);
  const spawn = o.spawn ?? nodeSpawn;
  return new Promise<HeadlessRun>((resolveRun) => {
    const limit = o.maxOutputBytes ?? HEADLESS_MAX_OUTPUT_BYTES;
    const out = { stdout: '', stderr: '' };
    const bytes = { stdout: 0, stderr: 0 };
    let overflow: string | null = null;
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      const { stdout, stderr } = out;
      const r = spawnError || overflow ? null : parseHeadlessOutput(stdout).result;
      const cost = r && typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
      const subtype = r ? text(r.subtype) : null;
      const problem = r ? headlessResultProblem(r) : null;
      const budgetStop = subtype === BUDGET_STOP_SUBTYPE;
      let error = spawnError ?? overflow;
      if (!error && !r) error = 'the CLI\'s output does not end with a JSON result object';
      else if (!error && problem) error = `the CLI's result is malformed: ${problem}`;
      else if (!error && budgetStop) error = 'the CLI stopped at its budget';
      else if (!error && exitCode !== 0) error = `the CLI exited with ${exitCode === null ? `signal ${signal}` : `code ${exitCode}`}`;
      else if (!error && r?.is_error !== false) error = 'the CLI\'s result is an error';
      else if (!error && subtype !== 'success') error = `the CLI's result is ${subtype}, not success`;
      const ok = error === null;
      resolveRun({
        ok, outcome: ok ? 'success' : budgetStop ? 'budget-stop' : 'failed',
        exitCode, signal, result: r ? text(r.result) : null, sessionId: r ? text(r.session_id) : null, totalCostUsd: cost,
        subtype, error, stdout, stderr,
        argv: launch.argv, cwd: launch.cwd, settingsFile: launch.settingsFile, outputFile: o.outputFile ?? null,
      });
    };
    let child: ChildProcess;
    try {
      child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { finish(null, null, (e as Error).message); return; }
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const take = (stream: 'stdout' | 'stderr', d: string): void => {
      if (overflow) return;
      const n = Buffer.byteLength(d, 'utf8');
      if (bytes[stream] + n > limit) {
        overflow = `the CLI's ${stream} passed the output bound of ${limit} bytes, so it was killed`;
        try { child.kill('SIGKILL'); } catch { /* it has already gone */ }
        return;
      }
      bytes[stream] += n;
      out[stream] += d;
    };
    child.stdout?.on('data', (d: string) => take('stdout', d));
    child.stderr?.on('data', (d: string) => take('stderr', d));
    child.on('error', (e) => finish(null, null, e.message));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}
