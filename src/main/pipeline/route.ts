/**
 * The router's side of the merge-request pipeline (spec 5.1; steel-thread ST-3).
 *
 * An agent writes a message to the harness-owned recipient `pipeline` with `hive-mr`.
 * The router reads that file as untrusted text: strictly (a name given twice is
 * refused, so the router and the conductor cannot read two different messages from
 * one file), then the payload against its schema. What passes goes to the conductor
 * as the validator's own rebuilt value, never the agent's object. Anything else is
 * refused back to the sender with every reason at once. With no conductor attached
 * (the pipeline off), every message to it is refused. Pure: no I/O here.
 */
import { createHash } from 'node:crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as {
  parseJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string };
  validatePayload(m: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };
};

/** The recipient name the router hands to the conductor. */
export const PIPELINE = 'pipeline';

/** The schemas an agent may send to the pipeline. The pipeline's own requests go the other way. */
const FROM_AGENTS = new Set(['mr.submit/1', 'mr.verdict/1', 'mr.command/1']);

export type Intake =
  | { kind: 'deliver'; payload: Record<string, unknown>; schema: string; key: string }
  | { kind: 'refuse'; errors: string[] };

/** True for "pipeline" in any case: mail meant for the pipeline, though only the lowercase name is accepted. */
export function isPipelineName(to: string): boolean {
  return typeof to === 'string' && to.toLowerCase() === PIPELINE;
}

/** The envelope fields the conductor reads must be text (or null for in_reply_to); anything else is refused. */
export function envelopeErrors(partial: Record<string, unknown>): string[] {
  const errors: string[] = [];
  for (const k of ['subject', 'body', 'conversation', 'act']) {
    if (Object.hasOwn(partial, k) && typeof partial[k] !== 'string') errors.push(`${k}: must be text`);
  }
  if (Object.hasOwn(partial, 'in_reply_to') && partial.in_reply_to !== null && typeof partial.in_reply_to !== 'string') errors.push('in_reply_to: must be text or null');
  return errors;
}

/**
 * The conductor's key for a message: the sender and the validated payload. The same submit or verdict sent
 * again, under any message id, after any restart, has the same key; the conductor treats a key it has seen as
 * a repeat. The router's own repeat window does not survive a restart, so this key is the contract.
 */
export function pipelineKey(from: string, payload: Record<string, unknown>): string {
  return createHash('sha256').update(`${from}\u0000${JSON.stringify(payload)}`).digest('hex');
}

/** What the router does with the text of one outbox file addressed to the pipeline. */
export function pipelineIntake(text: string, enabled: boolean, from: string): Intake {
  if (!enabled) return { kind: 'refuse', errors: ['the merge-request pipeline is not enabled on this floor'] };
  const parsed = core.parseJson(text);
  if (!parsed.ok) return { kind: 'refuse', errors: [`the message is not strict JSON: ${parsed.reason}`] };
  const v = parsed.value;
  const payload = v !== null && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, 'payload') ? (v as Record<string, unknown>).payload : undefined;
  if (payload === undefined) return { kind: 'refuse', errors: ['payload: a message to the pipeline carries a payload; write it with hive-mr'] };
  const checked = core.validatePayload(payload);
  if (!checked.ok) return { kind: 'refuse', errors: checked.errors.slice(0, 50) };
  const schema = checked.value.schema;
  if (typeof schema !== 'string' || !FROM_AGENTS.has(schema)) return { kind: 'refuse', errors: [`payload.schema: ${String(schema)} is not one an agent sends`] };
  return { kind: 'deliver', payload: checked.value, schema, key: pipelineKey(from, checked.value) };
}

/** The body of the one refusal the sender gets: every reason, then what to do. */
export function refusalBody(errors: string[]): string {
  const lines = errors.slice(0, 50).map((e) => `- ${e.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 300)}`);
  return [
    'The pipeline did not accept this message:',
    ...lines,
    '',
    'Fix these and send it again with hive-mr (see the pipeline section of PROTOCOL.md).',
  ].join('\n');
}
