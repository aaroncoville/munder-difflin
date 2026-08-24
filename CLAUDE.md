# Munder Difflin — Claude / AI agent guidance

You are almost certainly an **ephemeral hire** spawned by Michael (the god/orchestrator) for one
task. You will not be here tomorrow. Everything below exists so the work outlives you.

## Superpowers are mandatory in this repo

Agents working here are **full Claude sessions** — the `SUBAGENT-STOP` clause in
`using-superpowers` does **not** apply.

Invoke the right skill before you start, and announce which one:

| Situation | Skill |
|---|---|
| Any bounded code change or bug fix | `superpowers:test-driven-development` |
| New feature, architecture, or anything ambiguous | `superpowers:brainstorming` |
| Executing a written plan | `superpowers:executing-plans` |
| Diagnosing a bug | `superpowers:systematic-debugging` |
| Claiming something is done | `superpowers:verification-before-completion` |

## The flow, and where it stops for review

```
brainstorm → spec → plan → [MICHAEL REVIEWS] → implement (TDD) → [MICHAEL REVIEWS] → hand back
```

**Do not start implementing off your own spec or plan.** Send it to Michael's inbox and wait. He
reviews first and resolves what he can; only genuine ambiguity reaches the human, as a `humanQA`
entry on the task card. This is the whole point of the ladder — you are not blocked on a person,
you are blocked on one orchestrator who is watching for you.

If a requirement is ambiguous, or your change would alter a contract other code depends on: **stop
and surface the trade-off.** Do not guess and do not quietly narrow the task.

## TDD is not optional, and "I wrote tests" is not TDD

Write the failing test **first**, run it, and **report the RED output** — Michael reproduces it
independently and will bounce work whose RED he cannot reproduce.

Then, before you call anything done: **break it to prove it.** Change the thing your test is
supposed to protect and confirm it goes red. If it stays green, your test protects nothing.

Four real defects shipped past review here because a test existed but could not fail:

- a stub that `throw`s when the real function only ever resolves — testing a case production
  cannot produce;
- a test sharing its critical constant with the implementation it checks;
- a test that reimplements a call site instead of importing it;
- a metric computed against a denominator nobody had ever set.

Assert the **actual security property**, not its neighbour. If a cookie's flags are the control,
assert the flags — one here was missing `Secure` and nothing went red, because no test looked.

## This repo is a FORK — keep changes surgical

`origin` is the third-party upstream (`chaitanyagiri/munder-difflin`). **Never push to `origin`.**
Our fork is the `fork` remote, and its integration branch is **`hive-main`**, not `main`.

Changes must be **additive and surgical** so rebases onto upstream stay cheap. Prefer a new
function or file over reshaping an existing one. Do not reformat, do not "tidy while you're in
there", and do not rename upstream symbols.

**Never push and never merge.** Commit on your branch in your worktree; Michael integrates.

## Commands

```
npm run dev          # electron-vite dev (this is the running app)
npm run build        # build + copy main assets
npm run typecheck    # node + web; must be 0 errors
node --test test/*.test.cjs    # the suite (also: npm run test:focused)
```

Run `typecheck` and the suite before you report anything. Report the **numbers** — "581/582 with
one known pre-existing failure" beats "tests pass". Never report green on a result a reviewer
cannot reproduce.

## Merged is not live

A GitHub merge lands on `fork/hive-main`. The dev build runs from **local `main`**, and merging
does not rebuild it. The chain is:

```
authored → merged → fetched → local main fast-forwarded → REBUILT → RESTARTED
```

Check the built artefact, not the git log: `grep -c '<newSymbol>' out/main/index.js` and
`stat -f '%Sm' out/main/index.js`. A current `main` with an eight-hour-old bundle has happened.

## Security invariants — do not weaken these

- **A spawn-request is not human consent.** Write/secret-tier MCP servers are never auto-enabled
  by a god-authored spawn (`hireSpawn.ts`). Do not add a bypass.
- **The `hive-memory` catalog id must never change.** `buildDefaultMcpServers` namespaces it
  `munder-hive-memory`, which is the exact name the T-047 destructive-tool deny gate matches.
  Renaming it silently disarms the gate that blocks `delete_bank` / `clear_memories` /
  `delete_document`.
- Permission checks belong in the permission layer, not in prompt discipline.

## Before you finish

Append to your `memory.md`: where the work stands, and the **concrete next step someone could pick
up cold** — file paths, branch name, commit shas. Not a summary of your day; the handoff. Whoever
reads it will not have your context.

If you learned something that would save the next agent a wrong turn, that is the most valuable
thing you will write today.
