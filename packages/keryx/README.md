# @gravionlabs/keryx

Local event bus for Claude Code and OpenCode sessions. Part of [keryx](https://github.com/GravionLabs/keryx).

```sh
keryx serve                                  # bus on 127.0.0.1:4778, in the foreground
keryx event session.idle --issue 4 --data '{"model":"x"}'   # post one event; exit 0 when keryx is not running
```

## HTTP API

| Route | |
|:--|:--|
| `POST /ingest` | one event or an array (max 100, 1 MiB); `202 {"ids":[...]}`. Body: `source`, `type`, optional `agentId`, `issue`, `repo`, `data` (object). `id` and `at` are set by the bus. |
| `GET /events` | query: `issue`, `repo`, `type`, `source` (comma lists), `agentId`, `since`, `until`, `after`, `limit` (1 to 1000); returns `{events, next}` |
| `GET /events/stream` | Server-Sent Events; resumes after `Last-Event-ID` (or `?since=`), then live |
| `GET /health` | `{"ok":true}` |

The bus listens on loopback only and rejects a `Host` or `Origin` that is not loopback. The event shape is in [`schema/events.schema.json`](schema/events.schema.json) (`pnpm --filter @gravionlabs/keryx run schema` regenerates it).

## Configuration

| | |
|:--|:--|
| Config file | `${XDG_CONFIG_HOME:-~/.config}/keryx/config.json`: `{"host": "127.0.0.1", "port": 4778}` |
| Environment | `KERYX_HOST`, `KERYX_PORT` override the file; `KERYX_URL` is the bus URL for clients (default from host and port) |
| Event store | `${XDG_STATE_HOME:-~/.local/state}/keryx/keryx.db` (SQLite), next to `bus.log` |
