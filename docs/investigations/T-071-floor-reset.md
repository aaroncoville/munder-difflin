# T-071 — the office floor resets when you switch agents

## What was happening

Settled before this change, and unchanged by it. Chromium caps live WebGL
contexts per renderer process (~16) and **evicts the oldest** when a new one
pushes past. The office floor's Pixi context is created at app startup, so it is
always the oldest alive. Every terminal xterm opens takes another context via
`@xterm/addon-webgl`. Switching agents opens terminals, crosses the cap, and the
floor's context is the one that goes.

Pixi reports nothing, so `glRecovery.ts` catches `webglcontextlost`, calls
`preventDefault()` (without it the context never comes back) and bumps
`glGeneration` — a dep of the scene effect at `OfficeFloor.tsx:1740`. The whole
scene is torn down and rebuilt through the ordinary mount path. **That rebuild
is the recovery working correctly**, and the workers never stop running; the
problem was purely visual. Because every `Character` was constructed cold, each
one reappeared at the office door and walked to a desk, and desks were re-dealt
in whatever order the agents happened to be rebuilt in — so an agent could come
back to somebody else's chair.

## What changed

`src/renderer/src/scene/office/sceneRestore.ts` (new) — a placement snapshot
that crosses the rebuild.

- **Capture.** The effect cleanup records, per agent, its seat index and the
  tile it was actually standing on, into a `useRef`. A ref because the effect
  *re-runs* on a rebuild: anything in its closure dies with the scene.
- **Restore.** `addCharacter` seeds each agent from that snapshot instead of the
  cold-start path — same desk, and `spawnTile` is where it already was rather
  than the door. `applyState` then snaps it into its seat (`walkToDeskAndSit`
  short-circuits when you are already on the desk tile) instead of walking it
  there.

The two halves degrade independently: a desk already claimed by an earlier agent
this mount still leaves the position worth restoring, and a remembered tile that
is not walkable on the current map still leaves the desk worth restoring. A
theme change discards the snapshot outright — seat indices and tiles are indices
into *one* map, and replaying them onto another would seat agents inside walls.

Seat 0 is Michael's room by rule, so `agent.isGod` always goes through
`claimSeat` and is never restored.

The module takes plain numbers and predicates — no Pixi, no map renderer, no
React — so the whole restore policy is testable against a `Map` literal with no
browser and no GPU. Same seam `glRecovery.ts` already used.

## What this does NOT fix

- **It does not stop the eviction.** The floor still loses its context whenever
  enough terminals are open, and the scene is still fully rebuilt. This removes
  the annoyance, not the cause.
- Everything except desk and position still resets: the coffee economy (clean-cup
  stock, mugs parked on desks), break-room and errand state, in-flight message
  envelopes, thought bubbles, and the task-board notes until the next 5s poll.
- Options deliberately *not* taken, because they are Aaron's call, not a worker's:
  dropping `@xterm/addon-webgl` (a global change to every user's terminal), or
  trying to make the floor's context not be the oldest.

## Residual jank

- **A ~1.5s blank floor.** `DEFAULT_REBUILD_DELAY_MS` deliberately waits out the
  eviction storm — claiming a context straight back just loses it to the next
  terminal in the same burst. Not touched.
- **A 0.5s fade-in.** `Character.show()` always fades from alpha 0
  (`Character.ts:502`). Agents now *materialise at their desks* rather than
  walking in, but they still fade. Removing that means changing `show()` for
  every caller, which is not surgical enough to be worth it here.
- An agent that was on a coffee break is restored at the café and then walks to
  its desk — a short walk, not the walk-in.

## Un-regressing the recovery

The rebuild cap and the give-up-loudly path are the thing that must not break:
going blank forever is far worse than an ugly rebuild. They are untouched, and
`test/office-gl-recovery.test.cjs` (6 tests) still passes unchanged.

The one new risk this change introduces is the capture itself: it runs inside
the same cleanup that uninstalls the context-loss listener, against characters
that are being destroyed. If it threw, it would take the cleanup down with it
and leave a listener on a dead scene — a scene that can resurrect itself, which
is strictly worse than the reset being fixed. So the uninstall runs **first and
unconditionally**, the capture is wrapped, and `captureSceneSnapshot` is total by
construction: a runtime with no character, a getter that throws, or a `NaN`
position is skipped rather than propagated. `test/office-scene-restore.test.cjs`
pins that.

## Not verifiable here

This was implemented in a headless worktree with no GPU and no running Electron
app, so the *live* behaviour — actual WebGL context counts, and how the restored
floor looks after a real eviction — was not measured. What would measure it: run
`npm run dev`, open enough agent terminals to cross the cap (~16 contexts;
DevTools logs `WARNING: Too many active WebGL contexts`), and confirm the floor
comes back with agents at their desks instead of filing in through the door.
