/**
 * Usage telemetry seam (Lane A #6.6 — Seam 1, the LOCKED contract with Oscar/#7).
 *
 * The circuit breaker (breaker.ts) and the durable cost ledger (hive.ts
 * appendCostLedger) consume usage ONLY through the `UsageProvider` interface —
 * they never read transcripts, never compute tokens, and never recompute `usd`.
 * That keeps a single source of truth for cost and lets the backend swap with
 * zero changes to the consumers:
 *
 *   - PRIMARY (pull): `getAgentUsage(agentId)` — both backends implement it
 *     identically, so consumer code is swap-stable.
 *   - ADDITIVE (push): `onAgentUsage(cb)` — OTel-backend only, a later
 *     zero-rewrite latency upgrade. The stub does not implement it.
 *
 * Two invariants every consumer must honor (Oscar's 7A.1 spike findings):
 *   (i)  Samples are CUMULATIVE snapshots (monotonic running totals). Velocity is
 *        the DIFF of consecutive pulls (Δusd/Δt, Δoutput/Δt) — never treat a
 *        single sample as an increment.
 *   (ii) `model` arrives normalized (base id, any `[1m]` suffix stripped).
 *
 * `StubUsageProvider` is a thin INTERIM backend so Lane A isn't blocked on Lane C:
 * it wraps the existing transcript reader (readAgentUsage) — the same interim
 * "transcript-poll" backend Oscar owns and will evolve, then replace with the
 * native-OTel collector. At integration we drop in Oscar's module; breaker.ts and
 * the ledger are untouched. The stub's `usd` is the transcript fallback estimate
 * (and inherits the known Sonnet-hardcoded pricing limitation, which Oscar fixes
 * in exactly one place — his provider); it is NOT recomputed downstream.
 */
import { readAgentUsage } from './transcript';

/** One cumulative usage snapshot for an agent. The identical row that Oscar
 *  emits, Jim (this lane) persists to cost-ledger.jsonl, and Kevin (#4) stores
 *  in the cost_ledger SQLite table — one shape across all three lanes.
 *
 *  🔒 PII-free by construction: the provider's normalize step allowlists only
 *  these fields and strips every identity attribute (user.email, account/uuid,
 *  organization.id, hashed user.id) BEFORE emitting. Persist ONLY this sample;
 *  never a raw OTel record. */
export interface AgentUsageSample {
  agentId: string;
  /** Doubles as the #6.6a --resume key AND the cost accounting/dedup key. */
  sessionId: string | null;
  ts: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Normalized base model id (no `[1m]` suffix), or null if unknown. */
  model: string | null;
  /** Claude-precomputed cost (live path) / transcript-fallback estimate (interim).
   *  Never recomputed by a consumer. */
  usd: number;
}

/** The seam both backends implement. */
export interface UsageProvider {
  /** PRIMARY pull. Returns a cumulative snapshot, or null when unknown. */
  getAgentUsage(agentId: string): AgentUsageSample | null;
  /** ADDITIVE push (OTel backend only). Optional; the stub omits it. */
  onAgentUsage?(cb: (sample: AgentUsageSample) => void): () => void;
}

/** What the stub needs to turn an agentId into a transcript read + sample fields.
 *  Wired (in index.ts) to the hive registry: cwd for the transcript dir,
 *  sessionId for the resume/dedup key, model for the (best-effort) tier. */
export interface UsageResolver {
  (agentId: string): { cwd: string; sessionId?: string | null; model?: string | null } | null;
}

/** Strip the `[1m]` (or `[…]`) context-window suffix so the model id matches the
 *  normalized form Oscar's OTel ingest emits. */
function normalizeModel(model: string | null | undefined): string | null {
  if (!model) return null;
  return model.replace(/\[[^\]]*\]$/, '').trim() || null;
}

/**
 * Interim transcript-backed provider. Reads cumulative token totals from an
 * agent's Claude Code transcripts (readAgentUsage) and shapes them into an
 * AgentUsageSample. Stands in for Oscar's provider until Lane C lands; the
 * consumers (breaker, ledger) call it through UsageProvider and never change.
 */
export class StubUsageProvider implements UsageProvider {
  constructor(private resolve: UsageResolver) {}

  getAgentUsage(agentId: string): AgentUsageSample | null {
    const info = this.resolve(agentId);
    if (!info) return null;
    const u = readAgentUsage(info.cwd); // cumulative running totals across transcripts
    return {
      agentId,
      sessionId: info.sessionId ?? null,
      ts: Date.now(),
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadTokens,
      cacheCreation: u.cacheWriteTokens,
      model: normalizeModel(info.model),
      usd: u.estimatedCostUsd // interim fallback estimate; Oscar's provider supplies Claude-precomputed usd
    };
  }
}

/**
 * Duplicate gate for CUMULATIVE file-snapshot samples (Grok).
 *
 * `appendCostLedger` is fed a running TOTAL, not an increment, so re-appending
 * an unchanged sample writes the same row over and over. That is #56: the
 * transcript fallback did exactly this and left 2,417 identical rows behind,
 * which is why it now reports an empty `sessionId` to disqualify itself from
 * the ledger.
 *
 * The Grok provider cannot use that trick — it needs a real session id to be
 * accounted at all — so it needs this instead: append only when the numbers
 * actually moved. An idle Grok agent re-reads the same `usage.json` on every
 * beat and is correctly silent.
 *
 * `ts` is deliberately NOT part of the signature. It tracks when the file was
 * written, not what it says, and a sample whose timestamp is the only thing to
 * have changed carries no new cost.
 */
export class CumulativeSampleGate {
  private readonly last = new Map<string, string>();

  /** True when this sample differs from the last one admitted for the agent. */
  admits(sample: AgentUsageSample): boolean {
    const signature = [
      sample.sessionId, sample.input, sample.output,
      sample.cacheRead, sample.cacheCreation, sample.model, sample.usd
    ].join('|');
    if (this.last.get(sample.agentId) === signature) return false;
    this.last.set(sample.agentId, signature);
    return true;
  }

  /** Drop an agent's memory (archived/despawned) so the map cannot grow forever. */
  forget(agentId: string): void {
    this.last.delete(agentId);
  }
}

/**
 * Whether a provider's ledger rows go through a CumulativeSampleGate. Grok and
 * Codex samples come from files the CLI keeps, so they always carry a session
 * id and would otherwise be appended unchanged on every beat. The live-OTel
 * path is not gated: it only yields a session id while a session is live.
 */
export function usesCumulativeGate(provider: string | undefined): boolean {
  return provider === 'grok' || provider === 'codex';
}

/**
 * What a cumulative file sample has added since this app run first saw it.
 *
 * A Grok or Codex sample is a session's running total from a file its CLI
 * keeps, not from this run: a Codex rollout holds every call since the session
 * began, across every resume. Live telemetry only
 * counts from the moment the app starts listening, so a per-agent token cap
 * means "this run" for a Claude agent; tested against a file sample, the same
 * cap trips on the first beat for any long-lived session, from history alone.
 * The breaker is fed this difference instead; the ledger keeps the cumulative
 * row.
 *
 * Only the first session seen for an agent in this run can hold history. A
 * session that replaces it later began while this run was watching (the agent
 * started a new thread), so all of it is this run's, including what it spent
 * before the beat first sampled it: its baseline is zero.
 */
export class RunBaseline {
  private readonly first = new Map<string, AgentUsageSample>();

  sinceFirstSight(sample: AgentUsageSample): AgentUsageSample {
    let base = this.first.get(sample.agentId);
    if (base && base.sessionId !== sample.sessionId) {
      base = { ...sample, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, usd: 0 };
      this.first.set(sample.agentId, base);
    }
    // A smaller total than the baseline is a different file under the session.
    const shrank = base && (sample.input < base.input || sample.output < base.output);
    if (!base || shrank) {
      base = sample;
      this.first.set(sample.agentId, base);
    }
    const since = (now: number, then: number): number => Math.max(0, now - then);
    return {
      ...sample,
      input: since(sample.input, base.input),
      output: since(sample.output, base.output),
      cacheRead: since(sample.cacheRead, base.cacheRead),
      cacheCreation: since(sample.cacheCreation, base.cacheCreation),
      usd: since(sample.usd, base.usd)
    };
  }

  /** Drop an agent's baseline (archived/despawned): a respawn counts from its own start. */
  forget(agentId: string): void {
    this.first.delete(agentId);
  }
}

/**
 * The usage the fleet snapshot shows for an agent: its live telemetry, or, for
 * a provider costed from a file its CLI keeps, the sample the ledger records.
 * Every other agent without live telemetry shows nothing, as before; `pull` is
 * not called for it.
 */
export function snapshotUsageFor<T>(
  provider: string | undefined,
  live: T | undefined,
  pull: () => T | null
): T | undefined {
  if (live !== undefined || !usesCumulativeGate(provider)) return live;
  return pull() ?? undefined;
}
