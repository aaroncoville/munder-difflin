# C-33c fix round 1 — both review findings resolved

Branch: `agent/worker-c33c-polish` (two new commits on top of `54cd08fd`).
Nothing pushed. No files outside this worktree were touched.

## Finding 1 — the quit fallback that quit without asking

**Commit** `bf91ee02` — *fix(quit): a floor that could not be asked was quit without asking*

**Symptom.** `app:requestQuit` is the path a painted prop uses (the office clock,
the Study hearth) so a click always raises the shared quit confirmation. When
`mainWindow` was gone or its `webContents` destroyed, the handler called
`teardownAndQuit()` outright — so on a secondary floor whose primary had been
closed, one click on a prop ended the app with nothing asked, nothing confirmed
and no closing time. The handler also discarded the IPC event, so it could not
fall back to the live floor that had just asked it.

**Root cause.** "Quitting is still what was asked for" — it is not. The click
asks for the *dialog*; inability to show one is not permission to quit.

**Fix.**
- New `src/main/quitRequest.ts` → `askToConfirmQuit()`. Resolves a confirmation
  host in order: primary window → the renderer that sent the request → any other
  floor still standing. Sends `app:closeRequested` with the pty count and returns
  whether anybody was asked. It is handed nothing that can end the app, so there
  is no branch left for a later edit to turn back into a quit.
- `src/main/index.ts` handler now takes `event`, delegates, and returns
  `{ ok }`. `ok: false` = refused, never granted.

**Test** `test/quit-confirmation-host.test.cjs` (7 tests): primary preferred and
focused; primary `null` → sender asked; primary destroyed → sender asked;
primary alive but webContents dead → sender asked; no sender → another live
floor asked and focused; nothing alive → `false` and nothing sent; plus a wiring
assertion that the handler takes the event, calls `askToConfirmQuit`, and
contains neither `teardownAndQuit(` nor `app.quit(` (via `activeSource`, so a
commented-out line cannot satisfy it).

**RED first:** the run before `quitRequest.ts` existed failed with
`ENOENT ... src/main/quitRequest.ts`.

**Broken to prove it** (three mutants, each restored):
| Mutant | Result |
|---|---|
| drop the sender fallback from `askToConfirmQuit` | 4 pass / **3 fail** |
| handler calls `teardownAndQuit()` when `!ok` | 6 pass / **1 fail** |
| handler drops the IPC event (`() =>`, `sender: null`) | 6 pass / **1 fail** |
| restored | **7 pass / 0 fail** |

## Finding 2 — one commission, two rooms

**Commit** `fd6f5b1c` — *fix(study): a concluded commission was drawn in two rooms at once*

**Symptom.** A done task rendered as a book on the baize *and* as a darkened
spine on the shelf archive.

**Root cause.** The shelf archive predates the baize stacks: while the card table
showed four column totals, the wall was the only place finished work could be
seen, so `archiveOf()` listed every done task. The card table gained the
commissions; the wall never gave them up.

**Fix.**
- `useSceneState.ts`: `archiveOf(archivedAgents, now)` — the `tasks` parameter and
  the done-task mapping are gone. The wall is the departed assistants.
- Doc comments in `shelfBooks.ts` corrected (they asserted commissions belong on
  the wall) and the commission-`createdAt`-as-proxy paragraph removed with the
  behaviour it described.
- `ShelfArchive.tsx`: `BOOK_SHADE` keeps its `commission` entry, with a comment
  saying why — the component draws whatever kind it is handed, and a kind without
  a shade paints as no mark at all. `ArchivedThing['kind']` is likewise left
  general: narrowing it to a single member would make the shelf's age-window
  bound (and its unit tests) dead, which is outside these two findings. **Flagged
  for the reviewer** as a deliberate call, not an oversight.

**Test** `test/study-shelf-archive.test.cjs`:
- The test that pinned the duplicate (`…both light the shelf`, asserting
  `books.length === 2`) is replaced by *"a concluded commission is dealt onto the
  baize and never onto the shelf"*: with one done task and one archived
  assistant, `data-baize-book` ids are exactly `['T-1']`, the shelf holds exactly
  one book, that book is `GONE-1`, and no shelf book is the commission.
- The shade test no longer derives `['assistant', 'commission']` from `archiveOf`;
  it asserts the archive shelves only `assistant` and covers that kind, then
  measures the pixel darkening of *every* shade the wall declares.

**RED first:** `not ok 9 … the shelf holds 2 books for one departed assistant:
GONE-1 — departed, the seventh folio` (`2 !== 1`). The baize half of the same
assertion was already green, which is what made it a duplicate rather than a
move.

**Broken to prove it:** emptying the archive entirely (`shelfBooks([], now)`) →
**3 fail** (the assistant's spine, its geometry, and the shade measurement all go
red), so the "assistant still darkens a spine" half is load-bearing too.
Restored → 12 pass / 0 fail.

## Verification (outside the sandbox, real exit codes)

Ritual before every run: `ln -sf /Users/aaroncoville/code/munder-difflin/node_modules node_modules`
(the link is reaped between commands in this worktree).

| Command | Result |
|---|---|
| `npm run typecheck` | exit **0** — node + web, 0 errors |
| `npm run test:focused` | exit **0** — `# tests 1139`, `# pass 1138`, `# fail 0`, `# skipped 1` |
| `npm run build` | see below |

The one skip is pre-existing and environmental: *"the pack is the pool a worker
is summoned from — SKIP set STUDY_PORTRAIT_NAME_POOL"*. So: **1138 of 1139, one
skipped by design, nothing failing.**

## Evidence for a PR

- Finding 1 is a main-process branch reachable only with a real second floor and
  a closed primary — it **cannot be screenshotted from here**. The suite
  red→green above is the evidence; a human wanting the behavioural proof should:
  open a second floor, close the primary window, click the hearth in the Study's
  parlour on the remaining floor, and see the quit confirmation appear there
  (before: the app exits immediately).
- Finding 2 is visual: the Study with one done commission and one archived
  assistant — before, the commission is a book on the baize *and* a darkened
  spine on the shelves; after, it is on the baize only. Same window size, same
  theme, same data. Needs a running app to capture.
