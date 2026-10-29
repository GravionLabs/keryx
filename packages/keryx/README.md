# @gravionlabs/keryx

Local event bus for Claude Code and OpenCode sessions. Part of [keryx](https://github.com/GravionLabs/keryx).

```sh
keryx serve                                  # bus on 127.0.0.1:4778, in the foreground
keryx install claude                         # register the Claude Code hooks
keryx event session.idle --issue 4 --data '{"model":"x"}'   # post one event; exit 0 when keryx is not running
keryx attention create --kind BLOCKED --issue 7 --summary "PBI #7 is blocked" --option retry --option skip   # prints the id
keryx attention list --state answered --json # a later run reads the answers
```

## Claude Code hooks

```sh
keryx install claude              # adds the hooks to ~/.claude/settings.json
keryx install claude --project    # .claude/settings.json of the current directory
keryx install claude --uninstall  # removes only the keryx entries
```

Installing is idempotent and leaves other hooks untouched. `keryx hook <event>` reads the hook JSON from stdin and posts the event (source `claude-code`, `agentId` the session id) with `sessionId`, `cwd`, `branch`, `issue` (from a branch `<type>/<nr>-<slug>`, else `null`) and `herdrPaneId` (`HERDR_PANE_ID`) in `data`. It always exits 0 without output, within 500 ms, also when keryx is not running.

| Hook | Event |
|:--|:--|
| `SessionStart` | `session.started` |
| `UserPromptSubmit` | `session.working` |
| `Stop` | `session.idle` |
| `Notification` | `session.waiting` |
| `SubagentStop` | `subagent.finished` |
| `SessionEnd` | `session.ended` |

The same by hand, in `settings.json`:

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "keryx hook SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "keryx hook UserPromptSubmit" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "keryx hook Stop" }] }],
    "Notification": [{ "hooks": [{ "type": "command", "command": "keryx hook Notification" }] }],
    "SubagentStop": [{ "hooks": [{ "type": "command", "command": "keryx hook SubagentStop" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "keryx hook SessionEnd" }] }]
  }
}
```

## HTTP API

| Route | |
|:--|:--|
| `POST /ingest` | one event or an array (max 100, 1 MiB); `202 {"ids":[...]}`. Body: `source`, `type`, optional `agentId`, `issue`, `repo`, `data` (object). `id` and `at` are set by the bus. |
| `GET /events` | query: `issue`, `repo`, `type`, `source` (comma lists), `agentId`, `since`, `until`, `after`, `limit` (1 to 1000); returns `{events, next}` |
| `GET /events/stream` | Server-Sent Events; resumes after `Last-Event-ID` (or `?since=`), then live |
| `POST /attention` | creates an attention, `201` with the record; see [Attention](#attention) |
| `GET /attention` | query: `state` (`open`, `answered`, `acked`), `kind`, `issue`, `since`, `limit` (1 to 1000); returns `{attention: [...]}`, oldest first |
| `POST /attention/<id>/answer` | `{"text","by"}`; `200` with the record |
| `POST /attention/<id>/ack` | `{"by"}` (optional); `200` with the record |
| `GET /health` | `{"ok":true}` |

The bus listens on loopback only and rejects a `Host` or `Origin` that is not loopback. The event shape is in [`schema/events.schema.json`](schema/events.schema.json) (`pnpm --filter @gravionlabs/keryx run schema` regenerates it).

## Attention

A question that waits for a human, from a run nobody watches. Body of `POST /attention`: `kind` (`BLOCKED`, `APPROVAL`, `QUESTION`), `issue` (positive integer), `summary` (1 to 2000 characters), optional `options` (1 to 16 strings), optional `action` (an object for a consumer, for example `{"type":"merge","pr":123}`), `repo`, `agentId`.

An attention moves `open` -> `answered` -> `acked`; each step records one event with source `keryx` and the issue of the attention: `attention.created`, `attention.answered` (`id`, `text`, `by`), `attention.acked` (`id`, `by`). With `options` the answer must be one of them (`400` otherwise); without, any text up to 4000 characters. `404` for an unknown id, `409` when the state does not allow the step (a second answer, an ack before the answer). `by` is self-asserted, a label and not an identity. `POST /ingest` refuses `attention.*` types with `403`.

```sh
keryx attention create --kind APPROVAL --issue 12 --summary "Merge the release PR?" \
  --option merge --option wait --action '{"type":"merge","pr":123}'   # prints the id
keryx attention list [--state open|answered|acked] [--kind <kind>] [--issue <nr>] [--json]
keryx attention answer <id> merge [--by jerome]
keryx attention ack <id> [--by deliver]
```

`create` exits 0 with a notice on stderr and no id when keryx is not running, so producers never fail on a missing keryx. The other commands exit 1 then.

## Gates (`keryx mcp`)

`keryx mcp` is a stdio MCP server, started per session by the harness (for example `{"command": "keryx", "args": ["mcp"]}`). It reports to `keryx serve` (same URL resolution as `keryx event`); without a running bus every tool fails with a message naming `keryx serve`.

| Tool | |
|:--|:--|
| `run_gate` | runs the shell commands of the key `gate` in `<git toplevel>/.agents/config.json` itself, in order, stops at the first failure, and records `gate.finished` (commit, passed, failing command, tail of its output). Refuses without a `gate` key or with uncommitted changes and records nothing. |
| `record_review` | records `review.recorded` for HEAD: `verdict` (`approve` or `changes`), optional `summary`, `findings` (`severity`, `file`, `line`, `summary`) |
| `gate_state` | last gate result and last review verdict recorded for a commit (default HEAD); `open_pr` and `merge` decide on it |
| `open_pr` | `gh pr create` for the current branch into `base` (default `release/next`). Refuses unless HEAD has a passing `gate.finished` and an `approve` `review.recorded`; records `pr.opened` (PR number, branch, commit). |
| `merge` | `gh pr merge --squash` for `pr`. Refuses unless HEAD is the gated and approved commit, is the head of the PR, and every required check is green (`gh pr checks --required`; none or pending also refuse). Records `ci.finished` (PR, passed, checks) when it read a finished result, then `pr.merged`. |

Every refusal of `open_pr` and `merge` is recorded as `pr.refused` (`action`, `reason`, commit, PR). `gh` is called with an argument array; if it is missing or not authenticated the tool fails with a message saying so and nothing is recorded as passed. The lifecycle events `pr.opened`, `ci.finished`, `pr.merged` and `pr.refused` are plain bus events, so `keryx event pr.merged --issue 20 --data '{"pr":42}'` posts the same thing from `deliver`.

```json
{ "gate": ["pnpm install --frozen-lockfile", "pnpm run check"] }
```

## Configuration

| | |
|:--|:--|
| Config file | `${XDG_CONFIG_HOME:-~/.config}/keryx/config.json`: `{"host": "127.0.0.1", "port": 4778}` |
| Environment | `KERYX_HOST`, `KERYX_PORT` override the file; `KERYX_URL` is the bus URL for clients (default from host and port) |
| Event store | `${XDG_STATE_HOME:-~/.local/state}/keryx/keryx.db` (SQLite), next to `bus.log` |
