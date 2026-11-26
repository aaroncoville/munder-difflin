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
import { statSync } from 'node:fs';

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

/** The model a launch line asks for: the last `--model` (or Codex's `-m`) value, or null. */
export function launchModel(cli: PinnedCli, argv: string[]): string | null {
  let model: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--model=')) model = a.slice('--model='.length);
    else if ((a === '--model' || (cli === 'codex' && a === '-m')) && i + 1 < argv.length) model = argv[++i];
  }
  return model;
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

/** Env a pinned seat starts with: a pinned Claude seat must not update itself away from its pin. */
export function pinnedSeatEnv(cli: PinnedCli, pin: CliPin | undefined): Record<string, string> {
  return pin && cli === 'claude' ? { DISABLE_AUTOUPDATER: '1' } : {};
}

type Run = (file: string, args: string[], opts: { encoding: 'utf8'; env: NodeJS.ProcessEnv; timeout: number }) => SpawnSyncReturns<string>;
const versions = new Map<string, string | null>();

/** The version an executable reports, read once per path and modification time (an upgrade in place re-reads). */
export function cliVersion(cli: PinnedCli, executable: string, env: NodeJS.ProcessEnv, run: Run = spawnSync): string | null {
  let mtime: number;
  try { mtime = statSync(executable).mtimeMs; } catch { return null; }
  const key = `${cli}\0${executable}\0${mtime}`;
  if (versions.has(key)) return versions.get(key) ?? null;
  let version: string | null = null;
  try {
    const res = run(executable, ['--version'], { encoding: 'utf8', env, timeout: 10_000 });
    version = parseCliVersion(cli, `${res.stdout ?? ''}\n${res.stderr ?? ''}`);
  } catch { version = null; }
  if (version) versions.set(key, version);
  return version;
}
