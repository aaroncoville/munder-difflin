# T-057 — adversarial security review: the MCP consent toggle

**Reviewer:** creed-t057sec (worker-t057-sec)
**Subject:** `agent/worker-t057-qa-tests` @ `dfb25335` (branched from `955dddaf`)
**Scope of the change reviewed:** `955dddaf..dfb25335` — 2 source files, 5 test files.
**Date:** 2026-08-24

## Recommendation

> ## SHIP AS-IS
>
> No HIGH and no MEDIUM finding. The change is strictly safer than what it replaces,
> and the failure mode god asked me to hunt for — **UI shows OFF while the spawn path
> ARMS the server** — is not merely absent, it is *structurally impossible* while both
> readers read the same map. Three LOW / defense-in-depth items are recorded below as
> follow-ups; none of them blocks this change, and two of them pre-date it.

## Verdict on god's thesis: **REFUTED**

The thesis was that `resolveEnabledFor` (renderer) and `buildDefaultMcpServers` (main)
are two independent implementations of "is this server enabled" that could disagree,
and that a disagreement in the direction *UI-off / armed-on* would be a server running
without consent that the human cannot see.

They are indeed two implementations. **They cannot disagree in the dangerous direction**,
and the reason is not the catalog contents — it is the shape of the two expressions.

```
UI    on(id)    = truthy( cfg[id]?.enabled  ??  defaultEnabled(id) )

MAIN  armed(id) = truthy( cfg[id]?.enabled  ??  defaultEnabled(id) )        # identical
                  AND ( tier(id) === 'safe-readonly' OR cfg[id]?.enabled === true )
```

`armed(id) = on(id) ∧ extra(id)`. Main's decision is the UI's decision **conjoined with
an additional restriction**. Main's armed-set is therefore a *subset* of the UI's on-set,
for every catalog, every tier, and every value that can appear on disk:

> **armed(id) ⟹ on(id).** A server cannot be armed unless the panel is showing it ON.

The reverse — UI ON while nothing is armed — is possible (see Probe 1) and is the benign
direction god correctly identified as "merely annoying".

This is the shared invariant that forces agreement, and it is worth stating plainly
because it is *stronger* than the invariant one might expect to be doing the work. It
does **not** depend on `defaultEnabled === (tier === 'safe-readonly')`. I poisoned that
invariant deliberately (Probe 2b) and main still refused to arm. The safety rests on the
`consented !== true` gate at `hive.ts:1110`, which is load-bearing, not decorative.

The whole risk therefore collapses to one question: **do the two sides read the same map?**
Probes 2, 3 and 4 are exactly the three places where they might not.

---

## Probe 1 — can the UI's answer and main's answer differ? (enumerated, not spot-checked)

Method: loaded the real `resolveEnabledFor` and the real
`HiveManager.prototype.buildDefaultMcpServers` (private is erased at runtime; reached the
actual method rather than restating its rules) and enumerated **every catalog entry × 8
stored states** = 88 combinations, comparing the UI's boolean against whether
`munder-<id>` actually appears in the armed map.

States covered: absent, `{enabled:true}`, `{enabled:false}`, `{enabled:null}`,
`{enabled:0}`, `{enabled:'yes'}`, `{}` (no `enabled` key), `{enabled:1}`.

```
CATALOG entries: 11 | invariant defaultEnabled<=>safe-readonly violations: 0
combinations tested: 88 | divergences: 10
```

**All 33 combinations reachable through the application** (11 entries × {absent, true,
false} — the only three states the toggle can write) **diverge zero times.**

The 10 divergences all require a hand-edited `config.json` holding a non-boolean, and
every one is the benign direction:

| id | tier | stored value | UI | armed | direction |
|---|---|---|---|---|---|
| `github-token` | secret | `'yes'` / `1` | ON | **not armed** | benign |
| `db` | secret | `'yes'` / `1` | ON | **not armed** | benign |
| `email-calendar` | secret | `'yes'` / `1` | ON | **not armed** | benign |
| `search-with-key` | secret | `'yes'` / `1` | ON | **not armed** | benign |
| `hive-memory` | write | `'yes'` / `1` | ON | **not armed** | benign |

There is no row in the other direction, and by the algebra above there cannot be.
Note what these rows actually show: they are the `consented !== true` gate *firing*.
A truthy-but-not-`true` value is enough for the UI but not for main — main is stricter,
which is the correct asymmetry for a consent control.

A further property worth recording: **the catalog is the allowlist; `mcpDefaults` is only
a filter over it.** `buildDefaultMcpServers` iterates `MCP_CATALOG` and looks each id up
in the config map — it never iterates the config map. An arbitrary key hand-written into
`mcpDefaults` (`{"evil-server":{"enabled":true}}`) is silently ignored. No config edit can
introduce a server that is not in the catalog.

## Probe 2 — the partial-map case (`{ ...DEFAULTS, ...parsed }`, one level deep)

`readConfig` (`src/main/config.ts:586-599`) spreads one level, so a partial stored
`mcpDefaults` **replaces** the 11-entry default map wholesale. QA's two claims, verified
independently:

**Half A — "can never arm a server": CONFIRMED.**
With only `{'hive-memory':{enabled:true}}` on disk, the armed set is:

```
munder-context7, munder-fetch, munder-filesystem, munder-git,
munder-hive-memory, munder-sequential-thinking, munder-time
```

The six safe-readonly servers (which were ON by default anyway) plus `hive-memory`,
which is armed only because of the explicit human `true`. No write/secret server is armed.

**Half B — "does discard an explicit opt-out": CONFIRMED, and bounded.**
An id absent from the map falls back to `defaultEnabled`. Empirically, the ids that come
back ARMED when absent are exactly:

```
sequential-thinking, time, fetch, context7, filesystem, git   — all tier=safe-readonly
```

**God's specific question — can a discarded opt-out ever come back as ARMED via a catalog
default? Answer: only for `safe-readonly` servers. Never for write or secret.** This is
double-guarded:

1. every write/secret catalog entry ships `defaultEnabled:false`, so there is no default
   to come back to; and
2. even if (1) were violated, `hive.ts:1110` requires `consented === true` for any
   non-safe tier.

I confirmed guard (2) is load-bearing rather than redundant commentary (**Probe 2b**) by
poisoning the catalog in a scratch process — setting `github-token.defaultEnabled = true`
while leaving `tier: 'secret'`:

```
POISONED  github-token tier=secret defaultEnabled=true
  absent-from-config -> UI:true ARMED:false
  => second gate holds: true
  => but UI now shows ON with no human consent: true
```

Main refused to arm a secret-tier server even with the catalog lying to it. The UI, which
has no tier gate, was fooled — into the benign direction. That is the correct failure
ordering, and it is the single most reassuring result in this review: catalog drift cannot
arm anything.

Note this whole behaviour is **pre-existing** and untouched by T-057; the loss is confined
to opt-outs on servers that are ON by default, both readers agree about it, and the human
can see it in the panel. Reachable only via a hand-edited or pre-catalog-vintage
`config.json` — the toggle path itself always merges over what it just read from disk
(`applyToggle` spreads `currentDefaults`), so normal use never produces a partial map.

## Probe 3 — the new mount-time `getConfig()`: does it open a divergence window?

Two sub-questions.

**(a) Does the effect itself create a window?** Yes, a transient one. `useState` seeds from
the stale `config` prop, and the `useEffect` correcting it runs after the first render. So
one frame paints the prop's value before the disk's value replaces it. I reproduced both
frames against the real component:

```
A. getConfig SUCCEEDS (normal)
  first painted frame : off
  after effect settles: on          <- corrected
  ACTUALLY ARMED     : true
  => ok (UI agrees with disk once settled)
```

This self-corrects within one IPC round-trip with no user action. It is not actionable by
a human and I do not consider it a finding.

*(Method note: my first run of this probe reported scenario A as staying `off`, which
would have been a false positive. `test/render-hooks.cjs` is deliberately non-reactive —
`setState` mutates the hook slot but does not re-render — so `render()` must be called to
see the next frame. The harness was wrong, not the fix. Recording it because the next
person to use that harness will hit the same trap.)*

**(b) Does a FAILED `getConfig` leave the UI asserting a grant that is not real?**
The `.catch(() => { /* keep the prop-seeded value */ })` keeps the stale prop. If the prop
says OFF and the disk says ON, the panel shows OFF permanently while the server IS armed —
the severe direction:

```
B. getConfig REJECTS (.catch keeps stale prop)
  first painted frame : off
  after effect settles: off
  ACTUALLY ARMED     : true
  => *** UI says OFF, spawn ARMS write-tier ***
```

**But that branch is not reachable in this codebase.** Traced end to end:

- `window.cth.getConfig()` → `ipcRenderer.invoke('config:get')` (`preload/index.ts:645`)
- → `ipcMain.handle('config:get', (): HarnessConfig => readConfig())` (`main/index.ts:3102`)

and each link refuses to reject:

1. **`readConfig` cannot throw.** `main/config.ts:586-599` wraps the read, the `JSON.parse`
   and all three post-processors (`withTriggerDefaults`, `migrateTriggersV1`,
   `normalizeStoredHomes`) in one `try`, whose `catch` returns defaults. A corrupt,
   truncated, or unreadable `config.json` yields defaults, not an exception.
2. **The handler is registered at module load.** `ipcMain.handle('config:get', …)` sits at
   column 0, top-level in `main/index.ts`, evaluated at import time — before any
   `BrowserWindow` exists. There is no startup window in which "no handler registered"
   could be returned, and the settings panel only mounts on user interaction anyway.
3. **The payload is always structured-cloneable.** It is `{...DEFAULTS, ...JSON.parse(raw)}`;
   `JSON.parse` cannot produce a non-cloneable value.

Reaching the `.catch` therefore requires an Electron IPC transport failure, at which point
`pty:spawn` and every other channel are equally dead and no agent can be spawned at all.
Recorded as **F1 (LOW)** below with a fail-closed mitigation, not as a blocker.

One more sub-case checked: the effect's dep array is `[]`, so a disk change while the panel
stays open is not picked up. The only writer that could act during that window is the hire
path, and `mergeHireMcpDefaults` (i) only ever adds `safe-readonly` ids, (ii) never
overrides an existing entry in either direction (`if (out[id] !== undefined) continue`),
and (iii) does not write to disk at all — its result goes into `spawnOpts` for one spawn.
No divergence.

## Probe 4 — can any path arm a write/secret server without an explicit human `true`?

Every value that reaches `buildDefaultMcpServers` arrives as `opts.mcpDefaults` at
`hive.ts:1048`, fed from exactly two producers:

| # | Site | Value | Can it contain a write/secret `true` the human did not set? |
|---|---|---|---|
| 1 | `index.ts:2721` | `opts.mcpDefaults ?? readConfig().mcpDefaults` | Fallback is the disk map — human-authored by definition. |
| 2 | `index.ts:4650` | `mergeHireMcpDefaults(readConfig().mcpDefaults, hirePlan.mcpEnable)` | **No.** Three gates. |

The hire path is gated three times over, and I confirmed each gate reads the tier from the
catalog itself rather than trusting a caller-supplied list:

1. `planHireMcp` (`hireSpawn.ts:82-90`) partitions the manifest's ids with
   `isSafeReadonlyMcp`; write/secret ids go to `mcpSkipped` and are reported, never armed.
2. `mergeHireMcpDefaults` (`hireSpawn.ts:118-130`) re-filters with `isSafeReadonlyMcp`
   *again* — so an id that arrived some other way still cannot be armed — and refuses to
   overwrite any existing entry, so a human's explicit `false` stands and a manifest cannot
   re-enable something switched off.
3. `buildDefaultMcpServers` (`hive.ts:1110`) independently requires `consented === true`
   for any non-`safe-readonly` tier.

**A god-authored spawn-request cannot arm a write or secret server. The invariant holds.**

The one soft spot is producer #1. `ipcMain.handle('pty:spawn', …)` validates only
`opts.id`, `opts.cwd` and `opts.command` (`index.ts:2532-2534`) and passes
`opts.mcpDefaults` through untier-checked. Today **no renderer call site sets that field** —
I grepped `src/renderer` and `src/preload`; the only hit is the `HarnessConfig` type at
`preload/index.ts:274`, which is the config shape, not `SpawnOptions` — so the field's only
real producer is the tier-filtered hire path. Recorded as **F2 (LOW)** below.

## Probe 5 — can anything here alter, bypass, or desynchronise the `hive-memory` id?

**No.** The change is genuinely surgical — `955dddaf..dfb25335` touches:

```
src/renderer/src/components/McpDefaultsSettings.tsx    (+33)
src/renderer/src/components/mcpToggleLogic.ts          (new)
test/load-ts.cjs  test/render-hooks.cjs
test/mcp-defaults-roundtrip.test.cjs
test/mcp-toggle-component.test.cjs
test/mcp-toggle-state.test.cjs
```

It does not touch `src/shared/mcpCatalog.ts`, `src/main/hive.ts`, or `src/main/control.ts`
— the three files that between them define the id, namespace it, and match it.

The chain is intact and unmodified: catalog `id: 'hive-memory'` →
`buildDefaultMcpServers` writes `munder-${e.id}` → `control.ts:39`
`MCP_DENY_SERVERS = new Set(['munder-hive-memory', 'munder_hive_memory'])`.

The toggle cannot introduce a new id: `applyToggle(id, …)` is only ever called with an id
taken from `MCP_CATALOG` in the component's own render, and — as noted in Probe 1 — an
unknown key in `mcpDefaults` is ignored by main because it iterates the catalog, not the
map. Desynchronising the deny gate would require editing `mcpCatalog.ts` or `control.ts`,
neither of which this change goes near.

Both new test files pin the literal string `'hive-memory'` written out rather than imported
from the catalog, which is the right call — a test that asks the implementation which id to
check cannot notice the id changing.

---

## Findings

No HIGH. No MEDIUM.

### F1 — LOW (defense-in-depth): a failed mount read leaves the panel asserting the stale prop

* **File:** `src/renderer/src/components/McpDefaultsSettings.tsx:49`
* **Category:** consent-display integrity
* **Reachable:** **No** — see Probe 3(b). Requires an Electron IPC transport failure;
  `readConfig` cannot throw, the handler is registered at module load, the payload is
  always cloneable.
* **Description:** `.catch(() => { /* keep the prop-seeded value */ })` falls back to
  `config.mcpDefaults`, which is App's start-up copy and is never refreshed. If the disk
  has since granted a write-tier server, the panel shows OFF for a server that will be
  armed. Demonstrated in scratch (scenario B).
* **Why it is not a blocker:** this is *exactly the pre-T-057 behaviour*. On the failure
  path the fix degrades to the bug it fixes; it never does worse. And the path is unreachable.
* **Mitigation if god wants belt-and-braces:** fail closed rather than fail stale — on
  `catch`, render the row as indeterminate (`—` / "couldn't read") instead of a confident
  `off`. A consent control that cannot read the grant should say so, not assert the
  opposite. ~5 lines, additive.

### F2 — LOW (defense-in-depth, pre-existing): `pty:spawn` does not tier-filter `opts.mcpDefaults`

* **File:** `src/main/index.ts:2532` (validation) / `2721` (use)
* **Category:** missing validation at a trust boundary
* **Reachable:** **Not today.** No renderer call site sets the field; the only producer is
  the tier-filtered hire path. Exploiting it needs arbitrary renderer JS execution.
* **Description:** the handler validates `id`/`cwd`/`command` and passes `mcpDefaults`
  through unchecked, so a renderer that supplied `{'github-token':{enabled:true}}` would
  arm a secret-tier server for that spawn. It is *stealthier* than the equivalent
  `window.cth.updateConfig` attack the same renderer already has, because it leaves no
  trace in `config.json` and so is invisible to the consent panel — but it is not an
  escalation, since that renderer could write the config directly anyway.
* **Not introduced by T-057.** Recorded because Probe 4 is the natural place to notice it.
* **Mitigation:** run `opts.mcpDefaults` through the same `isSafeReadonlyMcp` filter
  `mergeHireMcpDefaults` already uses, at the `pty:spawn` boundary. Permission checks
  belong in the permission layer — this is the layer.

### F3 — LOW (pre-existing, already documented by QA): a partial stored map discards safe-readonly opt-outs

* **File:** `src/main/config.ts:595`
* **Reachable:** only via a hand-edited or pre-catalog-vintage `config.json`; the toggle
  path cannot produce it.
* **Impact bounded:** affects only `safe-readonly` ids, i.e. servers that are ON by default;
  never write or secret (Probe 2). Both readers agree, so the human can see the result.
* **Not introduced by T-057.** No action recommended for this change.

---

## Verification

| Check | Result |
|---|---|
| `npm run typecheck` (node + web) | **0 errors** |
| `node --test test/*.test.cjs` | **604 / 605 pass** |
| The 1 failure | `test/provider-config.test.cjs:83` — "model picker options stay provider-specific" (`gpt-5.6-sol`). Pre-existing and unrelated: the T-057 diff touches no provider/model file. |

All proof-of-concept code ran in a scratch dir against `mkdtemp` userData dirs. Nothing
was run against the real config, the real palace, or any MCP server. No destructive MCP
tool was invoked. No security invariant was weakened to make a point.

## Environment note (requested)

**This clean spawn's worktree had NO `node_modules`.** `ls -d node_modules` →
`No such file or directory`. I created the symlink by hand per the task's fallback:

```
ln -s /Users/aaroncoville/code/munder-difflin/node_modules node_modules
```

T-061's fix is merged (`464ef07a` is an ancestor of `main`), so this is the "merged is not
live" chain from CLAUDE.md: the worktree for *this* task was created by a build that does
not yet contain it, or by a path that does not call the new code. Evidence from a clean
spawn, as asked — worth checking `grep -c` on the built `out/main/index.js` before assuming
the symlink logic is running.

## What I would tell the next reviewer

The thing that makes this control safe is **not** the catalog's `defaultEnabled:false` on
write/secret entries, which is the obvious answer and is only the outer of two gates. It is
that `buildDefaultMcpServers` conjoins an extra condition onto the *same expression* the UI
evaluates, making main's armed-set a strict subset of what the panel is showing. Anything
that breaks that subset relation — a tier check moved into the renderer, a second config
source for main, a UI that stops reading the disk — re-opens god's thesis for real. The
`consented !== true` line at `hive.ts:1110` is the load-bearing one; Probe 2b shows it
holding while the catalog lies.
