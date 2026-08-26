# Provider model catalog — dynamic-with-static-fallback (codex first)

## Problem

Every provider's selectable model list is hardcoded in
`src/renderer/src/store/config.ts` as a `ModelOption[]` (`CODEX_MODELS`,
`AGENT_MODELS`, `ANTIGRAVITY_MODELS`, … 13 arrays), consumed by
`modelsForProvider()`. Providers ship and retire models continuously, so these
lists go stale and are patched reactively — the codex slug alone has needed three
patch PRs (upstream #300, and fork #12 → upstream #330). A second, related
staleness source is `recommendedOrchestratorModel` per preset in
`src/shared/agentProvider.ts`: the single slug the app launches an agent with by
default. That is the one the patch PRs actually chase.

Most provider CLIs are installed on the user's machine and can report their own
current models. The `config.ts` comments already record the per-provider
source-of-truth command (`codex app-server` `model/list`; `agy models`;
`opencode models`; `grok models`; `cursor-agent models`; copilot `/model`).
`claude` has no catalog call; `qwen`/`gemini` are unverified. So the fix is not
"query everything" — it is a layer that queries where it can and falls back to
the curated static list where it cannot.

## Approach: hybrid, codex first

Ship the static lists as the guaranteed baseline (works offline, no CLI needed).
Add a per-provider **catalog adapter** that queries the live list where the CLI
supports it, surfaced behind an explicit **"Refresh models"** action in the
picker — no auto-query, no surprise latency or spend. Only codex is implemented
in this increment; the interface is designed so other providers slot in later
one at a time (which is also the only shape upstream accepts).

This mirrors the `MemoryBackend` adapter pattern already in the codebase.

## Scope of THIS increment (one upstream PR)

IN:
- The `ModelCatalogProvider` interface.
- A codex adapter that returns the live model list + the provider's own default.
- The `models:refresh` IPC and its registry lookup (`modelCatalogFor`).
- A "Refresh models" button in the model picker, shown only for providers that
  have an adapter; live results replace the static list for the session on
  success, static list is retained on failure with an inline error.

OUT (explicitly deferred, designed-for not built):
- Auto-resolving `recommendedOrchestratorModel` from the cached live default at
  spawn time. This is the change that would have prevented the patch PRs, but it
  is a distinct concern and a separate PR against the same adapter. Phase 2.
- Every non-codex adapter. Each is its own follow-up PR.
- Any automatic / on-open / on-start querying. Refresh is user-triggered only.

## Components

### `ModelCatalogProvider` (shared) — `src/shared/modelCatalog.ts` (new)

```ts
export interface ModelCatalogResult {
  models: ModelOption[];      // live catalog, same shape the picker already uses
  default?: string;           // the provider's own current default model id
}

export interface ModelCatalogProvider {
  /** Query the live catalog. Resolves null when the provider is unsupported or
   *  the query cannot run (CLI missing, not logged in, transport error). Never
   *  throws for an expected failure — null means "fall back to static". */
  queryModels(): Promise<ModelCatalogResult | null>;
}
```

The **pure parse/transform** — raw `model/list` response → `ModelCatalogResult`
— is exported as its own function (e.g. `parseCodexModelList(raw)`) so it is unit
testable without spawning codex. This is the same testability seam used by the
memory shim and the terminal link handler: the process/transport half needs the
real CLI and is covered by human evidence; the transform half is covered by
tests against a captured fixture.

### `CodexModelCatalog` (main) — `src/main/codexModelCatalog.ts` (new)

Spawns `codex app-server` over stdio and runs the JSON-RPC handshake
`initialize → initialized → model/list` (zero-spend, account-scoped — verified in
the C-20 research). Feeds the response to `parseCodexModelList`. Reuses the
existing per-agent `CODEX_HOME` / auth resolution already in `hive.ts` so the
query authenticates as the user. Returns null on spawn failure, non-zero exit,
timeout, or unparseable output.

### Registry — `modelCatalogFor(provider)` (main)

Returns the adapter for a provider or `undefined`. Codex only in this increment.

### IPC — `models:refresh`

`models:refresh(provider) → ModelCatalogResult | { error: string }`. Main runs
`modelCatalogFor(provider)?.queryModels()`; a null/throw becomes a plain-English
error string the picker shows. Renderer never receives a path or spawns anything.

### Renderer — the model picker

`modelsForProvider()` remains the static baseline and the fallback. The picker:
- shows a **"Refresh models"** control only when the provider has an adapter.
  The set of catalog-capable providers is exposed once through preload as a
  static array (`catalogCapableProviders`, `['codex']` for now) so the picker
  decides button visibility with no IPC round-trip;
- on click → `models:refresh` → on success, store the live `models` + `default`
  in the session store keyed by provider and render those (marking the default);
  on failure, keep the static list and show an inline, non-blocking error;
- caches per session — the live list persists until the app restarts or the user
  refreshes again. Not written to disk (a machine's catalog is machine- and
  login-specific and cheap to re-query).

Styling uses existing `--cth-*` design tokens; no new tokens.

## Data flow

```
picker (Refresh click)
  → window.cth.refreshModels(provider)            [preload]
  → models:refresh IPC                            [main]
  → modelCatalogFor(provider).queryModels()
     → CodexModelCatalog: spawn codex app-server, JSON-RPC model/list
     → parseCodexModelList(raw) → { models, default }
  ← ModelCatalogResult | { error }
  → store.setLiveModels(provider, result) | store.setModelError(provider, msg)
  → picker renders live list (default marked) OR static list + error
```

## Error handling

- Adapter returns `null` for every *expected* failure (no CLI, not logged in,
  timeout, bad output). The IPC turns null into a user-facing "Couldn't reach
  codex — showing the built-in list" style message. The picker stays usable on
  the static list throughout.
- A hard timeout (e.g. 10s) bounds the spawn so a hung CLI never wedges the UI.
- The static list is never removed or mutated; live results only *overlay* it in
  the session store.

## Testing

- `parseCodexModelList` against a captured real `model/list` response fixture:
  extracts the model ids/labels and the marked default; tolerates extra fields;
  returns null (or a typed empty) on a malformed/empty payload.
- IPC error path: `modelCatalogFor` unknown provider → error string, picker falls
  back (renderer-level test with a faked bridge, per the AskMeTab pattern).
- Picker: with the adapter returning null, the static list is what renders.
- The stdio handshake itself is NOT unit-tested (needs codex installed); it is
  covered by the human evidence capture below and named as such — no faked test
  that pretends to exercise the transport.

## Evidence (upstream, CI-enforced before/after)

UI + CLI change:
- **Before**: the model picker for a codex agent showing the static list, no
  Refresh control (or the control present but pre-click).
- **After**: click "Refresh models" → the picker shows the live account-scoped
  list with the current default marked; plus the `codex app-server model/list`
  handshake output pasted as terminal text.
Needs codex installed and logged in — captured by a human (Aaron). Flag at PR
time, do not discover it late.

## Branching / upstream

Cut from `fork/main` (fetch first). `git diff fork/main...HEAD --stat` must list
only the intended files — never CLAUDE.md or `docs/superpowers/`. Additive new
files preferred over reshaping `config.ts`. One provider (codex) = one PR, per
upstream's one-change rule.

## Phase 2 (not this PR, recorded so the interface serves it)

`recommendedOrchestratorModel` resolution: at spawn, when a cached live default
exists for the provider, prefer it over the static preset slug; else the static
slug. Same adapter, same `default` field — this is the change that retires the
patch-PR treadmill. Separate PR against the same interface.
