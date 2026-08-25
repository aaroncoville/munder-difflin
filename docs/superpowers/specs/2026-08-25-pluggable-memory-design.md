# Pluggable memory backends — design

**Date:** 2026-08-25 · **Status:** approved section-by-section by Aaron; this file is the consolidated spec.
**Delivery:** long-lived branch `feat/pluggable-memory` on the fork. May never be upstreamed; it is our working copy either way. Shaped so upstream could adopt it (clean seam, no fork-only dependencies in the interface).

## Problem

Semantic memory is hardwired to MemPalace. `MemoryManager` (`src/main/memory.ts`) shells to the `mempalace` CLI for everything; `palaceReap.ts` is MemPalace-specific disk care; the agent prompt text names `mempalace search` literally (`hive.ts`). Users with an existing memory system cannot bring it. First supported alternative: **Hindsight** (HTTP server; Aaron's store). Obsidian was considered and dropped — a markdown vault is a different kind of thing, not a memory backend.

## Decisions (locked with Aaron)

1. **Full replacement, substrate kept.** The active backend is both where new memories are indexed and what agents search. Per-agent `memory.md` remains the write substrate and the durable source of truth; it is mined/synced into the active backend.
2. **Agents reach memory through a harness-owned shim** — `hive-memory search "<q>"` / `hive-memory wake-up`. Prompts never name a backend. Adding a backend touches zero prompt text.
3. **Scope: MemPalace (default) + Hindsight.** No third backend in v1.
4. **Approach: extracted TypeScript interface with in-process adapters** (over shim-only and out-of-process contracts).

## Architecture

### The interface (`src/main/memoryBackend.ts`)

```ts
interface MemoryBackend {
  readonly id: 'mempalace' | 'hindsight';
  available(): Promise<boolean>;        // CLI on PATH / server answers /health
  init(): Promise<void>;                // palace init / ensure bank exists
  mineAgent(agentDir: string, agentId: string): Promise<{ ok: boolean; backoffAdviceMs?: number }>;
  search(q: string, opts: { agentId?: string; results?: number }): Promise<{ ok: boolean; output: string; error?: string }>;
  wakeUp(agentId?: string): Promise<{ ok: boolean; output: string; error?: string }>;
  status(): BackendStatus;              // one shape for the renderer, backend-labelled
  agentEnv(): Record<string, string>;   // env spawned agents inherit (shim routing)
}
```

`MemoryManager` keeps everything backend-neutral, behavior unchanged: the 10-minute mine cadence, mtime skip-unchanged tracking, single-writer serialization, start/stop, status caching. It delegates the verbs above to the active adapter.

### MemPalaceAdapter

Today's code moved, behavior byte-identical: bin discovery (including, per upstream #217's shape, a bundled-binary fallback in the resolution order — bin resolution is adapter-internal so #217 slots in whether or not it merges), `MEMPALACE_*` env plus the macOS CPU device pin, quarantine detection surfaced as `backoffAdviceMs`, and `palaceReap`. Quarantine/reap machinery exists **only** in this adapter.

### HindsightAdapter

Small HTTP client against a Hindsight server (verified against the live pilot and its OpenAPI):

- **One bank per hive** (config; default derived from harness home). Search is bank-wide for cross-agent recall parity with the palace.
- `mineAgent` → `POST /v1/default/banks/{bank}/memories` with `items[]` — the pilot's `retain-bridge.py` semantics ported to TS: deterministic per-file document ids so re-retain is idempotent; MemoryManager's mtime tracking supplies the delta. Retain is LLM-backed and slow: posts run `async:false` under the existing per-mine timeout.
- `search` → `POST …/memories/recall`. `wakeUp` → recall top-N scoped by agent-id metadata — cheap, no LLM. Hindsight's `reflect` is deliberately unused in v1 (cost, latency); noted as future work.
- HTTP failure = plain retry next cycle. No quarantine-style machinery.
- `agentEnv`: `HINDSIGHT_URL`, `HINDSIGHT_BANK`.

## Config and migration

```jsonc
memory: {
  enabled: boolean,
  backend: 'mempalace' | 'hindsight',
  mempalace: { model: 'minilm' | 'embeddinggemma' },
  hindsight: { url: string, bank: string }
}
```

Existing configs `{enabled, model}` auto-migrate to `backend: 'mempalace'` with the model preserved — no behavior change on upgrade.

## UI

Setup/Onboarding gain a backend picker with per-backend fields; Hindsight gets url + bank + a **Test connection** button (`/health` + bank stats, shows counts). One status chip driven by the unified `BackendStatus` for either backend — **status always comes from a read-back, never optimistic local state** (the C-02 lesson). The memory graph panel stays MemPalace-only in v1 and is hidden for Hindsight; Hindsight's `/banks/{bank}/graph` endpoint is a noted fast-follow.

## The shim

`hive/bin/hive-memory` — a small node script written at agent spawn beside `hive-node`. Verbs: `search "<q>" [--results N]`, `wake-up`. Routing reads `HIVE_MEMORY_BACKEND` plus the adapter's `agentEnv`, all injected at spawn:

- mempalace → exec the `mempalace` CLI; output unchanged from today.
- hindsight → `POST` recall; render plain readable text (title, snippet, score). Agents never see JSON or curl.
- Backend unreachable → print one line ("memory recall unavailable — continue without it") and **exit 0**. An agent's task never dies because memory is down.

Hive protocol prompt blocks stop naming mempalace and say only `hive-memory search` / `hive-memory wake-up`. Already-running agents keep working (with backend=mempalace the old commands still function); new text applies from next spawn.

## Degraded mode

- **Backend unavailable:** status chip says so (read-back); the mine loop idles with a cheap availability recheck each cadence; the shim prints its one-liner. Formalizes what mempalace-missing does today.
- **No buffering or queueing anywhere.** `memory.md` is the durable store; the next successful mine picks up current file state, so nothing is lost.
- **Switching backends mid-hive:** allowed and cheap — the new backend re-mines every `memory.md` from scratch. Index contents are not migrated in v1; anything condensed out of `memory.md` history is not re-mined. Documented limitation; acceptable because the substrate is the source of truth.
- `enabled: false` — markdown memory keeps working; everything else off (unchanged).

## Testing and rollout

Branch `feat/pluggable-memory`, four commits:

1. **Pure extraction** — interface + MemPalaceAdapter. Proof: the existing suite passes **untouched**; no test edits allowed in this commit.
2. **Shim + prompt text.** Shim e2e: spawn the real script per backend env; assert output and exit codes, including unavailable→0.
3. **HindsightAdapter + config + UI.** Unit tests against a stub HTTP server asserting request shapes (bank path, `items[]`, deterministic idempotent ids) and text rendering; house mutation rules (removal AND substitution). Plus an adapter **conformance suite**: one spec run against both adapters (mocked CLI / stub server) pinning the `MemoryBackend` contract — asserting effects, not proxies.
4. **Evidence** — a script in the house evidence format run against the live pilot: mine a real `memory.md` into a throwaway bank, search it back, wake-up returns text. That output is the PR evidence; this is the ship gate.

## Known limitations / future work

- Backend switch does not migrate index contents (re-mine covers it; condensed-away history is lost to the index).
- Hindsight `reflect` and the `/graph` panel: fast-follows, not v1.
- `listModels()`-style optional per-adapter capabilities (from the C-20 discussion) are out of scope here.
- API-key-mode and multi-tenant Hindsight (`/v1/{tenant}/…` beyond `default`) unexamined; pilot uses the `default` tenant.
