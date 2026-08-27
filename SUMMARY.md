# Sixth History — Milestone 3 (The Inhabited House)

Branch `agent/worker-leo`, cut from `3d313d4d`. Ten commits: one for the plan,
one per implementation task, and the portrait pack landing as three.

    99651f1d docs(study): the implementation plan for the inhabited house
    8e232cbd feat(i18n): the house speaks in its own register under the occult theme
    cf26dd7a feat(theme): a candlelit palette for the terminal and the editor
    096400a2 feat(icons): a gilt deco redraw of the icon set for the occult theme
    bb6231a9 feat(study): candlelight, dust and hearth-smoke over the painted rooms
    cac1c4a0 feat(study): the commissions on the card table open the card they name
    5a57fcd4 feat(study): finished work darkens a book on the shelf wall
    12ec2ec8 chore(study): the licensed portraits and their attribution
    f3fa4f14 feat(study): an assistant named for a portrait wears it
    a7a27b57 feat(study): choosing a face names the assistant it belongs to

## Verification

Measured on this branch's tip, in this checkout:

```
node --test test/*.test.cjs
# tests 1056 · pass 1055 · fail 0 · cancelled 0 · skipped 1     (exit 0)

npm run typecheck    # node + web, 0 errors
npm run build        # succeeds; 48 portraits emitted as fingerprinted assets
```

Two things about that line need saying plainly, because a green number nobody
can reproduce is worth less than a red one.

**The baseline in the plan does not reproduce here.** The plan measured
`962 of 998, with 35 failures` on `3d313d4d`, the 35 being memory and hindsight
backend suites that need a server. In this environment those suites now pass —
`memory-backend-conformance`, `memory-hindsight-status`, `hindsight-adapter`
and the rest all ran and were green — so the run above is *stronger* than the
recorded baseline, not weaker. The gate's "the same 35 pre-existing failures
and no others" could therefore not be compared as written; what can be said is
that there are **no failures at all**, and the exit code is 0.

**The one skip is deliberate and named.** `the pack is the pool a worker is
summoned from` cross-checks the portrait names against the spawner's name pool,
which lives in a different repository. It runs when pointed at one:

```
STUDY_PORTRAIT_NAME_POOL=<path to the pool> node --test test/study-portraits.test.cjs
# tests 14 · pass 14 · fail 0 · skipped 0
```

That was run against the real pool file and passes: all 47 pool names have a
face, and the pack holds nothing but those 47 plus the one reserved portrait.
The in-repository half of the same rule — no aspect/faction iconography, every
name typeable — is a separate test with no skip on it.

## Per task

### 1 — `en-SH`, the house speaks (`8e232cbd`)

A **partial** locale, not a fork of the strings: it re-voices the spec's
glossary nouns and the sentences they appear in, and every other key falls
through to `en` by i18next's own `fallbackLng`. A key added upstream tomorrow
costs this locale nothing. Flavour lives in nouns and never in what a control
does — `Save` is still `Save`.

### 2 — The candlelit terminal and editor (`cf26dd7a`)

The obvious fix was the wrong one. `terminalThemeFor()` answers a question
about **external** programs: it is written to running programs as DEC mode 2031
(`CSI ? 997 ; 1 n` / `; 2 n` — the protocol has two values), and it is
persisted as a config field the main process types and validates as
`'light' | 'dark'`. Told `occult`, a spawned agent would act on a value its own
schema rejects. So the candlelight went into a **new** selector,
`terminalPaletteFor()`, read only inside the renderer. A TUI still hears
`dark`, which the candlelit palette is.

Monaco had only ever registered one theme, so a cream page opened in the middle
of a night palette; it now gets the candlelit one under occult and dark keeps
exactly what it had.

### 3 — The deco icon set (`096400a2`)

A second table of the same twenty-four names, same 16×16 viewBox, same
`IconDef` shape, same `currentColor`. `Icon` picks the table by theme, so all
~200 call sites are untouched and the pixel set stays byte-identical for light
and dark.

The rendering hint travels with the table, which is the easy thing to miss:
`shapeRendering="crispEdges"` is what stops a 16px pixel glyph shimmering, and
does the opposite to a swept curve — it turns it into a staircase. The pixel
table keeps the hint; the deco table renders without it.

### 4 — The ambiance layer (`bb6231a9`)

Flicker, dust and hearth-smoke over the painted rooms. All the arithmetic is
pure functions in `ambiance.ts`, because a particle field is impossible to
check inside a renderer and trivial to check outside one. Three load-bearing
properties: seeding is deterministic from the room id (a room that reseeds every
render is a strobe), drift wraps rather than leaking (a leaking field looks
right for a minute and is empty after an hour), and both counts are capped.

`pixi` is a dynamic import inside the effect, so nobody outside this theme
fetches it. Every `await` is followed by a liveness check and the application is
destroyed from either side of the window — a leaked WebGL context per room per
resize is a failure this codebase has had before. The canvas is unclickable by
two independent mechanisms, because a canvas that took events would swallow the
whole scene while looking perfectly correct.

### 5 — The shelf archive (`5a57fcd4`)

Concluded commissions and departed assistants darken a book on the shelf wall.
The shelves are painted pale, so a book lights up by *darkening* — multiply in a
warm ink with a gilt hairline — which also means it cannot cover the painting it
points at, or sit visibly wrong when the art is repainted. Positions come from
the room's own marked points, so a book stands on a shelf in the picture rather
than at a guessed coordinate.

The bound is where the honesty is; see the parked question below.

A filesystem trap is recorded in that commit and is worth repeating: the pure
half had to be `shelfBooks.ts`, not `shelfArchive.ts`, because next to
`ShelfArchive.tsx` on a case-insensitive filesystem the two are the same path
and a resolver preferring `.ts` hands the importer the wrong one. It failed
silently, with the suite green, and would have worked on Linux.

### 6 — Commissions you can pick up off the baize (`cac1c4a0`)

The card table's four column totals become the commissions themselves, dealt
onto the painted baize and numbered as the board numbers them. A click opens
that commission through the same app-wide `openTaskDetail` overlay a kanban card
opens — the Study is another way of looking at the same house, not a second
house with surfaces to keep in step.

The subtlety: a card sits *inside* a room, and the room is itself a button that
opens the board. Without stopping the event, one click does both and the board
opens on top of the detail. The test asserts the room handler did **not** fire,
because the weaker assertion passes with the bug present.

Bounded at eight — not a performance number, but how many cards fit on the
painted table before they stop being separately clickable.

### 7 — The portrait pack (`12ec2ec8`, `f3fa4f14`, `a7a27b57`)

**The art (`12ec2ec8`).** The 48 people cards of the community pack, plus the
regenerated static index the bundler needs to emit them. The pack's aspect,
faction and element cards are deliberately excluded: they are iconography, and
an assistant wearing the Moth aspect card is not a picture of anybody. Every
file has a row in `ATTRIBUTION-SIXTH-HISTORY.md` — obligation 6 of the licence
— and a test holds the table against the directory in **both** directions, so a
portrait cannot ship without a row and a row cannot outlive its file.

**The name rule (`f3fa4f14`).** An assistant called `leo` could not wear
`leo.png`: each import yields a fingerprinted bundle URL and the filename is
gone by the time the app sees it. The generator now emits `PORTRAIT_NAMES`
beside `PORTRAIT_FILES`, index for index, and `portraitFor` matches the name
first and falls back to the id hash second. The hash stays underneath, because
an assistant named something outside the pack still needs a face and needs the
same one on every render.

`fascination` is reserved for the orchestrator in both directions: the
orchestrator always wears it, and it is held out of the set the hash deals from
so nobody is dealt the face of the one running the house. That rule needs to
know *which* card is the orchestrator's, and nothing else in the projection
distinguishes it, so `SceneAgent` now carries the flag through to the card.

**The picker (`a7a27b57`).** Under occult the summoning screen's Character row
becomes the portrait wall, and choosing a face sets the assistant's name to the
portrait's — the same thing clicking a pixel cast member already does with its
display name. The picker hands back the **name**, not a file, because the name
is what the assignment rule reads. The pixel cast is untouched for the other
themes, the accent default stays `'sky'` as the dispatch required, and the
reserved face is not on the wall.

## Break-it-to-prove-it

Each of these was applied, run, and reverted:

| Change | Test that went red |
|---|---|
| Delete one row from the attribution document | `every shipped portrait is recorded, because that is the licence` |
| Make `portraitFor` ignore the name and always hash | `an assistant named for a portrait wears it, whatever its id`, `an assistant named for a portrait wears that portrait` |
| Stop the scene telling `portraitFor` which card is the orchestrator's | `the orchestrator wears the face reserved for it` |
| Make the picker hand back a file instead of a name | `choosing a face hands back the name it belongs to` |

## Deviations

1. **The scene's "drop a portrait into the pack" test was replaced, not kept.**
   It proved the scene consulted the mapping by copying a file into the pack at
   runtime, regenerating the index and reading the cards — a dance whose entire
   reason was that the shipped pack was empty and could not be asserted
   against. With 48 portraits in it that premise is gone, and worse, it mutates
   a licence-governed directory while other test files read the same directory
   concurrently, which would have made the attribution test flaky. It is now two
   assertions on the bundled pack (`the cards wear the shipped pack`, then `an
   assistant named for a portrait wears that portrait`), which are stronger and
   mutate nothing.

2. **The pool cross-check is opt-in via `STUDY_PORTRAIT_NAME_POOL` rather than
   an absolute path in the test.** The plan asked the test to assert against the
   spawner's name pool file. That file lives outside this repository, and a
   hardcoded absolute path to it would fail on every machine but one — and is
   exactly the kind of environment-specific reference the contributing rules
   forbid. The rule is split: the in-repository half (no iconography, every name
   typeable) always runs; the cross-repository half runs when pointed at a pool.
   Evidence that it passes against the real pool is in Verification above.

3. **The commit for the art regenerates the index with the generator as it then
   stood** (files only), and the following commit adds the names. Splitting it
   that way keeps every commit in the stack green rather than leaving one that
   ships portraits the index does not list.

4. **Task 3 deviation of record:** the cog glyph is generated eight-fold rather
   than drawn by eye; hand-placed lobes read as a splat at 16px, which is the
   size that actually matters.

## Rework round

Three review findings, one commit each, each with its test written first and
then broken to prove it protects something.

    9d78693a fix(study): the reserved portrait cannot be claimed by naming yourself after it
    b1dbdd26 fix(i18n): the house register also answers a language change, not only a theme
    577117a6 fix(study): a room whose ambiance fails to load is a room without ambiance

### 1 — The reserved portrait was bypassable by name

`fascination` was held out of the set the hash deals from, but the name rule
runs *first* and matched against the complete pack. An assistant named
`fascination` by hand — the summoning screen takes a typed name — matched it
directly and the reservation never came into it. The name lookup now searches
the same dealable list the hash deals from, so the one exclusion covers both
halves of the assignment and the reserved name falls through to the ordinary
deal like any other stranger.

### 2 — The house register only answered the theme

The register is a function of two things, the theme and whether the reader is
in English, and the effect depended on the theme alone. Switching the app to
English from Settings while the occult theme was already active left the
language at plain `en` until a theme toggle or a remount happened to re-run
the effect. The rule now also runs on i18next's `languageChanged`.

It settles rather than spinning because `voiceFor` returns null once the
language is already the one it would ask for — that null is the fixed point,
and answering a change costs at most one further hop. The test counts those
hops rather than trusting the argument.

The subscription was lifted into `watchVoice(theme, instance)` so the reaction
itself is testable against a stand-in, not just the pure rule underneath it. A
source assertion holds the hook to calling it, because a hook that
re-implemented the rule in its own effect would pass every other test on the
page while reacting to nothing.

### 3 — The ambiance load had no rejection handler

Two awaits in the pixi build-out can reject outside this app's control: the
dynamic `import('pixi.js')` and `Application.init` on a machine with no working
WebGL context. The body was fire-and-forget, so either surfaced as an unhandled
rejection — an error report nobody can act on, and fatal to the renderer under
a host that treats unhandled rejections as such. It now starts through
`startAmbiance`, which catches and says nothing: the room, its cards and its
commissions were never waiting on the canvas, and the failure is visible as the
candles not lighting.

### 4 — The ambiance layer leaked what it failed to build

Catching the rejection silently (above) fixed the crash and left the leak. The
`Application` was constructed, then `init` was awaited, then forty lines of
setup ran, and only after all of that was the handle the cleanup destroys
through assigned. Anything failing in that window — `init` rejecting on a
machine with no GL context, having already allocated the canvas, or any of the
setup throwing — left the handle null: the catch said nothing, the cleanup had
nothing to destroy, and a WebGL context and a ticker survived the room. Once
per room, per resize, per retry.

Construction and setup now go through `buildOrDestroy`, which hands the caller
its handle *before* the first await and destroys through that same handle if
the build throws. Destruction is idempotent, because the unmount that lands
between the rejection and the catch reaches the same resource from the other
side, and destroying a pixi `Application` twice is an error of its own. There
is now exactly one `.destroy(` call site in the file, which is what makes
exactly-once checkable rather than asserted. One behaviour rides along: the
unmounted-mid-`init` path used to destroy with `{ children: true }` and now
uses the same `{ children: true, texture: true }` as every other path.

### Break-it-to-prove-it

| Change | Test that went red |
|---|---|
| Restore the whole-pack name lookup for non-god assistants | `a worker named for the reserved face does not get it` |
| Drop the `languageChanged` subscription | `choosing English inside the house is answered with the house register`, `answering a language change does not start one`, `the watcher lets go when the app does` |
| Make `voiceFor` offer the register to any language under occult | `a language that is not English is left alone, theme or no theme`, plus the pre-existing rule test |
| Drop the `.catch` from `startAmbiance` | `pixi failing to load costs the room its ambiance and nothing else` |
| Drop the `held.release()` from `buildOrDestroy`'s catch | `a build that fails after constructing still destroys what it constructed` |
| Make `release` non-idempotent | both of the above, plus `a build that succeeds keeps its application until cleanup asks for it` |
| Publish the handle after the build instead of before it | `a build that fails after constructing still destroys what it constructed` |

### Verification, and a baseline that moved

```
node --test test/*.test.cjs
# 9276936f (the ref this round started from): 1019 of 1056, 35 failures, 1 skip
# 577117a6:                                  1027 of 1064, 35 failures, 1 skip
# bd00fb90 (the ref this fix started from):  1027 of 1064, 35 failures, 1 skip
# this tip:                                  1030 of 1067, 35 failures, 1 skip
# identical failure set throughout; every new test is a new pass

npm run typecheck    # node + web, 0 errors
npm run build        # succeeds
```

The 35 are the memory and hindsight backend suites, which need a server this
environment does not have running today. They are **not** the zero recorded
further up this file: that run was made when the server was reachable. Both
numbers are honest and neither is reproducible without knowing which. The
comparison that matters is the one above — the same set of failures on both
refs, measured minutes apart in the same shell.

One environment note for whoever runs this next: an isolated worktree has no
`node_modules`, and here the symlink into the base checkout was being removed
by something outside this session several times an hour. Every run above was
made with the link re-created immediately beforehand, and the suite runs also
carried `NODE_PATH=<base>/node_modules` so a mid-run removal could not turn
into a hundred phantom failures. A bare `node --test` in a worktree that has
lost its link reports whole files as failures with `Cannot find module
'typescript'` — which looks nothing like a missing symlink.

## Parked questions

1. **A `completedAt` on the task ledger.** The shelf's age window can only be
   applied to what has a date. `HiveTask` carries `createdAt` and no completion
   timestamp; an archived `Agent` carries no timestamp at all. So the window
   filters what has a date, using `createdAt` as the nearest honest proxy and
   naming it as one in the code, the undated keep the store's append order
   (a real ordering, even without a clock), and the count cap bounds everything
   regardless. A real `completedAt` would make the window exact. It is a change
   to the task ledger, not to this theme, so it is a question rather than a
   commit here.

2. **Visual QA has not been done and cannot be done here.** Everything in this
   milestone that a person would judge — the flicker rate, whether the books
   read as books on the painted shelves, whether the deco icons hold at 16px,
   whether the portrait wall is usable at fifty faces — needs the app running on
   a display. This environment has none, and the app is single-instance. The
   suite proves the wiring; it cannot prove any of that.

3. **The flying-book animation was not attempted.** The shelf lights a book
   when work finishes; it does not animate one crossing the room to get there.
   Nothing in the milestone depends on it and it is listed as optional.

4. **`docs/superpowers/plans/…` is in this branch's history (`99651f1d`).**
   That tree is fork-only and must not appear in an upstream diff, so that
   commit has to be dropped before this stack is offered anywhere upstream.
   Flagged rather than rewritten, because rewriting a branch's history is the
   integrator's call. This file is in the same category: it is committed so that
   it survives the worktree it was written in, and it should be dropped from any
   upstream-facing stack along with the plan.
