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
 *  - none of the owner's settings files load (an empty --setting-sources: no user, project or local settings), so
 *    nothing in them can widen the seat, and the generated file is the session's only settings file besides managed
 *    settings. Managed settings cannot be left out and outrank the generated file, so the launch is refused when they
 *    widen the seat (claudeSettingsAdmission.ts), or when where the CLI looks cannot be told from the child's
 *    environment. Authentication does not come from a settings file and still works;
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
 *
 * The CLI is started as the leader of its own process group. A run that outlives its timeout gets SIGTERM, then
 * SIGKILL after a grace, sent to that group and to every subprocess of the CLI's: the CLI starts its Bash shell and its
 * hooks detached, each in a process group of its own, which a signal to the CLI's group does not reach. The
 * subprocesses are listed from the process table before each signal, and once more after the CLI exits, however it
 * exits; each is signalled with its group. What is seen only while the CLI ran (a subprocess is reparented once the
 * CLI exits) is recorded every few seconds and signalled after the exit only if the table still shows the same command
 * at that pid. A subprocess started and orphaned between two of those reads is not seen; when the table cannot be
 * read at all, the result says so (sweepError) rather than claiming everything was stopped. A run stopped by its
 * timeout has no result object, so its cost is unknown: totalCostUsd is null, not 0.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import { CLAUDE_CONFIG_KEEP } from './claudeEnv';
import { claudeSettingsExcess, MANAGED_CLAUDE_SETTINGS } from './claudeSettingsAdmission';
import { type ProcRow } from './heavyJob';
import { probeProcessGroups, type GroupProcRow } from './processGroups';
import { hookCommandFor, overlaps, rootOverlap, verifyHookRuntime, type StagedHookRuntime } from './hookRuntime';
import { CLAUDE_FILE_WRITE_TOOLS, isPlainObject, launchPlaces } from './launchLine';
import { privateDirsReach } from './privateDirs';
import { writeSeatSettings } from './seatSettings';
import { ownFolder, SCOPED_SANDBOX_PINS, seatWriteRoots } from './writeRoots';

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

/** The --permission-mode values a headless seat may run with, from the choices the CLI accepts (Claude Code 2.1.332:
 *  acceptEdits, auto, bypassPermissions, manual, dontAsk, plan). auto is left out: a classifier, not the permission
 *  rules, decides what runs. bypassPermissions is left out: the edit tools are held
 *  to the seat roots (permissions.additionalDirectories) by the permission layer, not by the Bash sandbox, and that
 *  mode lets them write anywhere without asking. In a -p run nobody can answer a prompt, so the other modes refuse
 *  such a write instead. */
export const HEADLESS_PERMISSION_MODES: readonly string[] = ['manual', 'acceptEdits', 'plan', 'dontAsk'];

/** The mode passed when the caller names none. A mode is always passed: without one the session would take the
 *  owner's permissions.defaultMode, which may be bypassPermissions. dontAsk refuses anything not already allowed,
 *  which is the right answer when nobody is there to be asked. */
export const HEADLESS_DEFAULT_PERMISSION_MODE = 'dontAsk';

/** The default bound on each of the CLI's stdout and stderr, in bytes. The JSON result of one turn is far smaller; a
 *  stream past this is a CLI gone wrong, and keeping all of it would grow the app's memory without limit. */
export const HEADLESS_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

/** The --setting-sources value of every headless launch: none, so no user, project or local settings file loads. */
export const HEADLESS_SETTING_SOURCES = '';

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
  /** True when the empty plugin map is meant: the owner has no plugins to list. An empty map without it is refused,
   *  since it cannot be told from a map nobody computed, and it would leave on any plugin that loads from outside
   *  the owner's settings files (an organisation's synced plugins, for one). */
  noPlugins?: boolean;
  model?: string;
  /** Passed to --max-budget-usd. */
  maxBudgetUsd?: number;
  /** Passed to --permission-mode; one of HEADLESS_PERMISSION_MODES. Defaults to HEADLESS_DEFAULT_PERMISSION_MODE. */
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
  /** Stop the run after this many milliseconds. No timeout when absent. */
  timeoutMs?: number;
  /** How long a timed-out run's process group has between SIGTERM and SIGKILL. Defaults to HEADLESS_KILL_GRACE_MS. */
  killGraceMs?: number;
  /** Reads the process table (pid, parent pid and, where there are groups, the process group of every process) for
   *  the subprocess sweep; defaults to `ps` (probeProcessGroups). */
  processTable?: () => Promise<GroupProcRow[]>;
  /** How often, while the CLI runs, its subprocesses are recorded for the sweep after it exits. Defaults to
   *  HEADLESS_PROCESS_POLL_MS. */
  processPollMs?: number;
  /** Called once, synchronously, as soon as the CLI has been started, before anything else is awaited: with its pid
   *  and the process group it leads (null where there are no process groups). For a caller that must be able to find
   *  the CLI again if the caller itself dies, since the CLI is detached and outlives it. An error it throws is
   *  ignored. */
  onSpawn?: (cli: { pid: number; pgid: number | null }) => void;
  /** Called once, synchronously, just before the CLI is started, with the settings file its launch line names (a
   *  path unique to the hive and the seat) and the whole launch line: for a caller that must record what to look for
   *  before the process exists, so that a crash between the start and onSpawn cannot leave it unfindable. When it
   *  throws, the CLI is not started and the run fails with that reason. */
  onLaunch?: (launch: { settingsFile: string; argv: readonly string[] }) => void;
}

/** The default time between SIGTERM and SIGKILL for a run that timed out. */
export const HEADLESS_KILL_GRACE_MS = 2000;

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
  /** True when the run was stopped because it outlived timeoutMs. */
  timedOut: boolean;
  /** The last signal sent to the run's process group: null when none was needed. */
  killSignal: 'SIGTERM' | 'SIGKILL' | null;
  /** When the CLI was started (epoch ms), so a check can tell what this run wrote from what was there before. */
  startedAt: number;
  /** How many of the CLI's subprocesses outside its own process group were signalled (each with its group). */
  swept: number;
  /** Why the subprocess sweep could not run, or ran on an incomplete picture: the process table could not be read.
   *  Null when every read succeeded. */
  sweepError: string | null;
}

/** Refuses a headless launch that cannot be confined or run as asked. */
export class HeadlessSeatRefused extends Error {
  constructor(reason: string) {
    super(`Headless seat refused: ${reason}`);
    this.name = 'HeadlessSeatRefused';
  }
}

/** Allow rules for each file-writing tool inside each root, and nowhere else. Under the default dontAsk mode a call
 *  nothing allows is refused, the file tools writing inside the seat's own roots included, so without these a
 *  headless seat cannot write its output file. `//` starts an absolute path in a rule. A root with a character a rule
 *  would read as a wildcard or as the rule's end is refused rather than allowed more widely than meant, and so is one
 *  with a character the app's own rule reader (editRuleFolder) does not understand: `$`, `%` or a backtick, read as a
 *  substitution, or a line break. */
export function headlessWriteRules(roots: string[]): string[] {
  for (const r of roots) {
    if (!isAbsolute(r) || /[*?[\]{}()\\$%`\n\r]/.test(r)) throw new HeadlessSeatRefused(`the seat root ${r} cannot be written as a permission rule`);
  }
  return CLAUDE_FILE_WRITE_TOOLS.flatMap((tool) => roots.map((r) => `${tool}(/${r}/**)`));
}

/** The generated settings: scoped sandbox roots, failing closed, the file tools allowed inside those roots, the gate
 *  hook at PreToolUse, and the agent's plugin map, which outranks the owner's user-level enabledPlugins for this
 *  session. */
export function headlessSeatSettings(roots: string[], hookCommand: string, enabledPlugins: Record<string, boolean>): Record<string, unknown> {
  return {
    sandbox: {
      enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { allowWrite: roots },
      autoAllowBashIfSandboxed: SCOPED_SANDBOX_PINS.autoAllowBashIfSandboxed, network: { allowLocalBinding: SCOPED_SANDBOX_PINS.allowLocalBinding },
    },
    permissions: { additionalDirectories: roots, allow: headlessWriteRules(roots) },
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
  if ((Object.keys(o.enabledPlugins).length === 0) !== (o.noPlugins === true)) {
    throw new HeadlessSeatRefused(o.noPlugins === true
      ? 'the plugin map names plugins although noPlugins says there are none'
      : 'the plugin map is empty; pass noPlugins: true when the owner has no plugins to list');
  }
  if (o.maxOutputBytes !== undefined && !(Number.isSafeInteger(o.maxOutputBytes) && o.maxOutputBytes > 0)) {
    throw new HeadlessSeatRefused('the output bound is not a positive whole number of bytes');
  }
  for (const [name, v] of [['timeout', o.timeoutMs], ['kill grace', o.killGraceMs]] as const) {
    if (v !== undefined && !(typeof v === 'number' && Number.isFinite(v) && v > 0)) throw new HeadlessSeatRefused(`the ${name} is not a positive number of milliseconds`);
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
  // Managed settings are merged into the session whatever the launch line says, so their sandbox and permissions are
  // judged as an allowlist: every key must be understood and none may widen the seat beyond its roots (or a temp
  // folder the CLI's sandbox grants anyway). User settings are not loaded at all.
  const places = launchPlaces('claude', env, homedir());
  if ('unknown' in places) throw new HeadlessSeatRefused(`where Claude will read its configuration cannot be told: ${places.unknown}`);
  const excess = claudeSettingsExcess({
    managedFile: o.managedSettingsFile ?? MANAGED_CLAUDE_SETTINGS, userDir: null,
    allowed: [...roots, ...places.tmpDirs], cwd: o.cwd, home: places.home, strict: true,
  });
  if (excess) throw new HeadlessSeatRefused(`the owner's ${excess.why} would widen the seat beyond its roots${excess.root ? `: ${excess.root}` : ''}`);
  const settings = headlessSeatSettings(roots, hookCommandFor(o.hookRuntime, true), o.enabledPlugins);
  // Its own file name, so it never replaces the settings of the same agent's interactive seat.
  const settingsFile = writeSeatSettings(o.settingsDir, o.hiveRoot, `headless:${o.agentId}`, JSON.stringify(settings, null, 2));
  const argv = [o.cliPath ?? 'claude', '-p', '--output-format', 'json', '--settings', settingsFile, '--setting-sources', HEADLESS_SETTING_SOURCES];
  // MCP servers are not settings: the owner's global config (~/.claude.json) and plugins declare them, and an empty
  // --setting-sources does not stop those. --strict-mcp-config with no --mcp-config starts none.
  argv.push('--strict-mcp-config');
  if (o.model) argv.push('--model', o.model);
  if (o.maxBudgetUsd !== undefined) argv.push('--max-budget-usd', String(o.maxBudgetUsd));
  argv.push('--permission-mode', o.permissionMode ?? HEADLESS_DEFAULT_PERMISSION_MODE);
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

/** Send `sig` to the process group led by `pid`; false when the group is already gone. Where there are no process
 *  groups (Windows), only the process itself is signalled. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals | 0): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    if (process.platform === 'win32') { if (sig !== 0) child.kill(sig); return sig === 0 ? child.exitCode === null : true; }
    process.kill(-pid, sig);
    return true;
  } catch { return false; }
}

/** How long output already written may take to arrive after the CLI has exited, before the pipes are closed. */
export const HEADLESS_DRAIN_MS = 250;

/** How often, while the CLI runs, its subprocesses are recorded for the sweep after it exits. */
export const HEADLESS_PROCESS_POLL_MS = 2000;

/** The longest one read of the process table may take before it is abandoned. */
export const PROCESS_TABLE_TIMEOUT_MS = 2000;

/** The pids below `root` in a process table, by parent pid. */
export function descendantsOf(rows: readonly ProcRow[], root: number): ProcRow[] {
  const children = new Map<number, ProcRow[]>();
  for (const r of rows) children.set(r.parentPid, [...(children.get(r.parentPid) ?? []), r]);
  const out: ProcRow[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  while (queue.length) {
    for (const c of children.get(queue.shift() as number) ?? []) {
      if (seen.has(c.pid)) continue;
      seen.add(c.pid);
      out.push(c);
      queue.push(c.pid);
    }
  }
  return out;
}

/** Signal the process group `pid` leads, or the process alone when it leads none. False when neither exists. */
function signalProcess(pid: number, sig: NodeJS.Signals | 0): boolean {
  if (process.platform !== 'win32') { try { process.kill(-pid, sig); return true; } catch { /* not a group leader */ } }
  try { process.kill(pid, sig); return true; } catch { return false; }
}

/** How often a timed-out run's group is checked for having gone, before the grace runs out. */
const GROUP_POLL_MS = 50;

/** Build the launch, run the CLI to completion and read its result. Resolves (never rejects) once the CLI has
 *  exited (and its output drained, see HEADLESS_DRAIN_MS) or could not be started, or, after a timeout, once its process group is gone or has been sent SIGKILL; a
 *  refused launch throws before anything runs. A CLI whose stdout or stderr passes the output bound is killed with its
 *  process group, and the run fails saying so. */
export function runHeadlessSeat(o: HeadlessSeatOptions): Promise<HeadlessRun> {
  const launch = buildHeadlessLaunch(o);
  const spawn = o.spawn ?? nodeSpawn;
  const grace = o.killGraceMs ?? HEADLESS_KILL_GRACE_MS;
  const readTable = o.processTable ?? probeProcessGroups;
  const pollMs = o.processPollMs ?? HEADLESS_PROCESS_POLL_MS;
  return new Promise<HeadlessRun>((resolveRun) => {
    const limit = o.maxOutputBytes ?? HEADLESS_MAX_OUTPUT_BYTES;
    const out = { stdout: '', stderr: '' };
    const bytes = { stdout: 0, stderr: 0 };
    let overflow: string | null = null;
    let settled = false;
    let timedOut = false;
    let killSignal: HeadlessRun['killSignal'] = null;
    const timers: NodeJS.Timeout[] = [];
    // The CLI's subprocesses seen while it ran (pid -> command), and those signalled.
    const known = new Map<number, string>();
    const swept = new Set<number>();
    let sweepError: string | null = null;
    const finish = (exitCode: number | null, signal: string | null, spawnError: string | null): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) { clearTimeout(t); clearInterval(t); }
      const { stdout, stderr } = out;
      const r = spawnError || overflow || timedOut ? null : parseHeadlessOutput(stdout).result;
      const cost = r && typeof r.total_cost_usd === 'number' && Number.isFinite(r.total_cost_usd) ? r.total_cost_usd : null;
      const subtype = r ? text(r.subtype) : null;
      const problem = r ? headlessResultProblem(r) : null;
      const budgetStop = subtype === BUDGET_STOP_SUBTYPE;
      let error = spawnError ?? overflow;
      if (!error && timedOut) {
        const others = swept.size ? ` and ${swept.size} of its subprocesses (with their groups)` : '';
        error = `the run timed out after ${o.timeoutMs} ms and its process group${others} was sent ${killSignal}`
          + (sweepError ? `; its other subprocesses could not be listed (${sweepError})` : '');
      } else if (!error && !r) error = 'the CLI\'s output does not end with a JSON result object';
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
        timedOut, killSignal, swept: swept.size, sweepError, startedAt,
      });
    };
    let child: ChildProcess;
    const startedAt = Date.now();
    try {
      o.onLaunch?.({ settingsFile: launch.settingsFile, argv: launch.argv });
    } catch (e) { finish(null, null, `the CLI was not started: its caller refused the launch: ${(e as Error).message}`); return; }
    try {
      // detached: the CLI leads a new process group, which its own children join unless they start their own.
      child = spawn(launch.argv[0], launch.argv.slice(1), { cwd: launch.cwd, env: launch.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch (e) { finish(null, null, (e as Error).message); return; }
    if (child.pid !== undefined && o.onSpawn) {
      try { o.onSpawn({ pid: child.pid, pgid: process.platform === 'win32' ? null : child.pid }); } catch { /* the caller's to report */ }
    }
    const cliRunning = (): boolean => child.exitCode === null && child.signalCode === null;
    /** One read of the process table, abandoned after PROCESS_TABLE_TIMEOUT_MS; null (and sweepError) when it fails. */
    const read = (): Promise<GroupProcRow[] | null> => new Promise((res) => {
      let done = false;
      const fail = (why: string): void => { if (done) return; done = true; sweepError ??= why; res(null); };
      const t = setTimeout(() => fail(`the process table could not be read within ${PROCESS_TABLE_TIMEOUT_MS} ms`), PROCESS_TABLE_TIMEOUT_MS);
      let p: Promise<GroupProcRow[]>;
      try { p = Promise.resolve(readTable()); } catch (e) { p = Promise.reject(e); }
      p.then((rows) => { clearTimeout(t); if (done) return; done = true; res(rows); },
        (e: unknown) => { clearTimeout(t); fail(`the process table could not be read: ${(e as Error)?.message ?? String(e)}`); });
    });
    /** Record the CLI's subprocesses from a table read while it still runs (later they are reparented and lost). */
    const record = (rows: readonly ProcRow[]): void => {
      if (!cliRunning() || child.pid === undefined) return;
      for (const d of descendantsOf(rows, child.pid)) known.set(d.pid, d.commandLine);
    };
    /** Signal the CLI's group and each of its subprocesses with its group: from a fresh read, only pids the table
     *  still shows with the command they had while the CLI ran. While the CLI runs, its group is its own. Once it has
     *  exited, the group is signalled only when the same read shows the group with no leader: some process in a group
     *  numbered as the CLI's pid, and no process with that pid. Such a group is what the CLI left behind, its late
     *  subprocesses included, which no earlier reading saw; a group whose number was taken over shows its new leader,
     *  and a table that cannot be read (or has no groups) shows nothing, so neither is signalled. */
    const sweep = async (sig: NodeJS.Signals): Promise<void> => {
      const running = cliRunning();
      const rows = await read();
      const targets: number[] = [];
      let leftBehind = false;
      if (rows) {
        record(rows);
        const now = new Map(rows.map((r) => [r.pid, r.commandLine]));
        for (const [pid, cmd] of known) if (now.get(pid) === cmd) targets.push(pid);
        const g = child.pid;
        leftBehind = g !== undefined && !rows.some((r) => r.pid === g) && rows.some((r) => r.pgid === g);
      }
      if (running || leftBehind) signalGroup(child, sig);
      for (const pid of targets) if (signalProcess(pid, sig)) swept.add(pid);
    };
    let reading = false;
    const recorder = setInterval(() => {
      if (reading || !cliRunning()) return;
      reading = true;
      void read().then((rows) => { reading = false; if (rows) record(rows); });
    }, pollMs);
    timers.push(recorder);
    // After a timeout the run resolves only once the CLI has exited and its group and subprocesses are gone or have
    // been sent SIGKILL, so nothing it started outlives the result.
    let closed: { code: number | null; signal: string | null } | null = null;
    let groupDone = false;
    const settleAfterKill = (): void => { if (closed && groupDone) finish(closed.code, closed.signal, null); };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const take = (stream: 'stdout' | 'stderr', d: string): void => {
      if (overflow) return;
      const n = Buffer.byteLength(d, 'utf8');
      if (bytes[stream] + n > limit) {
        overflow = `the CLI's ${stream} passed the output bound of ${limit} bytes, so it was killed`;
        // The same kill a timeout ends in, so nothing the CLI started outlives it either.
        killSignal = 'SIGKILL';
        signalGroup(child, 'SIGKILL');
        void sweep('SIGKILL');
        return;
      }
      bytes[stream] += n;
      out[stream] += d;
    };
    child.stdout?.on('data', (d: string) => take('stdout', d));
    child.stderr?.on('data', (d: string) => take('stderr', d));
    child.on('error', (e) => finish(null, null, e.message));
    const ended = (code: number | null, signal: string | null): void => {
      if (!timedOut) { finish(code, signal, null); return; }
      closed = { code, signal };
      settleAfterKill();
    };
    // The run is over when the CLI exits: its result line is written by then. What it started is swept first (after a
    // timeout the timeout's own signals do that). Output still in the pipes gets a short drain; a subprocess that
    // keeps the pipes open after that does not hold the result back.
    let timeoutTimer: NodeJS.Timeout | null = null;
    child.on('exit', (code, signal) => {
      clearInterval(recorder);
      // A CLI that exited before its timeout is not timed out, however long the sweep and drain after it take.
      if (timeoutTimer && !timedOut) clearTimeout(timeoutTimer);
      const swept = timedOut ? Promise.resolve() : sweep('SIGKILL');
      void swept.then(() => {
        const drain = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); ended(code, signal); }, HEADLESS_DRAIN_MS);
        timers.push(drain);
        if (child.stdout?.readableEnded !== false && child.stderr?.readableEnded !== false) { clearTimeout(drain); ended(code, signal); return; }
        child.once('close', () => { clearTimeout(drain); ended(code, signal); });
      });
    });
    if (o.timeoutMs !== undefined) {
      timers.push(timeoutTimer = setTimeout(() => {
        if (settled || overflow) return;
        timedOut = true;
        killSignal = 'SIGTERM';
        void sweep('SIGTERM').then(() => {
          if (settled) return;
          const gone = (): boolean => !signalGroup(child, 0) && [...swept].every((pid) => !signalProcess(pid, 0));
          const poll = setInterval(() => {
            if (gone()) { clearInterval(poll); groupDone = true; settleAfterKill(); }
          }, GROUP_POLL_MS);
          timers.push(poll);
          timers.push(setTimeout(() => {
            clearInterval(poll);
            const last = groupDone ? Promise.resolve() : (killSignal = 'SIGKILL', sweep('SIGKILL'));
            void last.then(() => {
              groupDone = true;
              settleAfterKill();
              // Something outside the group may still hold the output pipes open; do not wait on it for ever.
              timers.push(setTimeout(() => {
                child.stdout?.destroy(); child.stderr?.destroy();
                finish(closed?.code ?? child.exitCode, closed?.signal ?? child.signalCode, null);
              }, grace));
            });
          }, grace));
          if (gone()) { clearInterval(poll); groupDone = true; settleAfterKill(); }
        });
      }, o.timeoutMs));
    }
  });
}
