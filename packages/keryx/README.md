# @gravionlabs/keryx

Local event bus for Claude Code and OpenCode sessions. Part of [keryx](https://github.com/GravionLabs/keryx).

```sh
keryx serve                                  # bus on 127.0.0.1:4778, in the foreground
keryx install claude                         # register the Claude Code hooks
keryx event session.idle --issue 4 --data '{"model":"x"}'   # post one event; exit 0 when keryx is not running
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
| `GET /health` | `{"ok":true}` |

The bus listens on loopback only and rejects a `Host` or `Origin` that is not loopback. The event shape is in [`schema/events.schema.json`](schema/events.schema.json) (`pnpm --filter @gravionlabs/keryx run schema` regenerates it).

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
