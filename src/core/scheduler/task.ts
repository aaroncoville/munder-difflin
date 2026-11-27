/**
 * A scheduled task's definition, in the scheduler's import format, and the slots its schedule makes.
 *
 * The import format is one JSON object:
 *
 *   { "id": "daily-scan", "agentId": "scan-seat", "prompt": "...", "schedule": { "daily": "07:19" },
 *     "model": "sonnet", "maxBudgetUsd": 5, "outputFile": "/abs/digest.md", "cwd": "/abs", "roots": ["/abs"],
 *     "timeoutMs": 3600000 }
 *
 * Every key but timeoutMs is required, and no other key is accepted, so a misspelt key is refused instead of being
 * silently ignored. importTaskDefinition is pure: it parses and checks, returns the definition unchanged, and writes
 * nothing; storing it is the store's business. A refusal names the field at fault.
 *
 * maxBudgetUsd is the task's cap: the runner passes it to the CLI as --max-budget-usd for each run. A floor-wide
 * ceiling, when given, refuses a task whose cap is above it at import, so no single task can be set to spend more
 * than the operator allows any one run.
 *
 * A slot is one scheduled moment, named by the schedule: the local date and the scheduled time
 * ("2026-11-21T07:19"). Every reading of the clock inside one slot names the same slot, so the key is a stable
 * idempotency key, unlike a timestamp taken when the slot was noticed.
 */
import { isAbsolute } from 'node:path';
import { isSafeMessageId } from '../messageId';

export interface DailySchedule {
  /** Local wall-clock time, "HH:MM" (24 hour). */
  daily: string;
}

export interface ScheduledTask {
  id: string;
  /** The seat the run belongs to: its cost row's agent_id, and the outbox its done message goes from. */
  agentId: string;
  prompt: string;
  schedule: DailySchedule;
  model: string;
  /** The cap on one run, in US dollars (--max-budget-usd). */
  maxBudgetUsd: number;
  /** The file the run produces (absolute); the run is done only when it is in place. */
  outputFile: string;
  /** The seat's working folder (absolute). */
  cwd: string;
  /** The folders the run is expected to write (absolute); a seat that could not write one of them is refused. */
  roots: string[];
  /** Stop the run after this long. */
  timeoutMs?: number;
}

/** A task definition that cannot be imported, and the field at fault. */
export class TaskDefinitionInvalid extends Error {
  constructor(readonly field: string, why: string) {
    super(`task definition: ${field} ${why}`);
    this.name = 'TaskDefinitionInvalid';
  }
}

const KEYS = new Set(['id', 'agentId', 'prompt', 'schedule', 'model', 'maxBudgetUsd', 'outputFile', 'cwd', 'roots', 'timeoutMs']);
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

export interface ImportOptions {
  /** The highest cap any one task may have, in US dollars. */
  ceilingUsd?: number;
}

/** Parses (when given text) and checks a task definition; returns it unchanged. Throws TaskDefinitionInvalid. */
export function importTaskDefinition(raw: unknown, o: ImportOptions = {}): ScheduledTask {
  let d: unknown = raw;
  if (typeof raw === 'string') {
    try { d = JSON.parse(raw); } catch (e) { throw new TaskDefinitionInvalid('(file)', `is not JSON: ${(e as Error).message}`); }
  }
  if (!isObject(d)) throw new TaskDefinitionInvalid('(file)', 'is not a JSON object');
  const bad = (field: string, why: string): never => { throw new TaskDefinitionInvalid(field, why); };
  for (const k of Object.keys(d)) if (!KEYS.has(k)) bad(k, 'is not a field of a task definition');
  if (!isSafeMessageId(d.id)) bad('id', 'must be letters, digits, dot, underscore or hyphen, starting with a letter or digit');
  if (!isSafeMessageId(d.agentId)) bad('agentId', 'must be an agent id: letters, digits, dot, underscore or hyphen');
  if (!nonEmpty(d.prompt)) bad('prompt', 'must be non-empty text');
  if (!isObject(d.schedule)) bad('schedule', 'must be an object such as { "daily": "07:19" }');
  const schedule = d.schedule as Record<string, unknown>;
  for (const k of Object.keys(schedule)) if (k !== 'daily') bad(`schedule.${k}`, 'is not a kind of schedule this scheduler knows (only daily)');
  if (typeof schedule.daily !== 'string' || !HHMM.test(schedule.daily)) bad('schedule.daily', 'must be a 24-hour local time, "HH:MM"');
  if (!nonEmpty(d.model)) bad('model', 'must be a model name');
  if (typeof d.maxBudgetUsd !== 'number' || !Number.isFinite(d.maxBudgetUsd) || d.maxBudgetUsd <= 0) bad('maxBudgetUsd', 'must be a positive number of US dollars');
  const cap = d.maxBudgetUsd as number;
  if (o.ceilingUsd !== undefined && cap > o.ceilingUsd) bad('maxBudgetUsd', `is ${cap}, above the ceiling of ${o.ceilingUsd} US dollars a run`);
  if (typeof d.outputFile !== 'string' || !isAbsolute(d.outputFile)) bad('outputFile', 'must be an absolute path');
  if (typeof d.cwd !== 'string' || !isAbsolute(d.cwd)) bad('cwd', 'must be an absolute path');
  if (!Array.isArray(d.roots) || !d.roots.every((r) => typeof r === 'string' && isAbsolute(r))) bad('roots', 'must be a list of absolute paths');
  if (d.timeoutMs !== undefined && (typeof d.timeoutMs !== 'number' || !Number.isSafeInteger(d.timeoutMs) || d.timeoutMs <= 0)) bad('timeoutMs', 'must be a positive whole number of milliseconds');
  return d as unknown as ScheduledTask;
}

export interface Slot {
  /** The slot's name: local date and scheduled time, "YYYY-MM-DDTHH:MM". */
  key: string;
  /** When it falls (epoch ms). */
  at: number;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The latest slot of `schedule` at or before `now`. */
export function slotAtOrBefore(schedule: DailySchedule, now: number): Slot {
  const [h, m] = schedule.daily.split(':').map(Number);
  const d = new Date(now);
  let slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
  if (slot.getTime() > now) slot = new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1, h, m);
  return { key: `${slot.getFullYear()}-${pad(slot.getMonth() + 1)}-${pad(slot.getDate())}T${pad(h)}:${pad(m)}`, at: slot.getTime() };
}
