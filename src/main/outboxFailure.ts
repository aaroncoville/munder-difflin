import { closeSync, openSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/** The step of routing one outbox file that went wrong. A file only fails `not-delivered` after routing
 *  it finished without placing it anywhere. */
export type OutboxStage = 'read' | 'normalize' | 'recipient' | 'route' | 'archive' | 'not-delivered';

export interface OutboxFailureActions {
  log: (row: Record<string, unknown>) => void;
  /** Moves the file out of the outbox so it is not read again, and returns its new name. Throws if it could not. */
  quarantine: () => string;
  /** Tells the sender. Throws if it could not. */
  notify: (subject: string, body: string) => void;
}

const OUTCOME: Record<OutboxStage, string> = {
  read: 'It was not delivered. Correct the problem and write a new file.',
  normalize: 'It was not delivered. Correct the problem and write a new file.',
  recipient: 'Its "to" is not an agent on the roster or a known name, so nothing was delivered. Check it against the roster and write a new file.',
  route: 'Routing failed, and this message may have reached some recipients. Check before you resend it.',
  archive: 'It was delivered, but could not be filed as sent. Do not resend it.',
  'not-delivered': 'It was not delivered: the relay limit was reached or the recipient has no inbox.'
};

/**
 * Moves `file` from `outbox` to the first free name that `nameFor` gives under `outbox/.sent`. Senders reuse file
 * names and these files are read later, so an earlier one must not be overwritten. Each name is claimed with an
 * exclusive create before the rename replaces the claim. Returns the name used.
 */
function moveToSent(outbox: string, file: string, nameFor: (n: number) => string): string {
  return moveWithoutReplacing(join(outbox, file), join(outbox, '.sent'), nameFor);
}

/** Moves `source` into `folder` under the first free name `nameFor` gives, claiming it first. Returns the name used. */
export function moveWithoutReplacing(source: string, folder: string, nameFor: (n: number) => string): string {
  for (let n = 0; n < 10_000; n++) {
    const name = nameFor(n);
    const target = join(folder, name);
    try {
      closeSync(openSync(target, 'wx'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    try {
      renameSync(source, target);
    } catch (error) {
      rmSync(target, { force: true });
      // A directory cannot replace the claim, but the name is free, so it can move there once the claim is gone.
      if ((error as NodeJS.ErrnoException).code !== 'ENOTDIR' && (error as NodeJS.ErrnoException).code !== 'EISDIR') throw error;
      renameSync(source, target);
    }
    return name;
  }
  throw new Error(`no free name in ${folder}`);
}

/** Files a delivered message as `<file>`, or `<n>-<file>` when that is taken. Returns the name used. */
export function archiveOutboxFile(outbox: string, file: string): string {
  return moveToSent(outbox, file, (n) => (n === 0 ? file : `${n}-${file}`));
}

/** Sets a failed message aside as `bad-<file>`, or `bad-<n>-<file>` when that is taken. Returns the name used. */
export function quarantineOutboxFile(outbox: string, file: string): string {
  return moveToSent(outbox, file, (n) => (n === 0 ? `bad-${file}` : `bad-${n}-${file}`));
}

/** A filesystem error code only: error text can quote message bodies and absolute paths. */
function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(code) ? code : undefined;
}

/**
 * Logs a failed outbox file, sets it aside and tells its sender. If it cannot be set aside it will be
 * read again on the next pass, so the sender is told only once it has been.
 */
export function reportOutboxFailure(
  stage: OutboxStage, file: string, from: string, error: unknown, actions: OutboxFailureActions
): void {
  actions.log({ kind: 'outbox-error', stage, from, file, code: errorCode(error) });
  let name: string;
  try {
    name = actions.quarantine();
  } catch (quarantineError) {
    actions.log({ kind: 'outbox-error', stage, from, file, quarantine: 'failed', code: errorCode(quarantineError) });
    return;
  }
  try {
    actions.notify(`[not delivered] ${file}`, `Your outbox file ${JSON.stringify(file)} failed at the ${stage} step. ${OUTCOME[stage]} `
      + `The original is in outbox/.sent/${name}.`);
  } catch (notifyError) {
    actions.log({ kind: 'outbox-error', stage, from, file, notice: 'failed', code: errorCode(notifyError) });
  }
}
