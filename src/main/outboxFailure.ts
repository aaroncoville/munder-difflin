/** The step of routing one outbox file that went wrong. A file only fails `not-delivered` after routing
 *  it finished without placing it anywhere. */
export type OutboxStage = 'read' | 'normalize' | 'route' | 'archive' | 'not-delivered';

export interface OutboxFailureActions {
  log: (row: Record<string, unknown>) => void;
  /** Moves the file out of the outbox so it is not read again. Throws if it could not. */
  quarantine: () => void;
  /** Tells the sender. Throws if it could not. */
  notify: (subject: string, body: string) => void;
}

const OUTCOME: Record<OutboxStage, string> = {
  read: 'It was not delivered. Correct the problem and write a new file.',
  normalize: 'It was not delivered. Correct the problem and write a new file.',
  route: 'Routing failed, and this message may have reached some recipients. Check before you resend it.',
  archive: 'It was delivered, but could not be filed as sent. Do not resend it.',
  'not-delivered': 'It was not delivered: the relay limit was reached or the recipient has no inbox.'
};

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
  try {
    actions.quarantine();
  } catch (quarantineError) {
    actions.log({ kind: 'outbox-error', stage, from, file, quarantine: 'failed', code: errorCode(quarantineError) });
    return;
  }
  try {
    actions.notify(`[not delivered] ${file}`, `Your outbox file ${JSON.stringify(file)} failed at the ${stage} step. ${OUTCOME[stage]} `
      + `The original is in outbox/.sent/bad-${file}.`);
  } catch (notifyError) {
    actions.log({ kind: 'outbox-error', stage, from, file, notice: 'failed', code: errorCode(notifyError) });
  }
}
