# Munder Difflin — guidance for AI agents working in this repo

This is a **fork of a third-party open-source project**, and we intend our fixes to go back
upstream. That single fact drives everything below.

## Write every commit for a stranger

**The maintainer reading your commit has never heard of this project's tooling, your task, or
you.** They have the code, your message, and nothing else.

So a commit here is finished only when it would make sense to someone with no context:

- **No internal references.** No task or ticket ids, no agent or orchestrator names, no
  references to internal docs, boards, or our own PR numbers. Not in the commit message, not in
  code comments, not in test names.
- **Keep every technical explanation that stands on its own.** Upstream benefits from the
  reasoning — only the bookkeeping is noise. **Keep the WHY, drop the WHO and the ticket.**
- Write **symptom → root cause → fix**. If the root cause is non-obvious, that paragraph is the
  most valuable thing in the commit.

A good message reads like: *"The codex preset recommended a model slug the CLI has never
shipped, so launching with it returned 400 on every turn."* A bad one reads: *"T-042: fix the
thing Michael flagged."*

## Small atomic commits, rolling up to a PR

One commit does **one** thing. A PR is a coherent stack of those commits.

- If a commit needs "and" to describe it, it is two commits.
- A fix and its test belong together in one commit — the test is what makes the fix reviewable.
- A refactor that enables a fix is its **own** commit, before the fix.
- No drive-by changes. Do not reformat, do not rename, do not tidy while you are in there. Every
  unrelated line in a diff is a line the maintainer has to review and a rebase conflict later.

Prefer a new function or file over reshaping an existing one — surgical and additive keeps
rebases onto upstream cheap, and keeps the diff small enough to be reviewed on its merits.

## Branching

`main` tracks upstream. **`origin` IS the third-party upstream — never push to it.**

Branch contribution work off `main`. Because we are synced with upstream, any conflict you hit
while re-applying an older change is a **real** conflict against current upstream code, not a
stale-base artifact — resolving it properly *is* the port, and it only has to be done once.

If a change cannot be cleanly separated from unrelated work, **say so and skip it**. A forced
port is worse than no port.

Do not push and do not merge. Commit on your branch; integration is handled separately.

## TDD, and "I wrote tests" is not TDD

Write the failing test **first**, run it, and **report the RED output**.

Then, before calling anything done: **break it to prove it.** Change the thing your test is
supposed to protect and confirm it goes red. If it stays green, your test protects nothing.

Four real defects shipped past review here because a test existed but could not fail:

- a test that grepped the source and matched a **commented-out** line, so the feature could be
  disabled with the whole suite green;
- a test sharing its critical constant with the implementation it checked;
- a test that reimplemented a call site instead of importing it;
- a stub that threw where the real function only ever resolved.

Assert the **actual property**, not its neighbour. And watch for the same defect in non-test
form: a value written to disk that nothing is ever told to read is the same bug wearing a
different hat.

## CONTRIBUTING.md is the contract — read it, follow it exactly

`CONTRIBUTING.md` and `.github/PULL_REQUEST_TEMPLATE.md` are upstream's rules, not suggestions.
They are stricter than most projects and they close PRs rather than negotiate. The ones that
will bite:

**Evidence is mandatory and CI-enforced.** Every PR needs a **before** and an **after** under
the exact `### Before` / `### After` headings — the `PR evidence` check reads those headings and
blocks merge without them. Two images under one heading does not pass.

**"My change has no UI" is not an exemption.** It changes the form of the evidence:

| Kind of change | Evidence |
|---|---|
| Visual | The same view twice — same window size, same theme, same data |
| Bug fix | The bug happening, then the same steps not producing it |
| Terminal / CLI | A recording, or the output pasted as text |
| Performance | The measurement before and after, same machine |
| Crash / hang | The failure, then the same path completing |
| Test-only | The suite red, then the suite green |

**Plan for evidence before you write the code.** If your change can only be demonstrated in a
running app with a GPU, you cannot capture it yourself — say so early and hand over exact
reproduction steps for someone who can. Do not discover this at PR time.

**One change per PR.** A fix plus a refactor plus a rename is three PRs. This is listed under
what gets closed, not what gets a comment.

**Large architectural changes need an issue or discussion agreed BEFORE the code is written.**
Upstream would rather say no to a paragraph than to a week of work.

Also: link the issue (`Closes #123`), say which OS you tested on, never force-push after review
has started, and never put credentials, internal metrics, or private data in a commit message —
a pushed message is public and permanent.

## Verification

All three must pass, and all three are on the PR checklist:

```
npm run typecheck     # node + web; must be 0 errors
npm run test:focused  # the suite
npm run build         # a production build must succeed
npm run dev           # electron-vite dev — this is the running app
```

Any new UI must derive from the design tokens in `DESIGN.md` / `src/renderer/src/design/tokens.ts`
— no ad-hoc colors, spacing, or fonts. `tokens.ts` and `tokens.css` are mirrored: change one,
change both.

**Read your own diff before opening anything.** Debug logging, commented-out code, and
reformatting of files you did not otherwise touch all get a PR sent back.

**Measure the baseline on the exact ref you branched from, before you change anything.** Then
report counts as **"N of M"** — "594 of 595, with one pre-existing failure" beats "tests pass",
and it stops a pre-existing failure being mistaken for yours. Never report green on a result a
reviewer cannot reproduce.

**Merged is not live.** A merge does not rebuild the running app. Check the built artefact, not
the git log: `grep -c '<newSymbol>' out/main/index.js` and `stat -f '%Sm' out/main/index.js`. A
current `main` with an eight-hour-old bundle has happened here.

## Things that are easy to get wrong

- **Isolated worktrees have no `node_modules`.** If `npm run typecheck` dies with
  `TS2688: Cannot find type definition file for 'node'`, symlink the base checkout's
  `node_modules` into your worktree before anything else.
- **Commit a working draft early**, then refine. An interrupted session keeps what is committed
  and loses what is not.
- If something cannot be determined in your environment — anything needing a GPU, a running
  Electron instance, or real user interaction — **say so plainly and name what would settle
  it.** That is a complete answer, not a failure. Do not estimate and present it as measured.

## Security invariants — do not weaken these

- Consent-gated MCP servers (write/secret tier) are **never** auto-enabled by a programmatic
  spawn. Do not add a bypass.
- The memory server's catalog id must not change: the destructive-tool deny gate matches on the
  exact namespaced name, and renaming it silently disarms the block on `delete_bank` /
  `clear_memories` / `delete_document`.
- Permission checks belong in the permission layer, not in prompt discipline.
- A consent control must display what is **actually persisted**, never what was merely intended
  — showing a grant that did not land is worse than showing an error.
