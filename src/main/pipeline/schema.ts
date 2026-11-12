/**
 * The pipeline's structured messages (spec 5.2), typed for the main process.
 *
 * The rules themselves live in mr-core.cjs, shared with the agent-side `hive-mr`
 * CLI, so the CLI refuses exactly what the conductor would refuse.
 */

export type Sha = string;
export type SubmitKind = 'initial' | 'fix' | 'rebase' | 'pipeline-fix';
export type VerdictWord = 'CONFIRMED' | 'BLOCK' | 'ABSTAIN';
export type Severity = 'HIGH' | 'MED' | 'LOW';
export type FindingClass = 'defect' | 'security' | 'test-gap' | 'product-decision' | 'style';
export type AbstainReason = 'safety-refusal' | 'tooling' | 'capacity' | 'out-of-scope';
export type CommandWord = 'enrol' | 'resume' | 'pause' | 'abandon';

export interface Disposition {
  finding: string;
  status: 'fixed' | 'declined' | 'deferred';
  commit: Sha | null;
  note?: string | null;
}

export interface SubmitPayload {
  schema: 'mr.submit/1';
  card: string;
  repo: string;
  mr: number;
  head_sha: Sha;
  kind: SubmitKind;
  answers: string | null;
  dispositions: Disposition[];
  tests: Array<{ suite: string; passed: number; failed: number; evidence?: string | null }>;
  summary: string;
  decisions_taken: string[];
  needs_owner: { question: string } | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  must_fix: boolean;
  title: string;
  file?: string | null;
  line?: number | null;
  class: FindingClass;
  body: string;
}

export interface VerdictPayload {
  schema: 'mr.verdict/1';
  card: string;
  answers: string;
  reviewed_sha: Sha;
  round: number;
  verdict: VerdictWord;
  findings: Finding[];
  abstain_reason: AbstainReason | null;
  report?: string | null;
}

export interface EnrolArgs {
  repo: string;
  implementer: string;
  branch: string;
  review_hints?: string | null;
  risk?: string | null;
}

export interface CommandPayload {
  schema: 'mr.command/1';
  card: string;
  command: CommandWord;
  args?: EnrolArgs | Record<string, unknown>;
  reason?: string | null;
}

export type AgentPayload = SubmitPayload | VerdictPayload | CommandPayload;

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: string[] };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('./mr-core.cjs') as {
  SHA_RE: RegExp;
  CARD_RE: RegExp;
  validateSubmit(m: unknown): Validation<SubmitPayload>;
  validateVerdict(m: unknown): Validation<VerdictPayload>;
  validateCommand(m: unknown): Validation<CommandPayload>;
  validatePayload(m: unknown): Validation<AgentPayload>;
};

export const SHA_RE = core.SHA_RE;
export const CARD_RE = core.CARD_RE;
export const validateSubmit = core.validateSubmit;
export const validateVerdict = core.validateVerdict;
export const validateCommand = core.validateCommand;
export const validatePayload = core.validatePayload;

/** The verdict's must-fix findings: the ones that block a merge. */
export const mustFixFindings = (v: VerdictPayload): Finding[] => v.findings.filter((f) => f.must_fix);
