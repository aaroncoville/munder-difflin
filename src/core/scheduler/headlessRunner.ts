/**
 * The runner that runs a scheduled task as one headless stream (headlessStream.ts runHeadlessStream).
 *
 * A thin adapter: the frozen definition gives the prompt, seat, model, working folder, output file and timeout; the
 * job gives the cap, passed as maxBudgetUsd (the CLI's --max-budget-usd); everything else a seat needs (settings
 * folder, staged hook runtime, plugin map, CLI path, environment) is fixed when the adapter is made. The stream's own
 * cost row and done message are switched off through its `effects` option, because the scheduler writes both, keyed
 * by the run id, so that a resumed run cannot repeat them. The adapter itself writes nothing in the hive.
 *
 * A definition naming a root the seat could not write (outside the seat's write roots for that working folder) is
 * refused before anything runs: the run fails with that reason rather than run without the folder it was written for.
 */
import { holds } from '../hookRuntime';
import { runHeadlessStream as realRunHeadlessStream, type HeadlessCost, type HeadlessStreamOptions, type HeadlessStreamResult } from '../headlessStream';
import { seatWriteRoots } from '../writeRoots';
import type { Runner } from './scheduler';

/** What a seat needs besides the task definition. */
export type HeadlessRunnerSeat = Omit<HeadlessStreamOptions, 'prompt' | 'agentId' | 'model' | 'maxBudgetUsd' | 'cwd' | 'outputFile' | 'timeoutMs' | 'effects'>;

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
      ...(s.timeoutMs === undefined ? {} : { timeoutMs: s.timeoutMs }),
      effects: { recordCost: () => LEFT_TO_SCHEDULER, publish: () => '' },
    });
    return { run: result.run, done: result.done, doneReason: result.doneReason };
  };
}
