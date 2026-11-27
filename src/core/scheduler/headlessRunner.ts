/**
 * The runner that runs a scheduled task as one headless stream (headlessStream.ts runHeadlessStream).
 *
 * A thin adapter: the frozen definition gives the prompt, seat, model, working folder, output file and timeout; the
 * job gives the cap, passed as maxBudgetUsd (the CLI's --max-budget-usd); everything else a seat needs (settings
 * folder, staged hook runtime, plugin map, CLI path, environment) is fixed when the adapter is made. The stream's own
 * cost row and done message are switched off through its `effects` option, because the scheduler writes both, keyed
 * by the run id, so that a resumed run cannot repeat them. The adapter itself writes nothing in the hive.
 *
 * Each launch gets a settings file of its own, keyed by the run id and the attempt (the seat's launchKey), and before
 * the CLI starts the scheduler is given that file's argument, which no other launch's command line holds (the seat's
 * onLaunch, the job's onLaunch). The CLI's pid and process group are handed to it as soon as
 * it starts (the seat's onSpawn, the job's onProcess), so a scheduler that dies while the CLI runs leaves a record the next one can check before starting
 * another. A definition with no timeout gets DEFAULT_SCHEDULED_TIMEOUT_MS: the scheduler heartbeats its lease for as
 * long as the runner works, so a run with no limit could hold its task for good.
 *
 * A definition naming a root the seat could not write (outside the seat's write roots for that working folder) is
 * refused before anything runs: the run fails with that reason rather than run without the folder it was written for.
 */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { headlessLaunchSettingsFile, LAUNCH_SETTINGS_PREFIX } from '../headlessSeat';
import { holds } from '../hookRuntime';
import { runHeadlessStream as realRunHeadlessStream, type HeadlessCost, type HeadlessStreamOptions, type HeadlessStreamResult } from '../headlessStream';
import { seatWriteRoots } from '../writeRoots';
import { probeProcessGroups, type GroupProcRow } from '../processGroups';
import type { Runner } from './scheduler';
import type { SchedulerStore, StoredRun } from './store';

/** What a seat needs besides the task definition. */
export type HeadlessRunnerSeat = Omit<HeadlessStreamOptions, 'prompt' | 'agentId' | 'model' | 'maxBudgetUsd' | 'cwd' | 'outputFile' | 'timeoutMs' | 'effects' | 'onSpawn' | 'onLaunch' | 'launchKey'>;

/** The time limit of a scheduled run whose definition sets none. */
export const DEFAULT_SCHEDULED_TIMEOUT_MS = 30 * 60_000;

export interface HeadlessRunnerDeps {
  runHeadlessStream: (o: HeadlessStreamOptions) => Promise<HeadlessStreamResult>;
}

const LEFT_TO_SCHEDULER: HeadlessCost = { costRecorded: false, costReason: 'recorded by the scheduler, keyed by the run id', row: null };

export function headlessStreamRunner(seat: HeadlessRunnerSeat, deps: HeadlessRunnerDeps = { runHeadlessStream: realRunHeadlessStream }): Runner {
  return async (job) => {
    const s = job.snapshot;
    const writable = seatWriteRoots({ root: seat.hiveRoot, agentId: s.agentId, isGod: seat.isGod === true, cwd: s.cwd });
    const outside = s.roots.find((r) => !writable.some((w) => holds(w, r)));
    if (outside) throw new Error(`the task names ${outside}, which is outside the seat's write roots (${writable.join(', ')})`);
    const result = await deps.runHeadlessStream({
      ...seat,
      prompt: s.prompt, agentId: s.agentId, model: s.model, cwd: s.cwd, outputFile: s.outputFile,
      maxBudgetUsd: job.maxBudgetUsd,
      timeoutMs: s.timeoutMs ?? DEFAULT_SCHEDULED_TIMEOUT_MS,
      launchKey: `${job.runId}.a${job.attempt}`,
      onLaunch: (l) => job.onLaunch(`--settings ${l.settingsFile} `),
      onSpawn: job.onProcess,
      effects: { recordCost: () => LEFT_TO_SCHEDULER, publish: () => '' },
    });
    return { run: result.run, done: result.done, doneReason: result.doneReason };
  };
}

export interface LaunchSettingsSweep {
  /** The launch settings files removed. */
  removed: string[];
  /** Launch settings files kept: their run is still going, or a live process names them. */
  kept: string[];
  /** Why nothing was removed: the folder or the process table could not be read. */
  error: string | null;
}

/** A launch settings file younger than this is never removed. The folder is shared by every hive, while the sweep
 *  knows one hive's runs, and a launch's file is written just before its CLI starts: a fresh file of another hive (or
 *  one whose run row is a moment behind it) would otherwise look unknown and unused. */
export const LAUNCH_SETTINGS_MIN_AGE_MS = 10 * 60_000;

/** Run states in which a launch's settings file may still be read by its CLI. */
const OPEN_STATES: ReadonlyArray<StoredRun['state']> = ['claimed', 'running', 'ran'];

/**
 * Removes the launch settings files a scheduler that died while its CLI ran left in the seat settings folder. For
 * a scheduler to call when it starts.
 *
 * Only files named as a launch's own (LAUNCH_SETTINGS_PREFIX) are looked at; a seat's shared settings file is never
 * touched. Each is matched to its run through core.db (every attempt of every run, by the name the adapter gives its
 * launch). A file is removed only when it is a regular file at least LAUNCH_SETTINGS_MIN_AGE_MS old, its run is over
 * or unknown to core.db, and its name appears in no running process's command line (one read of the process table):
 * an orphaned CLI may still be reading it. When the folder, the hive
 * or the table cannot be read, nothing is removed and the error says why.
 */
export async function sweepLaunchSettings(o: {
  store: SchedulerStore; settingsDir: string; hiveRoot: string; processTable?: () => Promise<GroupProcRow[]>;
  /** The wall clock (epoch ms), for the files' age. */
  now?: () => number;
}): Promise<LaunchSettingsSweep> {
  const out: LaunchSettingsSweep = { removed: [], kept: [], error: null };
  let names: string[];
  try {
    names = readdirSync(o.settingsDir).filter((n) => n.startsWith(LAUNCH_SETTINGS_PREFIX) && n.endsWith('.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return out;
    return { ...out, error: `the seat settings folder could not be read: ${(e as Error).message}` };
  }
  if (!names.length) return out;
  const stateOf = new Map<string, StoredRun['state']>();
  try {
    for (const run of o.store.runs()) {
      for (let n = 1; n <= Math.max(1, run.attempt); n++) {
        stateOf.set(basename(headlessLaunchSettingsFile(o.settingsDir, o.hiveRoot, run.snapshot.agentId, `${run.id}.a${n}`)), run.state);
      }
    }
  } catch (e) {
    return { ...out, error: `the runs' launch settings files could not be named, so none was removed: ${(e as Error).message}` };
  }
  let rows: GroupProcRow[];
  try {
    rows = await (o.processTable ?? probeProcessGroups)();
  } catch (e) {
    return { ...out, error: `the process table could not be read, so no launch settings file was removed: ${(e as Error).message}` };
  }
  // By the file's name anywhere on any command line, whatever the flag form, quoting, folder spelling or position: the
  // name holds a digest no other file shares, and a process table gives no reliable way to split arguments. Erring
  // this way only keeps a small private file a while longer; a file removed from under a running CLI cannot be put
  // back. The name must stand as a whole token, so a longer name that merely contains it does not count.
  const named = (name: string): boolean => {
    const token = new RegExp(`(?<![A-Za-z0-9._-])${name.replace(/[.]/g, '\\.')}(?![A-Za-z0-9._-])`);
    return rows.some((r) => token.test(r.commandLine));
  };
  const now = (o.now ?? Date.now)();
  for (const name of names) {
    const file = join(o.settingsDir, name);
    const state = stateOf.get(name);
    let st;
    try { st = lstatSync(file); } catch { continue; }
    if (!st.isFile() || now - st.mtimeMs < LAUNCH_SETTINGS_MIN_AGE_MS || (state !== undefined && OPEN_STATES.includes(state)) || named(name)) {
      out.kept.push(file);
      continue;
    }
    try { rmSync(file, { force: true }); out.removed.push(file); } catch { out.kept.push(file); }
  }
  return out;
}
