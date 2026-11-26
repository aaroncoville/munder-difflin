/**
 * Pinned provider CLIs for seats.
 *
 * A seat runs whichever `claude` or `codex` the login shell finds, so upgrading the shared install moves every new
 * seat onto the new version at once, untested. Hook and sandbox behaviour has changed between minor versions, so a
 * pin names the version a seat may start with (and, optionally, the model its launch line must name, so a change in
 * the CLI's model catalog cannot move seats either). A spawn whose CLI does not match is refused with both versions
 * named; taking an upgrade means running the upgrade canary on the new version, then moving the pin.
 *
 * No pin = no check and no change to the launch.
 */
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { sep } from 'node:path';

export type PinnedCli = 'claude' | 'codex';
export interface CliPin {
  /** Exact version as the CLI prints it, e.g. 2.1.332 or 0.172.0. */
  version: string;
  /** When set, the launch line must name exactly this model. */
  model?: string;
}
export type CliPins = Partial<Record<PinnedCli, CliPin>>;

export class CliPinRefused extends Error {}

/** The version in a CLI's `--version` output, or null when there is none. */
export function parseCliVersion(cli: PinnedCli, output: string): string | null {
  const re = cli === 'claude' ? /^(\d+\.\d+\.\d+)\s+\(Claude Code\)\s*$/m : /^codex-cli\s+(\d+\.\d+\.\d+)\s*$/m;
  return re.exec(output ?? '')?.[1] ?? null;
}

/** The model a launch line asks for: the last `--model` value (Codex also `-m`, and a `-c`/`--config` `model=`
 *  override, whose value is TOML and so may be quoted), or null. */
export function launchModel(cli: PinnedCli, argv: string[]): string | null {
  let model: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--model=')) model = a.slice('--model='.length);
    else if ((a === '--model' || (cli === 'codex' && a === '-m')) && i + 1 < argv.length) model = argv[++i];
    else if (cli === 'codex' && (a === '-c' || a === '--config') && i + 1 < argv.length) {
      const m = /^model\s*=\s*(.*)$/.exec(argv[++i]);
      if (m) model = m[1].trim().replace(/^(["'])(.*)\1$/, '$2');
    }
  }
  return model;
}

/** This CLI's pin from the config's `cliPins` value, or why that value cannot be used as one. */
export function pinFor(pins: unknown, cli: PinnedCli): { pin: CliPin | undefined } | { malformed: string } {
  if (pins === undefined || pins === null) return { pin: undefined };
  if (typeof pins !== 'object' || Array.isArray(pins)) return { malformed: 'the config\'s cliPins is not an object' };
  const entry = (pins as Record<string, unknown>)[cli];
  if (entry === undefined) return { pin: undefined };
  const e = entry as Record<string, unknown>;
  if (typeof entry !== 'object' || entry === null || typeof e.version !== 'string' || !e.version
    || (e.model !== undefined && (typeof e.model !== 'string' || !e.model))) {
    return { malformed: `the config's cliPins.${cli} is malformed: expected { "version": "x.y.z", "model"?: "..." }` };
  }
  return { pin: e.model === undefined ? { version: e.version } : { version: e.version, model: e.model as string } };
}

export type PinVerdict = { ok: true; pinned: boolean } | { ok: false; reason: string };

/** Whether a seat may start: its CLI's version (null = unreadable) and launch line against the pin. */
export function judgePin(cli: PinnedCli, pin: CliPin | undefined, version: string | null, argv: string[]): PinVerdict {
  if (!pin) return { ok: true, pinned: false };
  if (!version) return { ok: false, reason: `the ${cli} version could not be read, and seats are pinned to ${pin.version}` };
  if (version !== pin.version) {
    return { ok: false, reason: `${cli} ${version} is installed, but seats are pinned to ${pin.version}; run the upgrade canary on ${version}, then move the pin` };
  }
  if (pin.model) {
    const model = launchModel(cli, argv);
    if (!model) return { ok: false, reason: `the ${cli} launch line names no model, and seats are pinned to ${pin.model}` };
    if (model !== pin.model) return { ok: false, reason: `the ${cli} launch asks for model ${model}, but seats are pinned to ${pin.model}` };
  }
  return { ok: true, pinned: true };
}

/** The model pin judged again on the launch line exactly as it will start, after any later step added arguments.
 *  The version was judged before the CLI first ran; this checks the model only. */
export function judgeFinalLaunch(cli: PinnedCli, pin: CliPin | undefined, argv: string[]): PinVerdict {
  return pin ? judgePin(cli, pin, pin.version, argv) : { ok: true, pinned: false };
}

/** Env a pinned seat starts with: a pinned Claude seat must not update itself away from its pin. */
export function pinnedSeatEnv(cli: PinnedCli, pin: CliPin | undefined): Record<string, string> {
  return pin && cli === 'claude' ? { DISABLE_AUTOUPDATER: '1' } : {};
}

type Run = (file: string, args: string[], opts: { encoding: 'utf8'; env: NodeJS.ProcessEnv; cwd?: string; timeout: number }) => Pick<SpawnSyncReturns<string>, 'stdout' | 'stderr'>;
/** A version read, by path and mtime. A failed read is kept briefly: the read is synchronous, and a CLI that hangs on
 *  --version must not stall the main process for the full timeout on every spawn attempt. */
const versions = new Map<string, { version: string | null; at: number }>();
const FAILED_READ_TTL_MS = 60_000;

/** A version-manager shim (mise, asdf, pyenv, rbenv, nodenv: all under a `shims` folder) picks the real binary from
 *  the working folder, so only for one does the folder change the answer. */
function isShim(executable: string): boolean {
  let real = executable;
  try { real = realpathSync(executable); } catch { /* judge the path as given */ }
  return `${sep}${real}`.includes(`${sep}shims${sep}`) || executable.includes(`${sep}shims${sep}`);
}

/** The version an executable reports, read once per path, modification time and PATH (a script's interpreter is
 *  found on PATH), and per working folder only for a version-manager shim. Run with the environment and folder the
 *  agent itself will start in, so the reading matches what the agent will run. */
export function cliVersion(cli: PinnedCli, executable: string, where: { env?: NodeJS.ProcessEnv; cwd?: string },
  run: Run = spawnSync, now: () => number = Date.now): string | null {
  let mtime: number;
  try { mtime = statSync(executable).mtimeMs; } catch { return null; }
  const path = (where.env ?? process.env).PATH ?? '';
  const key = `${cli}\0${executable}\0${mtime}\0${path}\0${isShim(executable) ? where.cwd ?? '' : ''}`;
  const cached = versions.get(key);
  if (cached && (cached.version || now() - cached.at < FAILED_READ_TTL_MS)) return cached.version;
  let version: string | null = null;
  try {
    const res = run(executable, ['--version'], { encoding: 'utf8', env: where.env ?? process.env, cwd: where.cwd, timeout: 10_000 });
    version = parseCliVersion(cli, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  } catch { version = null; }
  versions.set(key, { version, at: now() });
  return version;
}

/** Where the PTY manager would launch from: its resolved path for a command and the environment it starts it with. */
export interface LaunchDeps {
  commandPath: (command: string) => string | null;
  launchEnv: (agentEnv?: Record<string, string>) => Record<string, string>;
  run?: Run;
}

/** The pin decision for one seat launch. The version is read from the executable the PTY manager will run, in the
 *  environment and folder it will run in, so the binary judged is the binary started. ok carries the env to add. */
export function seatPin(cli: PinnedCli, pins: unknown,
  launch: { command: string; args: string[]; cwd: string; env: Record<string, string> },
  deps: LaunchDeps): { ok: true; env: Record<string, string>; pin?: CliPin } | { ok: false; reason: string } {
  const p = pinFor(pins, cli);
  if ('malformed' in p) return { ok: false, reason: p.malformed };
  if (!p.pin) return { ok: true, env: {} };
  const executable = deps.commandPath(launch.command);
  const version = executable
    ? cliVersion(cli, executable, { env: deps.launchEnv(launch.env), cwd: launch.cwd }, deps.run)
    : null;
  const verdict = judgePin(cli, p.pin, version, [launch.command, ...launch.args]);
  if (!verdict.ok) return verdict;
  return { ok: true, env: pinnedSeatEnv(cli, p.pin), pin: p.pin };
}
