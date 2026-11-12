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
| `memory-search` | The memory backend's search, called in-process with the owner tag agents send (god's id). `hits` is a count | `refused-<HTTP code>`, `error`, `timeout`. `ok:true` with `detail: "no-hits"` means it answered but recalled nothing |
| `memory-wakeup` | The backend's wake-up, called in-process | Same as above |
| `kg-search` | The knowledge graph's search, called in-process. `hits` is a count | `timeout`, `threw`. `no-hits` as above |
| `hook-socket` | A ping over the hook socket. The pong must carry this app's instance id | `ENOENT`, `ECONNREFUSED`, `timeout`, `wrong-pong`, `other-instance` (another app owns the socket), `no-root` |
| `helpers-intact` | Reads `bin/hive-memory`, `bin/hive-node` and `bin/runtime/node` and compares them with what this app installs | `problems: {name: missing / not-regular / not-executable / stale / modified}`. `stale` = older than the bundled source (the app has not reinstalled it since an update; a restart fixes it). `modified` = different bytes |
| `node-on-path` | Looks for an executable `node` on the PATH agents are launched with (lookup only) | `not-found` |
| `model-matches-launch` | For each Claude agent launched this run: whether its newest ledger rows have been on a model other than its launch model for at least 10 minutes | `mismatched: [agent ids]`; `checked` is how many agents could be compared |

- `ok: null` with `detail: "off"` means the feature is disabled on this install.
- A failing canary only logs; it changes no behaviour.

**Security: canaries never execute anything.** The main process does not run, require or eval files under the hive root, because every agent can write there. Backends are probed in-process, and the helpers agents run are only read and compared. A test plants hostile helpers and asserts that a pass never runs them.

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
