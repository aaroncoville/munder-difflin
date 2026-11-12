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

| feature | What it runs | `ok:false` details |
|---|---|---|
| `memory-search` | The installed `hive-memory search` shim, with the memory env an agent gets | `refused-<HTTP code>` (the backend rejected the request), `unavailable` (backend unreachable), `exit-<n>` |
| `memory-wakeup` | `hive-memory wake-up` | Same as above |
| `kg-search` | The knowledge-graph CLI's `search` | `exit-<n>` |
| `hook-socket` | A ping over the hook socket, the way a hook shim connects | `ENOENT` (nothing at the path), `ECONNREFUSED`, `timeout`, `wrong-pong`, `no-root` |
| `model-matches-launch` | For each Claude agent: the newest `cost-ledger.jsonl` model written after its launch, compared with its launch model | `ok:false` with `mismatched: [agent ids]`; `checked` is how many agents could be compared |

- `ok: null` with `detail: "off"` means the feature is disabled on this install, so there was nothing to check.
- A failing canary only logs; it changes no behaviour.

**Launch models (`kind: "agent-model"`).** Each Claude agent spawn records `{agentId, model}`. The model check compares against this line. Agents launched with an alias such as `opus` are skipped, because an alias cannot be matched to a full model id.

**Not covered:** the orchestrator's scheduled crons live inside its Claude Code session, which the harness cannot see, so there is no cron canary.

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
