# Provider Model Catalog Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the model picker show a codex agent's live, account-scoped model list (with the provider's own default) on demand, falling back to the curated static list.

**Architecture:** A `ModelCatalogProvider` adapter interface (shared) with one codex implementation (main process) that spawns `codex app-server` and runs the zero-spend `model/list` JSON-RPC call. A `models:refresh` IPC exposes it; the picker gains a "Refresh models" button that overlays live results onto the static baseline for the session. The raw→typed parse is a pure exported function — the unit-tested seam — so no test needs codex installed.

**Tech Stack:** TypeScript, Electron (main + preload + renderer), zustand store, `node:test` via `test/*.test.cjs` (loads `.ts` through `test/load-ts.cjs`, `@shared/` alias resolves to `src/shared/`).

**Spec:** `docs/superpowers/specs/2026-08-26-provider-model-catalog-design.md`

## Global Constraints

- Cut the branch from `fork/main` (fetch first: `git fetch fork main`); baseline ref is `ae758064`.
- `git diff fork/main...HEAD --stat` must list ONLY intended files — never `CLAUDE.md` or `docs/superpowers/`.
- Prefer new additive files over reshaping `config.ts`. Surgical, upstreamable.
- Verification gates: `npm run typecheck` (node+web, 0 errors), `npm run test:focused`, `npm run build`. Report counts as "N of M" measured on `ae758064` before any change.
- New/changed UI derives from existing `--cth-*` design tokens; do not add tokens.
- Codex only. `catalogCapableProviders = ['codex']`. Do not implement other providers.
- `recommendedOrchestratorModel` auto-resolution is OUT of scope (spec phase 2).
- Commit messages: stranger-readable, symptom/why → what; no internal ids, no agent names.

---

### Task 1: `ModelCatalogProvider` interface + `parseCodexModelList` (pure, fully tested)

**Files:**
- Create: `src/shared/modelCatalog.ts`
- Test: `test/model-catalog.test.cjs`

**Interfaces:**
- Consumes: `ModelOption` from `src/renderer/src/store/config.ts` — but to avoid a shared→renderer import, re-declare the minimal shape locally: `{ id?: string; label: string }`. (config.ts already defines `ModelOption` identically; keep them structurally equal.)
- Produces:
  - `interface ModelCatalogResult { models: ModelOption[]; default?: string }`
  - `interface ModelCatalogProvider { queryModels(): Promise<ModelCatalogResult | null> }`
  - `function parseCodexModelList(raw: unknown): ModelCatalogResult | null`

- [ ] **Step 1: Write the failing test** — capture the real `model/list` response shape. The codex `app-server` `model/list` result is `{ models: [{ id, displayName?, default? }, ...] }` (ids like `gpt-5.6-sol`; one entry may carry `default: true`). Assert parse extracts ids→`ModelOption`, prefers `displayName` for the label else the id, and surfaces the default id.

```js
// test/model-catalog.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseCodexModelList } = require('./load-ts.cjs')('@shared/modelCatalog');

test('parses codex model/list into options plus the marked default', () => {
  const raw = { models: [
    { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', default: true },
    { id: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna' },
  ]};
  const out = parseCodexModelList(raw);
  assert.deepEqual(out.models, [
    { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    { id: 'gpt-5.6-luna', label: 'gpt-5.6-luna' },
  ]);
  assert.equal(out.default, 'gpt-5.6-sol');
});

test('returns null for a malformed or empty payload', () => {
  assert.equal(parseCodexModelList(null), null);
  assert.equal(parseCodexModelList({}), null);
  assert.equal(parseCodexModelList({ models: [] }), null);
  assert.equal(parseCodexModelList({ models: [{ noId: 1 }] }), null);
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/model-catalog.test.cjs`. Expected: FAIL — cannot resolve `@shared/modelCatalog`.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/shared/modelCatalog.ts
/** One selectable model. Structurally identical to config.ts's ModelOption;
 *  redeclared here so this shared module has no renderer dependency. */
export interface ModelOption {
  id?: string;
  label: string;
}

export interface ModelCatalogResult {
  models: ModelOption[];
  /** The provider's own current default model id, when it reports one. */
  default?: string;
}

export interface ModelCatalogProvider {
  /** Live catalog, or null when unsupported/unavailable (caller falls back to
   *  the static list). Never throws for an expected failure. */
  queryModels(): Promise<ModelCatalogResult | null>;
}

interface RawCodexModel { id?: unknown; displayName?: unknown; default?: unknown }

/** Map a codex `model/list` result to a catalog. Returns null on any payload
 *  that yields no usable model — the signal to fall back to the static list. */
export function parseCodexModelList(raw: unknown): ModelCatalogResult | null {
  const list = (raw as { models?: unknown })?.models;
  if (!Array.isArray(list)) return null;
  const models: ModelOption[] = [];
  let dflt: string | undefined;
  for (const m of list as RawCodexModel[]) {
    if (typeof m?.id !== 'string' || m.id.length === 0) continue;
    const label = typeof m.displayName === 'string' && m.displayName.length > 0 ? m.displayName : m.id;
    models.push({ id: m.id, label });
    if (m.default === true) dflt = m.id;
  }
  if (models.length === 0) return null;
  return dflt ? { models, default: dflt } : { models };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/model-catalog.test.cjs`. Expected: PASS (2 tests).

- [ ] **Step 5: Break-it check** — temporarily change `m.default === true` to `false`; re-run; the default assertion goes red. Revert to green.

- [ ] **Step 6: Commit**

```bash
git add src/shared/modelCatalog.ts test/model-catalog.test.cjs
git commit -m "feat: parse a codex model/list response into a picker catalog

Adds the ModelCatalogProvider interface and the pure parse function that
turns codex app-server's model/list result into the picker's ModelOption
list plus the provider's own default. Kept pure and shared so it is unit
tested without the codex CLI."
```

---

### Task 2: `CodexModelCatalog` adapter (spawns `codex app-server`)

**Files:**
- Create: `src/main/codexModelCatalog.ts`
- Test: `test/codex-model-catalog.test.cjs`

**Interfaces:**
- Consumes: `parseCodexModelList`, `ModelCatalogProvider`, `ModelCatalogResult` from `@shared/modelCatalog`.
- Produces:
  - `type CodexRunner = (env: NodeJS.ProcessEnv) => Promise<unknown>` — runs the `model/list` handshake and resolves the raw `model/list` result object (injectable so tests need no codex).
  - `function createCodexModelCatalog(runner?: CodexRunner, env?: NodeJS.ProcessEnv): ModelCatalogProvider`
  - `const defaultCodexRunner: CodexRunner` — the real stdio handshake.

Design note: keep the JSON-RPC/stdio transport inside `defaultCodexRunner` and make the adapter depend only on the injectable `CodexRunner`. The adapter's job is: call the runner, feed the result to `parseCodexModelList`, and convert *any* throw/timeout/null into `null`. That contract is what the test pins; the real transport is covered by the human evidence capture (needs codex installed), never by a fake test that pretends to spawn.

- [ ] **Step 1: Write the failing test** — inject a runner. Assert: a good raw response → parsed catalog; a runner that throws → `null`; a runner that returns junk → `null`.

```js
// test/codex-model-catalog.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createCodexModelCatalog } = require('./load-ts.cjs')('../src/main/codexModelCatalog');

test('adapter maps a live model/list result', async () => {
  const runner = async () => ({ models: [{ id: 'gpt-5.6-sol', default: true }] });
  const out = await createCodexModelCatalog(runner, {}).queryModels();
  assert.deepEqual(out, { models: [{ id: 'gpt-5.6-sol', label: 'gpt-5.6-sol' }], default: 'gpt-5.6-sol' });
});

test('a runner failure resolves to null, never throws', async () => {
  const boom = async () => { throw new Error('codex not found'); };
  assert.equal(await createCodexModelCatalog(boom, {}).queryModels(), null);
});

test('an unparseable result resolves to null', async () => {
  const junk = async () => ({ nope: true });
  assert.equal(await createCodexModelCatalog(junk, {}).queryModels(), null);
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/codex-model-catalog.test.cjs`. Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation** — the real runner does the stdio JSON-RPC handshake; read an existing codex `app-server` invocation in `src/main/hive.ts` for the exact spawn/env/socket conventions (search `app-server`) and reuse the per-agent `CODEX_HOME`/auth resolution so the query authenticates as the user. Wrap the whole thing in a 10s timeout.

```ts
// src/main/codexModelCatalog.ts
import { spawn } from 'node:child_process';
import { parseCodexModelList, type ModelCatalogProvider, type ModelCatalogResult } from '@shared/modelCatalog';

export type CodexRunner = (env: NodeJS.ProcessEnv) => Promise<unknown>;

const TIMEOUT_MS = 10_000;

/** Real transport: `codex app-server`, JSON-RPC initialize→initialized→model/list
 *  over stdio, resolve the model/list `result`. Resolves-or-rejects; the adapter
 *  turns a rejection into null. (Handshake framing mirrors the existing
 *  app-server usage in hive.ts — reuse its env/CODEX_HOME setup.) */
export const defaultCodexRunner: CodexRunner = (env) => new Promise((resolve, reject) => {
  const child = spawn('codex', ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  const timer = setTimeout(() => { child.kill(); reject(new Error('codex model/list timed out')); }, TIMEOUT_MS);
  let buf = '';
  const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
  child.on('error', (e) => { clearTimeout(timer); reject(e); });
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg: any; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id === 1) { send({ jsonrpc: '2.0', method: 'initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'model/list' }); }
      else if (msg.id === 2) { clearTimeout(timer); child.kill(); resolve(msg.result); }
    }
  });
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
});

/** Adapter: run the query, parse it, and turn EVERY failure into null. */
export function createCodexModelCatalog(
  runner: CodexRunner = defaultCodexRunner,
  env: NodeJS.ProcessEnv = process.env,
): ModelCatalogProvider {
  return {
    async queryModels(): Promise<ModelCatalogResult | null> {
      try { return parseCodexModelList(await runner(env)); }
      catch { return null; }
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/codex-model-catalog.test.cjs`. Expected: PASS (3 tests).

- [ ] **Step 5: Break-it check** — remove the `try/catch` in `queryModels`; the "runner failure resolves to null" test throws instead of asserting null → red. Restore.

- [ ] **Step 6: Verify the handshake framing against a real codex** — this step needs codex installed; if unavailable in the worker environment, SAY SO and defer it to the evidence capture. Do NOT fake it. Note the exact `hive.ts` line you mirrored for the env/spawn.

- [ ] **Step 7: Commit**

```bash
git add src/main/codexModelCatalog.ts test/codex-model-catalog.test.cjs
git commit -m "feat: query a codex agent's live model catalog

Spawns codex app-server and runs the zero-spend model/list call, mapping
the result through the shared parser. Every failure resolves to null so the
caller falls back to the built-in list. Transport is injectable; the adapter
contract is unit tested without the CLI."
```

---

### Task 3: Registry + `models:refresh` IPC + preload + capability list

**Files:**
- Create: `src/main/modelCatalogRegistry.ts`
- Modify: `src/main/index.ts` (register the IPC near the other `ipcMain.handle` calls, ~line 2174+)
- Modify: `src/preload/index.ts` (expose `refreshModels`; add `catalogCapableProviders`)
- Test: `test/model-catalog-registry.test.cjs`

**Interfaces:**
- Consumes: `createCodexModelCatalog` (Task 2); `ModelCatalogResult`, `ModelCatalogProvider` (Task 1).
- Produces:
  - `const CATALOG_CAPABLE_PROVIDERS = ['codex'] as const`
  - `function modelCatalogFor(provider: string): ModelCatalogProvider | undefined`
  - `function refreshModels(provider: string): Promise<ModelCatalogResult | { error: string }>` — the IPC body; unknown/unsupported provider or null result → `{ error }`.
  - preload: `window.cth.refreshModels(provider)` and `window.cth.catalogCapableProviders`.

- [ ] **Step 1: Write the failing test** — pure `refreshModels`/`modelCatalogFor`, no Electron.

```js
// test/model-catalog-registry.test.cjs
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { modelCatalogFor, refreshModels, CATALOG_CAPABLE_PROVIDERS } =
  require('./load-ts.cjs')('../src/main/modelCatalogRegistry');

test('only codex has an adapter', () => {
  assert.ok(modelCatalogFor('codex'));
  assert.equal(modelCatalogFor('claude'), undefined);
  assert.deepEqual([...CATALOG_CAPABLE_PROVIDERS], ['codex']);
});

test('refreshModels returns an error string for an unsupported provider', async () => {
  const r = await refreshModels('claude');
  assert.ok('error' in r && typeof r.error === 'string');
});
```

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/model-catalog-registry.test.cjs`. Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// src/main/modelCatalogRegistry.ts
import { createCodexModelCatalog } from './codexModelCatalog';
import type { ModelCatalogProvider, ModelCatalogResult } from '@shared/modelCatalog';

export const CATALOG_CAPABLE_PROVIDERS = ['codex'] as const;

export function modelCatalogFor(provider: string): ModelCatalogProvider | undefined {
  if (provider === 'codex') return createCodexModelCatalog();
  return undefined;
}

/** IPC body: live catalog, or a user-facing error string on any failure. */
export async function refreshModels(provider: string): Promise<ModelCatalogResult | { error: string }> {
  const adapter = modelCatalogFor(provider);
  if (!adapter) return { error: `Live model list isn't available for ${provider}.` };
  const result = await adapter.queryModels();
  if (!result) return { error: `Couldn't reach ${provider} — showing the built-in list.` };
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes** — Run: `node --test test/model-catalog-registry.test.cjs`. Expected: PASS (2 tests).

- [ ] **Step 5: Wire the IPC** — in `src/main/index.ts`, next to a sibling `ipcMain.handle`:

```ts
import { refreshModels } from './modelCatalogRegistry';
// ...
ipcMain.handle('models:refresh', (_evt, provider: string) => refreshModels(provider));
```

- [ ] **Step 6: Wire preload** — in `src/preload/index.ts`, add to the `cth` api object (mirror the `pty:*` `invoke` style) and export the capability list:

```ts
import { CATALOG_CAPABLE_PROVIDERS } from '../main/modelCatalogRegistry';
// inside the api object:
refreshModels: (provider: string) => ipcRenderer.invoke('models:refresh', provider),
catalogCapableProviders: [...CATALOG_CAPABLE_PROVIDERS],
```
If importing from `../main` into preload violates the build boundary (check how existing shared constants reach preload), instead inline the literal `['codex']` in preload with a one-line comment pointing at `modelCatalogRegistry.ts` as the source of truth. Confirm which by building.

- [ ] **Step 7: Verify** — Run: `npm run typecheck` (0 errors) and `node --test test/model-catalog-registry.test.cjs` (PASS).

- [ ] **Step 8: Commit**

```bash
git add src/main/modelCatalogRegistry.ts src/main/index.ts src/preload/index.ts test/model-catalog-registry.test.cjs
git commit -m "feat: expose a models:refresh IPC backed by the codex catalog

Adds the provider→adapter registry and the IPC the picker calls to refresh
its list, returning a plain error string on any failure so the renderer can
fall back to the built-in list. Only codex has an adapter today."
```

---

### Task 4: Picker "Refresh models" button + session overlay + fallback

**Files:**
- Modify: `src/renderer/src/store/store.ts` (session-only live-catalog slice)
- Modify: `src/renderer/src/components/AddAgentModal.tsx` (the add-agent picker: button + overlay + error line)
- Test: `test/model-catalog-picker.test.cjs`

**Interfaces:**
- Consumes: `window.cth.refreshModels`, `window.cth.catalogCapableProviders` (Task 3); `modelsForProvider` from `config.ts` (static baseline).
- Produces: store actions `setLiveModels(provider, result)` / `setModelError(provider, msg)` and selector `liveModelsFor(provider)`; a picker that renders live results when present, static otherwise.

Design note: the picker's effective list is `liveModelsFor(provider) ?? modelsForProvider(provider)`. Follow the AskMeTab renderer-test pattern (mounted component + faked `window.cth` bridge) that `test/render-hooks.cjs` + `test/load-ts.cjs` already enable — reuse that harness; do not add a new one.

- [ ] **Step 1: Write the failing test** — mount the picker with a faked bridge; assert (a) with no live data the static list renders and the Refresh button shows for codex; (b) after a successful `refreshModels`, the live labels render; (c) on an `{error}` result the static list stays and the error text shows.

```js
// test/model-catalog-picker.test.cjs — follow test/ask-me-attachments.test.cjs for the mount+bridge scaffold
'use strict';
const test = require('node:test');
const assert = require('node:assert');
// ... reuse the AskMeTab-style harness: fake window.cth.refreshModels, render AddAgentModal
// with provider='codex', click the Refresh control, flush promises, read the rendered options.
test('refresh overlays the live list; failure keeps the static list', async () => {
  // arrange fake bridge: first a success {models:[{id:'x',label:'X'}],default:'x'}, assert 'X' appears;
  // then an {error:'nope'} path on a second mount, assert a known STATIC codex label still appears + 'nope' shown.
  assert.ok(true); // replace with real DOM assertions per the AskMeTab harness
});
```
Replace the placeholder body with real DOM assertions modeled on `test/ask-me-attachments.test.cjs` — the worker MUST write concrete assertions here (mount, click, flush, read options), not ship this stub.

- [ ] **Step 2: Run test to verify it fails** — Run: `node --test test/model-catalog-picker.test.cjs`. Expected: FAIL (assertions on unrendered button/options).

- [ ] **Step 3: Add the store slice** — in `store.ts`, add session-only state (not persisted):

```ts
liveModels: {} as Record<string, { models: import('@/store/config').ModelOption[]; default?: string }>,
modelErrors: {} as Record<string, string>,
setLiveModels: (provider, result) => set((s) => ({
  liveModels: { ...s.liveModels, [provider]: result },
  modelErrors: { ...s.modelErrors, [provider]: '' },
})),
setModelError: (provider, msg) => set((s) => ({ modelErrors: { ...s.modelErrors, [provider]: msg } })),
```

- [ ] **Step 4: Add the button + overlay in AddAgentModal** — where `modelsForProvider(provider)` is used (~line 913), compute the effective list and render a Refresh control gated on capability:

```tsx
const live = useStore((s) => s.liveModels[provider]);
const modelError = useStore((s) => s.modelErrors[provider]);
const options = live?.models ?? modelsForProvider(provider);
const canRefresh = window.cth.catalogCapableProviders.includes(provider);
// ...render options from `options`, marking `live?.default` when present...
// {canRefresh && <PixelButton onClick={onRefresh}>Refresh models</PixelButton>}
// {modelError && <span className="...token-driven error...">{modelError}</span>}
async function onRefresh() {
  const r = await window.cth.refreshModels(provider);
  if ('error' in r) setModelError(provider, r.error);
  else setLiveModels(provider, r);
}
```
Styling uses existing `--cth-*` tokens and the existing `PixelButton` (match a sibling secondary button in this file). No new tokens.

- [ ] **Step 5: Run test to verify it passes** — Run: `node --test test/model-catalog-picker.test.cjs`. Expected: PASS.

- [ ] **Step 6: Break-it check** — change `options = live?.models ?? modelsForProvider(provider)` to always use `modelsForProvider(provider)`; the "live labels render" assertion goes red. Restore.

- [ ] **Step 7: Full verification** — Run: `npm run typecheck` (0), `npm run test:focused` (report N of M vs the `ae758064` baseline), `npm run build` (succeeds).

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/store/store.ts src/renderer/src/components/AddAgentModal.tsx test/model-catalog-picker.test.cjs
git commit -m "feat: add a Refresh-models button to the codex model picker

The picker shows the built-in list by default and, for providers with a
live catalog (codex today), a Refresh button that overlays the account's
current models and marks the provider default. On any failure the built-in
list stays and an inline note explains why."
```

---

## Evidence (capture at PR time — needs codex installed + logged in)

Bug/feature is UI + CLI. Under CONTRIBUTING's table this is a visual change → the same view twice, plus the CLI output:
- **Before:** the codex model picker showing the built-in list (Refresh button present, pre-click).
- **After:** click "Refresh models" → the picker shows the live account-scoped list with the current default marked.
- **CLI:** paste the `codex app-server` `model/list` handshake output as terminal text.
Flag at PR open that a human with codex must capture this; do not discover it late.

## Handoff notes

- One PR, codex only. `git diff fork/main...HEAD --stat` should list exactly: `src/shared/modelCatalog.ts`, `src/main/codexModelCatalog.ts`, `src/main/modelCatalogRegistry.ts`, `src/main/index.ts`, `src/preload/index.ts`, `src/renderer/src/store/store.ts`, `src/renderer/src/components/AddAgentModal.tsx`, and the four `test/*.test.cjs` files.
- Two seams need a real codex and are therefore covered by evidence, not tests: the `defaultCodexRunner` handshake framing (Task 2 Step 6) and the end-to-end picker refresh (evidence). Name them honestly in the PR.
