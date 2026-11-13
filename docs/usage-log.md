# Local usage log: how to read the data

Everything here stays on this machine.
- Floor events go to the hive's `log.jsonl`. The owner's own usage events go to the app's data folder, never the hive.
- Nothing is sent anywhere. The outbound analytics module (`src/main/analytics.ts`) sends only the event names on its own allowlist, and none of these is on it.
- Events hold ids, counts, durations and short enums or codes. They never hold message text, query results, command output or file contents.

## Feature canaries (`kind: "canary"` in `<hive>/log.jsonl`)
The canaries run a minute after the app starts, then every hour. Each pass writes one line per feature:

```json
{"ts":1794500000000,"kind":"canary","feature":"memory-search","ok":false,"ms":84,"detail":"refused-422"}
```

| feature | What it checks | `ok:false` details |
|---|---|---|
| `memory-search` | Probed only when it is provably local and passive: the backend is Hindsight and its URL's host is loopback (`localhost`, `127.0.0.0/8`, `::1`). Then the constant probe is sent with the owner tag agents send (god's id). `hits` is a count | `refused-<HTTP code>`, `error`, `timeout`. `ok:true` with `no-hits` means it answered but recalled nothing. The canary sends its own request and never follows a redirect (`redirect` if the server answers 3xx). It probes only when the saved settings and the backend the app currently holds agree. **Not probed** (`ok: null`): `not-probed-spawn` (the MemPalace backend answers by starting its CLI), `not-probed-remote` (a Hindsight URL that is not this machine), `not-probed-switching` (settings changed and the app has not switched backends yet), `off` |
| `memory-wakeup` | Same rule as `memory-search` | Same as above |
| `kg-search` | The knowledge graph's search, called in-process. `hits` is a count | `timeout`, `threw`. `no-hits` as above |
| `hook-socket` | A ping over the hook socket. The pong must carry this app's instance id | `ENOENT`, `ECONNREFUSED`, `timeout`, `wrong-pong`, `other-instance` (another app owns the socket), `no-root` |
| `helpers-intact` | Reads `bin/hive-memory`, `bin/hive-node` and `bin/runtime/node` and compares them with what this app installs | `problems: {name: missing / not-regular / not-executable / stale / modified}`. `stale` = older than the bundled source (the app has not reinstalled it since an update; a restart fixes it). `modified` = different bytes |
| `node-on-path` | Looks for an executable `node` on the PATH agents are launched with (lookup only) | `not-found` |
| `model-matches-launch` | For each Claude agent launched this run: whether its newest ledger rows have been on a model other than its launch model for at least 10 minutes | `mismatched: [agent ids]`; `checked` is how many agents could be compared |

- `ok: null` with `detail: "off"` means the feature is disabled on this install.
- A failing canary only logs; it changes no behaviour.

**Security: a canary pass starts no child process and contacts nothing but loopback.**
- The main process never runs, requires or evals files under the hive root, because every agent can write there. The helpers agents run are only read and compared, and a test plants hostile helpers and asserts that a pass never runs them.
- Whether to probe memory is decided from settings alone, since even asking the MemPalace backend for its status can start a login-shell lookup.
- A second test drives the real memory adapters with child processes and `fetch` instrumented, for every backend setting.

**What is and is not probed:**

| Probed | Not probed |
|---|---|
| A loopback Hindsight server's search and wake-up | MemPalace (it spawns a CLI) |
| The knowledge graph (an in-process file read) | A non-loopback Hindsight server |
| The hook socket (a local Unix socket) | |
| The installed helpers (read only) | |
| `node` on PATH (lookup only) | |
| The ledger (read only) | |

**Known limits:**
- The memory canaries test the backend, not the agents' shim and launcher. `helpers-intact` covers the shim by comparing bytes, and `node-on-path` covers the launcher by lookup.
- `model-matches-launch` is an hourly sample. A model move that lasts under 10 minutes, or that comes and goes between passes, is missed.
- Agents launched with an alias (`opus`) or without `--model`, and agents launched before this app run, are not checked.
- The ledger is read from its last 512 KB, so an agent quiet for long drops out of `checked`.
- Ledger rows written with an empty model are ignored.

**Launch models (`kind: "agent-model"`).** Each Claude agent spawn records `{agentId, model}`. The canary keeps the same values in memory.

**Not covered:** the orchestrator's scheduled crons live inside its Claude Code session, which the harness cannot see.

### Quick reads
```sh
# Latest result per feature
grep '"kind":"canary"' log.jsonl | tail -5
# Failures in the last week
python3 - <<'PY'
import json, time
cut = (time.time() - 7 * 86400) * 1000
for l in open('log.jsonl'):
    if '"canary"' in l:
        e = json.loads(l)
        if e['ts'] > cut and e.get('ok') is False:
            print(e['ts'], e['feature'], e.get('detail'), e.get('mismatched'))
PY
```

## Floor events (`<hive>/log.jsonl`)

| kind | Fields | Written when |
|---|---|---|
| `turn` | `agentId?`, `startTs`, `durationMs`, `trigger` (`mail` / `heartbeat` / `scheduler` / `breaker` / `system` / `direct`), `from?`, `triggerRef?` (the message id, as a keyed ref), `cardId?` (when the conversation is a card) or `conversationRef?` | A Claude agent's turn ends (Stop hook). The trigger is the newest hive delivery that actually landed in that agent's inbox in the 10 minutes before its prompt (a bounced or dropped message is never a cause). `direct` means no delivery, so someone typed or the session resumed |
| `card-transition` | `sampled: true`, `cardId?`, `from?` (null for a new card), `to?` | A card's status differs between two reads of `tasks.json` (see "Sampled task rows" below). The first read after start is the baseline and logs nothing |
| `ask-filed` | `sampled: true`, `cardId?`, `askKey?` (`<cardId>@<askedAt as ISO>`) | A new `humanQA` entry appears |
| `ask-answered` | `sampled: true`, `cardId?`, `askKey?`, `msSinceAsked?`, `answerLen`, `answerShape` (`done-ack` / `option` / `short` / `sentence` / `long`) | An ask gets its answer. The answer text is never copied |
| `heavy-lock` `acquire` | adds `waitMs` | The agent had been queued for that slot |
| `hook-frame-rejected` | adds `agentId?`, `hookEvent?`, `toolName?` | Read from the top level of the first 4 KB of the oversized message (never from tool input or other nested content). The agent id only if it is on the roster; the event and tool as a known name, else `other` |

**Only ids the harness itself holds are written as they are.** A string an agent or a sender controls is written verbatim only when it belongs to a set the app holds: agent ids on the roster (or the fixed senders `heartbeat`, `scheduler`, `breaker`, `system`, `human`, `pipeline`), card ids in the current `tasks.json`, card statuses (`todo`, `doing`, `blocked`, `done`), and fixed lists of hook events and built-in tool names. A shape check is not enough: words joined with dots or dashes look like an id, and a sender can choose values shaped exactly like the router's own ids. So message ids and conversations are never written as they are: they become `triggerRef` / `conversationRef`, the first 12 hex of an HMAC-SHA-256 keyed with a random secret kept in the app's own data folder (not the hive). The one exception is a conversation that names a card in `tasks.json`, written as `cardId`. Rows can be grouped by refs, but the text cannot be read back or confirmed by guessing. If the secret file is found unreadable or short it is replaced once and a `usage-ref-secret-reset` row (no value) marks where refs stop matching earlier ones. Ask times are parsed and written back as ISO, never copied. A field that fails is left out and the rest of the row is kept.

The roster and `tasks.json` are themselves files agents can write: this rule keeps unintended text out of the log, and is not a defence against an agent that edits those files to plant text.

**Sampled task rows.** `tasks.json` is written directly by the orchestrator, so the app compares one read every 30 s with the previous one. These rows are therefore samples, and carry `sampled: true`: a card that goes `todo -> doing -> done` between two reads appears as one `todo -> done` row, and an ask filed and removed between reads never appears. For the same reason no row claims a time in state: `doing -> done` can hide `doing -> blocked -> done`. The weekly digest takes state hours from the rows' own timestamps and labels them as sampled. Authoritative transition events, one per change, arrive with the pipeline's card log; until then, read these rows as samples.

**Joining a turn to its message:** the router's own `message` row keeps the message id as it is, while the `turn` row has only `triggerRef`. To join them, compute the same ref over the message row's `id`: HMAC-SHA-256 keyed with the secret in the app's data folder (`usage-ref-secret`), first 12 hex. That is possible only on this machine, by design.

**Dollars per turn:** join `turn` spans with `cost-ledger.jsonl` rows for the same agent between `startTs` and `startTs + durationMs` (the `usd` column is cumulative per session, so take positive differences).

**Not logged:** review rounds and verdicts. Today they exist only in message text, so capturing them would mean logging content. They become measurable once verdicts are sent as structured fields.

## The owner's side (`<userData>/usage/YYYY-MM-DD.jsonl`)

These events have their own daily files, so they can be switched off and deleted on their own.

| | |
|---|---|
| **Where** | `<userData>/usage/`, the app's own data folder (on macOS `~/Library/Application Support/<app name>/usage/`), folder `0700`, files `0600`. Never the hive: the hive is a git repository that agents can read and write, so rows kept there could be read, changed or redirected by an agent and would be committed into its history. The hive's `.gitignore` also lists `usage/` |
| **Retention** | Day files and weekly digests older than 90 days are removed at start and daily |
| **Off switch and delete** | Settings → General → *Local usage log*; the switch takes effect when Settings is saved. **Delete usage log** removes what the app wrote in that folder: the daily `YYYY-MM-DD.jsonl` files and the weekly `digest-YYYY-Www.md` files. Any other file there is left alone, since the app did not write it. Delete also records its time in `.deleted-at`, and no digest is ever written for a week that began before it, so a delete stays a delete |
| **Allowlist** | `src/main/usageLog.ts`. Unknown kinds are refused and unknown fields dropped. Every string must be a known enum, a known view, or an agent or card id the app holds, so typed text cannot be written even by a buggy caller |
| **Outbound** | None. `test/usage-log-not-outbound.test.cjs` proves the analytics module drops every one of these kinds |

Every row carries `ts`, `v` (schema version), `session` (one id per app run), `win` (window id) and `focused`.

| kind | Fields | Written when |
|---|---|---|
| `ui-view` | `view`, `agentId?`, `cardId?` | A screen or panel opens: `command-center:<tab>`, `agent-detail:<sidebar tab>`, `settings`, `memory`, `task-detail`, `terminal-fullscreen`. `agentId` only when it is on the roster and `cardId` only when it is in `tasks.json`; otherwise the field is left out and the view still counts |
| `ui-view-end` | `view`, `dwellMs` | It closes or changes. `dwellMs` counts only time the window was visible and focused |
| `ask-shown` | `askKey` (`<cardId>@<ISO time>`, card in `tasks.json`; otherwise not written), `surface` (`ask-me`), `ageMs?` | An ask row on the Ask Me board has been on screen, with the window focused at both ends of 1 s (once per ask per window). If the window was not attended when the row scrolled in, the second starts when attention returns. `ageMs` is the time since it was asked |
| `ask-submitted` | `askKey`, `surface` (`ask-me`), `answerLen`, `answerShape`, `msSinceShown?` | An answer is sent from the Ask Me board. The text is never copied |
| `app-focus` | `state` (`focus` / `blur`) | A window gains or loses focus |
| `write-roots` | `agentId`, `provider` (fixed list, else `other`), `role` (`god` / `agent`), `source` (`claude-settings-files` / `codex-config` / `none`), `start` (`startup` / `resume` / `clear` / `compact` / `unknown`), `ordinal` (per spawn), `coalesced`, `effective`, `excess` | Every session start, re-read each time, so a settings change between two starts shows as two rows. Starts that wait together are one row with `coalesced` > 1; more than 8 between turn ends make the turn `write-incomplete` (reason `session-start-flood`). The write roots it was given, read back from the settings on disk plus its working directory, as path classes; `excess` is what scoped roots would not grant. `unsandboxed` means the sandbox is off or absent; `unknown` means the settings could not be read. Neither ever reads as scoped |
| `write-would-refuse` | `agentId`, `tool` (built-in names, `apply_patch`, `shell`, `exec_command`, `mcp`, else `other`), `via` (`edit` / `patch` / `shell-write` / `shell-named` / `shell-unsandboxed` / `truncated`), `pathClass` | A tool call would write, under scoped roots, somewhere it may not. Dry run only: nothing is refused. `truncated` means the call named more than 64 paths or took more than 25 ms to read, and the rest was not classed |
| `write-own-settings` | `agentId`, `tool`, `via` | A write to the agent's own `settings.json` or `.codex/`. Allowed under scoped roots, recorded because those files are to move out of the hive |
| `write-observed` | `agentId`, `tool`, `shape` (`command-string` / `command-array` / `cmd-string` / `cmd-array` / `file-path` / `patch` / `none` / `other` / `shed`), `count` | The agent's turn ends: how many tool calls of each tool and input shape the dry run saw since the last one. Tells "nothing to refuse" from "nothing seen". `shed` counts calls dropped because the queue was full |
| `write-incomplete` | `agentId`, `state` (`incomplete`), `reason` (`queue` / `cap` / `session-start-flood` / `quit`), `shed`, `burst` | The agent's turn ends (or its terminal closes, or the app quits) after some of its tool calls were shed (its queue was full), not counted (its counters were full), or its session starts flooded. Its data for that turn is incomplete, never clean |

**Scoped write roots (dry run).** Today every sandboxed agent may write the whole hive. Scoped roots give god the hive root and every other agent its own folder, `evidence/` and a working directory outside the hive (one inside or above the hive is never granted; an id that is not a plain folder name gets nothing). The events above record what that would refuse; the real sandbox settings are unchanged. Paths are recorded only as classes (`tasks.json`, `other agent folder`, `bin`, `research`, a name outside the known list as `hive root (other)`), never as paths; links and case variants are classed by where they land on disk. What it sees: Edit/Write targets and MCP tools whose name says they write, exactly; a Codex patch's file lines; for a shell command (string or argv array), redirect targets and the targets of known writers (`cp`, `mv`, `rm`, `tee`, `sed -i`, `dd of=`, ...) as `shell-write`, other hive paths it names as `shell-named` (often reads), never the program it runs; `$HIVE_ROOT`, `$AGENT_DIR`, `$HOME` and `~` are expanded; a command run outside the sandbox. What it cannot see: a path built at run time; a relative path after `cd` (it reads as the folder it is relative to, so `hive root` from a shell usually means this); writes made by a script a command runs (python, node, a heredoc); calls that do not go through the hook channel (background jobs, a provider without hooks); anything while the usage log is off. For Claude, the roots are read from every settings file the CLI merges (managed, the generated one, project, local, user); Claude's own built-in temp folders are outside the hive and not listed. The dry run never delays a hook's answer: the hook only queues the call (at most 8 tool calls waiting per agent, drained in turn; more are shed, counted, and the agent's turn reported incomplete), and the reading happens afterwards, one call per event-loop turn. Only agents this app run spawned are recorded (an id it did not spawn is never queued); their working directory, provider, role and launch line come from what the app spawned them with. The launch line is read with each CLI's own option grammar up to the first positional, so the prompt is never read: `--add-dir` directories count as roots, and a flag that changes the sandbox or where settings come from in a way not modelled, or an option the grammar does not know, reads as `unknown`. The full list of inputs and what a planted value does is `READ_SITES` in writeRoots.ts. Anything an agent can plant (a link or a file in place of its own folder or a settings file, an unreadable or oversized file, a sandbox choice it cannot read, a provider other than Claude or Codex, a platform without a sandbox) reads as `unknown`, never as scoped. Attribution is self-reported: the agent id comes from the hook payload, and any process that can reach the hook socket can file calls under another spawned agent's id. The dry run cannot authenticate it; a flood under a forged id can only shed that id's own calls, and shows as `write-incomplete`. It is a measure, not a control. Codex config is parsed with smol-toml and then checked for exactly the shape read. The decoder is stricter than Codex on purpose: any date, time or non-finite value anywhere makes the file unknown, because the parser and Codex can disagree on such values. Any other key whose name contains sandbox, permission, profile or writable_roots, at a position where Codex reads policy (a top-level key; a key directly inside one entry of projects, profiles or agents; a key directly inside [windows]), and that the decoder does not read (Codex's default_permissions and [permissions.x], for instance) also makes the file unknown, as does an agents entry's config_file, which the decoder does not follow. Free-form maps such as an env, shell_environment_policy.set, http_headers, an MCP server's tools, plugins and apps are not tested. Allowed by exact path: include_permissions_instructions (a Codex setting about prompt instructions, not the sandbox; source: Codex config reference, as cited in the review of this change); so does a legacy [profiles.x] that sets a sandbox key even when no profile is selected (conservative, accepted as a known limit). The parser accepts TOML 1.1.

**Reading it:**
- Time unseen = `ask-shown.ageMs`; time thinking = `ask-submitted.msSinceShown`.
- An ask filed (`ask-filed` in `log.jsonl`) with no `ask-shown` was never looked at.
- An ask shown with no answer was seen and left.

**Not logged:** keystrokes, typed text, clipboard, window titles, screenshots, and anything outside the app.

## Weekly digest (`<userData>/usage/digest-YYYY-Www.md`)

At start and once a day, while the usage log is on, the app writes the digest for the last full ISO week (UTC) if it does not exist yet. It is plain markdown built by code, with no model call and no network. It covers:
- agent turns and dollars by trigger;
- dollars by conversation (turn spans joined with the ledger);
- asks filed and answered, with answer shapes and the medians and p90s of time unseen and time thinking;
- asks filed in the week and not seen on the Ask Me board by the time the digest was written (the first 50 keys, then a count);
- screens by attended time; a view still open at the end of the week or when the app quit (no `ui-view-end`) is counted apart, with unknown dwell, not as zero;

When no owner-side day file covers the week (the log was off, or deleted), the owner-side parts (screens, time unseen and thinking, never seen) say "no data" instead of reporting empty results. Filed and answered asks count by the same rule: a valid key on a card that `tasks.json` holds.
- hours cards spent in each state, from the gaps between a card's consecutive transition rows (a restart breaks the chain; the rows are sampled, so a status passed through between reads gets no hours of its own);
- heavy-lock waits;
- canary failures.

The hive's log and `tasks.json` are files agents can write, so the digest never prints a string because it looks like an id. It prints only known values (triggers, statuses, answer shapes, views, lock kinds, canary features, and failure codes from a fixed list, with anything else shown as `other`), card ids that are id tokens and present in the current `tasks.json` (a turn's `cardId` and ask keys, whose time must be a real ISO time), and `ref:<hex>` for a conversation logged as a keyed ref. Dollars by conversation are grouped by those two only. The digest never joins a turn to its `message` row, so it needs neither the message id nor the ref secret.

It reads the hive log backwards, only as far as the week needs. The cost ledger is not in time order (an idle agent's unchanged row is re-appended with its old time), so it is read forward in full, in chunks, keeping each session's last row before the week as its baseline; this is one pass on the main process once a week and grows with the ledger. It only reads the hive (`log.jsonl`, `cost-ledger.jsonl`, `tasks.json`); the digest is written beside the owner's usage files in the app's data folder, never into the hive. The file is `0600` and is never rewritten. **Delete usage log** in Settings removes digests too. The daily research pass reads only the newest `digest-*.md` in `<userData>/usage/` (on macOS `~/Library/Application Support/<app name>/usage/`), never the raw `YYYY-MM-DD.jsonl` day files beside it, and never writes there.
