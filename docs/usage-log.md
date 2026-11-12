# Local usage log: how to read the data

Everything here stays on this machine.
- Events are appended to files under the hive folder.
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
| `turn` | `agentId?`, `startTs`, `durationMs`, `trigger` (`mail` / `heartbeat` / `scheduler` / `breaker` / `system` / `direct`), `from?`, `triggerId?` (the message id), `conversation?` | A Claude agent's turn ends (Stop hook). The trigger is the newest hive delivery that actually landed in that agent's inbox in the 10 minutes before its prompt (a bounced or dropped message is never a cause). `direct` means no delivery, so someone typed or the session resumed |
| `card-transition` | `sampled: true`, `cardId?`, `from?` (null for a new card), `to?`, `msInState?` | A card's status differs between two reads of `tasks.json` (see "Sampled task rows" below). The first read after start is the baseline and logs nothing |
| `ask-filed` | `sampled: true`, `cardId?`, `askKey?` (`<cardId>@<askedAt as ISO>`) | A new `humanQA` entry appears |
| `ask-answered` | `sampled: true`, `cardId?`, `askKey?`, `msSinceAsked?`, `answerLen`, `answerShape` (`done-ack` / `option` / `short` / `sentence` / `long`) | An ask gets its answer. The answer text is never copied |
| `heavy-lock` `acquire` | adds `waitMs` | The agent had been queued for that slot |
| `hook-frame-rejected` | adds `agentId?`, `hookEvent?`, `toolName?` | Read from the top level of the first 4 KB of the oversized message (never from tool input or other nested content), and kept only if id-shaped |

**Every string is validated, field by field.** Agent, card and conversation ids must be short id tokens (a letter or digit, then letters, digits, `_ . : -`, at most 80 characters); message ids must pass the router's own message-id check; statuses must be one of `todo`, `doing`, `blocked`, `done`; ask times are parsed and written back as ISO, never copied. A field that fails is left out and the rest of the row is kept, which is why most fields above are optional.

**Sampled task rows.** `tasks.json` is written directly by the orchestrator, so the app compares one read every 30 s with the previous one. These rows are therefore samples, and carry `sampled: true`: a card that goes `todo -> doing -> done` between two reads appears as one `todo -> done` row, and an ask filed and removed between reads never appears. `msInState` is written only when the same card's previous transition was seen ending in this row's `from` status and the move did not skip a status (between `todo` and `blocked` or `done`); otherwise it is left out rather than guessed. Authoritative transition events, one per change, arrive with the pipeline's card log; until then, read these rows as samples.

**Dollars per turn:** join `turn` spans with `cost-ledger.jsonl` rows for the same agent between `startTs` and `startTs + durationMs` (the `usd` column is cumulative per session, so take positive differences).

**Not logged:** review rounds and verdicts. Today they exist only in message text, so capturing them would mean logging content. They become measurable once verdicts are sent as structured fields.
