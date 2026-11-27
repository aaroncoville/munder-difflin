/**
 * The runner that runs a scheduled task as one headless stream (headlessStream.ts runHeadlessStream).
 *
 * A thin adapter: the frozen definition gives the prompt, seat, model, working folder, output file and timeout; the
 * job gives the cap, passed as maxBudgetUsd (the CLI's --max-budget-usd); everything else a seat needs (settings
 * folder, staged hook runtime, plugin map, CLI path, environment) is fixed when the adapter is made. The stream's own
 * cost row and done message are switched off through its `effects` option, because the scheduler writes both, keyed
 * by the run id, so that a resumed run cannot repeat them. The adapter itself writes nothing in the hive.
 *
 * The CLI's pid and process group are handed to the scheduler as soon as it starts (the seat's onSpawn, the job's
 * onProcess), so a scheduler that dies while the CLI runs leaves a record the next one can check before starting
 * another. A definition with no timeout gets DEFAULT_SCHEDULED_TIMEOUT_MS: the scheduler heartbeats its lease for as
 * long as the runner works, so a run with no limit could hold its task for good.
 *
 * A definition naming a root the seat could not write (outside the seat's write roots for that working folder) is
 * refused before anything runs: the run fails with that reason rather than run without the folder it was written for.
 */
import { holds } from '../hookRuntime';
import { runHeadlessStream as realRunHeadlessStream, type HeadlessCost, type HeadlessStreamOptions, type HeadlessStreamResult } from '../headlessStream';
import { seatWriteRoots } from '../writeRoots';
import type { Runner } from './scheduler';

/** What a seat needs besides the task definition. */
export type HeadlessRunnerSeat = Omit<HeadlessStreamOptions, 'prompt' | 'agentId' | 'model' | 'maxBudgetUsd' | 'cwd' | 'outputFile' | 'timeoutMs' | 'effects' | 'onSpawn'>;

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
      onSpawn: job.onProcess,
      effects: { recordCost: () => LEFT_TO_SCHEDULER, publish: () => '' },
    });
    return { run: result.run, done: result.done, doneReason: result.doneReason };
  };
}
