# Pluggable Memory Backends Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the semantic memory layer configurable behind a `MemoryBackend` interface, with MemPalace (default, behavior-identical) and Hindsight (HTTP) adapters and a backend-neutral `hive-memory` shim for agents.

**Architecture:** `MemoryManager` keeps the backend-neutral machinery (mine cadence, mtime skips, serialization, status caching) and delegates backend verbs to the active adapter. MemPalaceAdapter is today's code moved verbatim; HindsightAdapter is a small HTTP client against a Hindsight server. Agents call a spawn-written `hive/bin/hive-memory` script routed by env.

**Tech Stack:** TypeScript (Electron main), node:test (`.test.cjs` files, run via `npm run test:focused`), plain `node:http` for the Hindsight stub server in tests, `fetch` (Node ≥18 global) for the adapter.

**Spec:** `docs/superpowers/specs/2026-08-25-pluggable-memory-design.md` — read it first; every decision below is argued there.

## Global Constraints

- Branch: `feat/pluggable-memory` (fork-only; NEVER opened against upstream).
- Commit 1 must not touch any test file — the untouched suite passing IS its proof.
- MemPalace behavior must stay byte-identical through the whole plan (same CLI args, same env, same quarantine/backoff, same log lines).
- No buffering/queueing of memories anywhere: `memory.md` is the durable store.
- Shim failure mode: backend unreachable → print exactly one line and `exit 0`.
- All new claims in comments must be dated and scoped (house rule; see spec's Hindsight section).
- Tests must assert EFFECTS, not proxies; expect both removal- and substitution-mutation review in QA.
- Run before every commit: `npm run typecheck && npm run test:focused` (baseline 552 passing at this branch's base — always trust the branch-base count you measure over this number).

---

### Task 1: Pure extraction — `MemoryBackend` interface + `MemPalaceAdapter` (Commit 1)

**Files:**
- Create: `src/main/memoryBackend.ts`
- Create: `src/main/memPalaceAdapter.ts`
- Modify: `src/main/memory.ts` (shrinks to the neutral manager)
- Test: NONE — commit 1 may not touch tests.

**Interfaces:**
- Consumes: existing `palaceReap.ts` exports (`quarantineDirsToReap`, `quarantineStampMs`, `nextMineDelayMs`), `procKill.ensureKilled`.
- Produces (later tasks rely on these exact names):

```ts
// src/main/memoryBackend.ts
export type BackendId = 'mempalace' | 'hindsight';
export interface BackendStatus {
  backend: BackendId;
  available: boolean;   // CLI on PATH / server answered /health recently
  enabled: boolean;
  active: boolean;
  initialized: boolean; // palace dir exists / bank exists
  location: string | null; // palace path / `${url} · ${bank}`
  model: string | null;    // embedding model (mempalace) / null (hindsight)
  bin: string | null;      // CLI path (mempalace) / null (hindsight)
}
export interface MineResult { ok: boolean; backoffAdviceMs?: number }
export interface TextResult { ok: boolean; output: string; error?: string }
export interface MemoryBackend {
  readonly id: BackendId;
  available(): boolean;                 // sync, cached — matches today's bin() caching
  init(): void;                         // arm anything needed pre-mine (mempalace: boot reap)
  mineAgent(agentDir: string, agentId: string): Promise<MineResult>;
  search(q: string, opts: { agentId?: string; results?: number }): Promise<TextResult>;
  wakeUp(agentId?: string): Promise<TextResult>;
  status(enabled: boolean, home: string | null): BackendStatus;
  agentEnv(): Record<string, string>;   // injected into agent spawns
  resetCaches(): void;                  // today's resetBinCache
}
```

- [ ] **Step 1: Create `memoryBackend.ts`** with exactly the block above (plus a file-top comment pointing at the spec).

- [ ] **Step 2: Create `MemPalaceAdapter` by MOVING code out of `memory.ts`.** Move-map (source lines refer to current `src/main/memory.ts`):
  - `MINE_IGNORE_LINES` + `ensureMineIgnore` (22–46) → adapter (keep the hive.ts sync-comment verbatim; `test/mine-ignore-sync.test.cjs` greps both copies — the adapter file must keep the literal array so that test stays green; if it asserts the file path `memory.ts`, STOP: that means the sync test names files, and you must check what it matches before moving — do this check FIRST).
  - `EmbeddingModel`, `mempalaceDevice`, `MEMPALACE_DEVICE` (48, 81–111) → adapter, re-export `EmbeddingModel` and `mempalaceDevice` from `memory.ts` (`export { ... } from './memPalaceAdapter'`) so existing imports/tests resolve unchanged.
  - `bin()`, `resetBinCache()` (139–177) → adapter (`resetCaches()`).
  - `env()`/`childEnv()` (198–215) → adapter `agentEnv()`/private `childEnv()`; palace path comes via a `getPalacePath: () => string | null` constructor callback.
  - `reapPalace()` (334–360) → adapter; expose as `init()` (boot sweep) and fold the post-mine call into `mineAgent`'s return: `mineAgent` runs today's `mineAgent` (362–392) then `reapPalace()`, returning `{ ok, backoffAdviceMs: nextMineDelayMs(...) }` computed with the SAME constants (`MINE_INTERVAL_MS`, `MINE_BACKOFF_MAX_MS` move to the adapter; the manager just applies advice).
    NOTE an intentional, behavior-preserving nuance: today `reapPalace()` runs once per PASS (after all agents), not per agent. Preserve that: give the adapter a `postMinePass(): { backoffAdviceMs: number }` method instead of folding into `mineAgent`, and have the manager call it after each pass. Adjust the interface: add `postMinePass?(): { backoffAdviceMs: number }` (optional; hindsight omits it).
  - `runCli`, `search`, `wakeUp` (400–446) → adapter; `wing` param becomes `agentId`.
- `memory.ts` keeps: `MemorySettings`, `MemoryStatus` (unchanged shape, now derived from `BackendStatus` for compat), the mine loop (`start/stop/refresh/startMineLoop/mineNow`, mtime `lastMined` map, `mining` flag, `mineDelayMs`), constructing the adapter, and delegating `search/wakeUp/env/status/resetBinCache` to it. `status()` keeps returning today's `MemoryStatus` shape so `index.ts:3454/3483` and the renderer are untouched in this commit.

- [ ] **Step 3: Typecheck** — `npm run typecheck`, expect clean.

- [ ] **Step 4: Full suite untouched** — `npm run test:focused`. Expected: 553/553 pass with ZERO test-file edits. If any test fails, the extraction changed behavior — fix the extraction, never the test.

- [ ] **Step 5: Commit**

```bash
git add src/main/memoryBackend.ts src/main/memPalaceAdapter.ts src/main/memory.ts
git commit -m "refactor(memory): extract MemoryBackend interface and MemPalaceAdapter

Pure extraction. MemoryManager keeps the backend-neutral mine loop,
mtime tracking, and single-writer serialization; every mempalace-
specific behavior (bin discovery, env + device pin, quarantine backoff,
palace reaping, CLI search/wake-up) moves verbatim into the adapter.
No behavior change: the untouched test suite is the proof."
```

### Task 2: The `hive-memory` shim + prompt text (Commit 2)

**Files:**
- Create: `resources/hive-memory.cjs` (the shim source, shipped like hive-node's payload — find how `hive/bin/hive-node` gets written at spawn: `grep -rn "hive-node" src/main/hive.ts` and mirror that mechanism exactly)
- Modify: `src/main/hive.ts` (write `hive/bin/hive-memory` beside hive-node at spawn; swap prompt text at ~1302 and ~2524)
- Modify: `src/main/index.ts:2673` region only if needed to add `HIVE_MEMORY_BACKEND` to spawn env (preferred: include it in the adapter's `agentEnv()` — mempalace adds `HIVE_MEMORY_BACKEND=mempalace`, hindsight `=hindsight`)
- Test: `test/hive-memory-shim.test.cjs`

**Interfaces:**
- Consumes: `agentEnv()` from Task 1 (now also carrying `HIVE_MEMORY_BACKEND`).
- Produces: `hive/bin/hive-memory` CLI: `hive-memory search "<q>" [--results N]`, `hive-memory wake-up`. Exit 0 always except usage errors (exit 2 with usage on stderr).

- [ ] **Step 1: Write the failing test** (`test/hive-memory-shim.test.cjs`):

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const SHIM = require.resolve('../resources/hive-memory.cjs');

test('unknown backend prints the unavailable line and exits 0', () => {
  const out = execFileSync(process.execPath, [SHIM, 'search', 'anything'], {
    env: { ...process.env, HIVE_MEMORY_BACKEND: 'nonexistent' }, encoding: 'utf8'
  });
  assert.match(out, /memory recall unavailable — continue without it/);
});

test('hindsight backend renders recall hits as plain text', () => {
  // stub server started in-test on 127.0.0.1:0; see implementation step for the handler
  const http = require('node:http');
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && /\/memories\/recall$/.test(req.url)) {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ text: 'the fact', score: 0.91, metadata: { agent: 'pam' } }] }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const out = execFileSync(process.execPath, [SHIM, 'search', 'fact'], {
      env: { ...process.env, HIVE_MEMORY_BACKEND: 'hindsight',
             HINDSIGHT_URL: `http://127.0.0.1:${srv.address().port}`, HINDSIGHT_BANK: 'b1' },
      encoding: 'utf8'
    });
    assert.match(out, /the fact/);
    assert.match(out, /0\.91/);
    srv.close(); resolve();
  }));
});

test('mempalace backend execs the mempalace CLI with passthrough args', () => {
  // PATH is prefixed with a temp dir containing a fake `mempalace` that echoes its argv
  const { mkdtempSync, writeFileSync, chmodSync } = require('node:fs');
  const { join } = require('node:path');
  const dir = mkdtempSync(join(require('node:os').tmpdir(), 'shimtest-'));
  const fake = join(dir, 'mempalace');
  writeFileSync(fake, '#!/bin/sh\necho FAKE-MEMPALACE "$@"\n'); chmodSync(fake, 0o755);
  const out = execFileSync(process.execPath, [SHIM, 'search', 'q1', '--results', '3'], {
    env: { ...process.env, HIVE_MEMORY_BACKEND: 'mempalace', PATH: `${dir}:${process.env.PATH}` },
    encoding: 'utf8'
  });
  assert.match(out, /FAKE-MEMPALACE search q1 --results 3/);
});
```

- [ ] **Step 2: Run it** — `node --test test/hive-memory-shim.test.cjs`. Expected: FAIL (`Cannot find module '../resources/hive-memory.cjs'`).

- [ ] **Step 3: Write the shim** (`resources/hive-memory.cjs`). Requirements, all load-bearing:
  - argv: `search <query> [--results N]` | `wake-up`. Anything else → usage on stderr, exit 2.
  - `HIVE_MEMORY_BACKEND=mempalace` → `spawnSync('mempalace', [verb, ...args])` inheriting stdio (verb `wake-up` maps to `wake-up`; `search q --results N` passes through unchanged, `--wing` from `HIVE_MEMORY_AGENT` if set). If spawn fails (ENOENT) → the unavailable line, exit 0.
  - `HIVE_MEMORY_BACKEND=hindsight` → `fetch(`${HINDSIGHT_URL}/v1/default/banks/${HINDSIGHT_BANK}/memories/recall`, { method:'POST', body: JSON.stringify({ query, top_k: N }) })` with a 10s AbortController timeout; render each hit as `— <text>  (score <score>, <agent>)`; wake-up = recall with `query: 'recent important context'`, `top_k: 8`, filtered to `HIVE_MEMORY_AGENT` when set. Any network/HTTP error → the unavailable line, exit 0. (Verify the pilot's exact recall request/response field names against `~/code/hindsight-pilot/openapi.json` and `retain-bridge.py` BEFORE coding; adjust `top_k`/`results` names to what the API actually takes and mirror them in the Task 3 adapter.)
  - Anything else / unset → unavailable line, exit 0.
  - The unavailable line is EXACTLY: `memory recall unavailable — continue without it`
- [ ] **Step 4: Run the test** — expected: 3/3 PASS.
- [ ] **Step 5: Wire spawn + prompts.** In `hive.ts`: write `hive/bin/hive-memory` beside `hive-node` (same writer, mode 0755, content from `resources/hive-memory.cjs`). Replace the two prompt blocks (hive.ts:1302 and ~2524) so they name ONLY `hive-memory search "<query>"` and `hive-memory wake-up`. Keep the sentence structure; drop every `mempalace` mention. Then `grep -rn mempalace src/main/hive.ts` — expected: only the MINE_IGNORE sync comment remains (see Task 1 note).
- [ ] **Step 6: Verify + commit**

```bash
npm run typecheck && npm run test:focused && node --test test/hive-memory-shim.test.cjs
git add resources/hive-memory.cjs src/main/hive.ts src/main/index.ts src/main/memPalaceAdapter.ts test/hive-memory-shim.test.cjs
git commit -m "feat(memory): backend-neutral hive-memory shim; prompts stop naming mempalace"
```

### Task 3: `HindsightAdapter` (first half of Commit 3)

**Files:**
- Create: `src/main/hindsightAdapter.ts`
- Test: `test/hindsight-adapter.test.cjs` (loads TS via the existing `test/load-ts.cjs` helper — read how `test/` loads other main-process TS first and copy that pattern)

**Interfaces:**
- Consumes: `MemoryBackend`, `MineResult`, `TextResult`, `BackendStatus` from Task 1.
- Produces: `class HindsightAdapter implements MemoryBackend` with constructor `(cfg: () => { url: string; bank: string }, getHome: () => string | null)`.

- [ ] **Step 1: Write failing tests** — stub `node:http` server (pattern from Task 2), asserting EFFECTS:

```js
// shapes it must pin:
// 1) mineAgent posts to /v1/default/banks/<bank>/memories with items[] and
//    DETERMINISTIC ids: same file content -> same document id (run twice, capture both bodies, deepEqual).
// 2) mineAgent returns { ok: true } on 200 and { ok: false } on ECONNREFUSED (server closed) — no throw.
// 3) search posts to .../memories/recall and returns rendered text containing hit text + score.
// 4) wakeUp returns ok:true with text when the server answers, and ok:false with error when down.
// 5) available() flips false when /health stops answering (cache TTL <= 30s).
// 6) agentEnv() === { HIVE_MEMORY_BACKEND: 'hindsight', HINDSIGHT_URL: cfg.url, HINDSIGHT_BANK: cfg.bank }.
```

Write each as a real `node:test` case against the stub; capture request bodies in the stub and assert on them (`assert.deepEqual(seen.path, '/v1/default/banks/b1/memories')` etc.).
- [ ] **Step 2: Run to fail** — module not found.
- [ ] **Step 3: Implement.** Mine = read `<agentDir>/memory.md`, split into sections on `^## ` headings, one item per section: `{ id: sha256(agentId + heading + body).slice(0,32), text: body, metadata: { agent: agentId, source: 'memory.md', heading } }`, POST with `async:false` (verify field name against openapi.json). Timeout: reuse the manager's mine timeout by racing an AbortController at 10 min. `search`/`wakeUp` per the shim's Task 3 shapes (same rendering helper — put `renderRecall(results): string` in the adapter and have the shim duplicate it deliberately: the shim is a standalone script and must not import app code; note this duplication in a comment on both sides). No `postMinePass` (mempalace-only). `init()` = ensure bank exists (GET bank stats; on 404 POST create if the API supports it — otherwise document that the bank must pre-exist and make `available()` false with a status detail when missing).
- [ ] **Step 4: Run tests green.** `node --test test/hindsight-adapter.test.cjs`.
- [ ] **Step 5: NO commit yet** — Commit 3 lands after Task 5.

### Task 4: Config, migration, backend selection (second half of Commit 3)

**Files:**
- Modify: `src/main/config.ts` (find `MemorySettings` persistence — grep `memory` in it), `src/main/memory.ts` (adapter selection), `src/main/index.ts:304` (constructor args if they change)
- Test: `test/memory-config-migration.test.cjs`

**Interfaces:**
- Produces: `MemorySettings` becomes `{ enabled: boolean; backend: 'mempalace'|'hindsight'; mempalace: { model: EmbeddingModel }; hindsight: { url: string; bank: string } }` with `migrateMemorySettings(old: unknown): MemorySettings` exported from `config.ts`.

- [ ] **Step 1: Failing tests** for migration, three cases:

```js
// {enabled:true, model:'minilm'}            -> {enabled:true, backend:'mempalace', mempalace:{model:'minilm'}, hindsight:{url:'http://127.0.0.1:8888', bank:'hive-memory'}}
// already-new shape                          -> returned unchanged (idempotent)
// undefined/garbage                          -> safe defaults (enabled:false, backend:'mempalace')
```

- [ ] **Step 2: Fail, implement `migrateMemorySettings`, pass.** Call it at the single point config is loaded (find where the config file is read and parsed; migration runs there, and the migrated shape is what gets persisted on next save).
- [ ] **Step 3: Backend selection in `MemoryManager`:** construct the adapter from `settings.backend` once at start; `refresh()` re-reads the setting and swaps the adapter if it changed (drop `lastMined` so the new backend re-mines everything — this implements the spec's "switch = re-mine from scratch"). Write a test: manager with backend swapped via settings stub re-mines an agent it had already mined (assert the stub adapter's `mineAgent` called again after swap).
- [ ] **Step 4: Suite green; no commit yet.**

### Task 5: Setup/Onboarding UI (completes Commit 3)

**Files:**
- Modify: `src/renderer/src/components/SetupPanel.tsx` and `OnboardingWizard.tsx` (find the existing memory section: `grep -n mempalace src/renderer/src/components/SetupPanel.tsx`)
- Test: extend `test/` only if a renderer test harness already exists for these panels (`grep -rl SetupPanel test/`); otherwise UI is covered by the evidence script + typecheck (state this in the commit body honestly).

**Interfaces:**
- Consumes: the `hive:memoryStatus` IPC (now returning `MemoryStatus` derived from `BackendStatus` — extend the payload with `backend: BackendId` and `location`), a new `hive:memoryTestConnection` IPC handler added in `index.ts` near :3483: `(url, bank) => hindsight /health + bank stats` returning `{ ok, detail }`.

- [ ] **Step 1:** Add the IPC handler in `index.ts` (main): try `fetch(url + '/health')` then `fetch(url + '/v1/default/banks/' + bank + '/stats')`, 5s timeout, return `{ ok, detail: '<n> memories' | error text }`. Never throws.
- [ ] **Step 2:** UI: radio/select for backend; mempalace shows today's fields unchanged; hindsight shows url + bank inputs and a "Test connection" button calling the IPC and rendering `detail` — result comes from the IPC READ-BACK, never local state (spec: the C-02 rule). Status chip renders from `hive:memoryStatus` polling exactly as today, plus the backend label. Match the file's existing component and styling idioms — copy a neighboring field's markup rather than inventing structure.
- [ ] **Step 3:** `npm run typecheck && npm run build` green.
- [ ] **Step 4: Commit 3**

```bash
git add src/main/hindsightAdapter.ts src/main/config.ts src/main/memory.ts src/main/index.ts \
        src/renderer/src/components/SetupPanel.tsx src/renderer/src/components/OnboardingWizard.tsx \
        test/hindsight-adapter.test.cjs test/memory-config-migration.test.cjs
git commit -m "feat(memory): Hindsight backend — adapter, config migration, backend picker"
```

### Task 6: Conformance suite + live evidence script (Commit 4)

**Files:**
- Create: `test/memory-backend-conformance.test.cjs`
- Create: `hive/evidence/c21-memory-backend-evidence.sh` (NOT committed to the repo — it lives in the hive; the repo gets only the conformance test)

**Interfaces:** consumes both adapters + a fake-CLI dir (Task 2's pattern) and stub server (Task 3's pattern).

- [ ] **Step 1: Conformance test** — one parametrized spec run over `[mempalaceAdapterUnderFakeCli, hindsightAdapterUnderStub]` asserting the CONTRACT: `mineAgent` ok:true on healthy backend and ok:false (no throw) on broken one; `search` returns `TextResult` with non-empty output for a seeded hit; `wakeUp` same; `agentEnv()` contains `HIVE_MEMORY_BACKEND` = adapter id; `status(...)` has `backend` = id and never throws with home=null. Each assertion runs against BOTH adapters via `for (const make of cases) test(...)`.
- [ ] **Step 2: Green**, then **Commit 4** (`test: memory backend conformance suite`).
- [ ] **Step 3: Evidence script** (house format, hive/evidence/): `before` mode = current released behavior label optional — this feature has no "bug", so the script has modes `mempalace` and `hindsight`: each prints TREE/REF/STEPS, then against the LIVE pilot (hindsight mode; `HINDSIGHT_URL=http://localhost:8888`, throwaway bank `c21-evidence-<user>-<pid>`): mine a real fixture memory.md, recall it back, wake-up, print EXPECTED/ACTUAL/VERDICT (`BACKEND VERIFIED`), delete the throwaway bank. Run both modes end-to-end yourself before reporting done.
- [ ] **Step 4:** Report to god with: suite counts, conformance output, both evidence blocks.

## Self-review notes (already applied)

- Spec coverage: interface (T1), adapters (T1/T3), shim+prompts (T2), config+migration+switch-re-mine (T4), UI+test-connection+read-back (T5), degraded mode (T2 exit-0 + T3 ok:false cases + T4 swap), testing+evidence (T6). Graph panel: explicitly v1-hidden — no task, matches spec.
- The `postMinePass` nuance in T1 amends the spec's `backoffAdviceMs`-on-`mineAgent` sketch to preserve per-PASS reaping; the interface in T1 is the authoritative shape.
- Field-name uncertainty (recall `top_k` vs `results`, retain `async`) is called out in T2/T3 with the instruction to verify against the pilot's openapi.json before coding — do not skip it.
