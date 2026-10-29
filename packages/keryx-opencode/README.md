# @gravionlabs/keryx-opencode

OpenCode plugin of [keryx](https://github.com/GravionLabs/keryx). It reports session state to the local keryx bus (`keryx serve`) with the same events as `keryx hook` does for Claude Code. No server dependencies: it only talks HTTP.

## Install

Add it to `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@gravionlabs/keryx-opencode"]
}
```

## Events

| OpenCode event | keryx event |
|:--|:--|
| `session.created` | `session.started` |
| `session.status` with status `busy` | `session.working` |
| `session.idle` | `session.idle` |
| `permission.asked`, `question.asked` | `session.waiting` |
| `session.idle` of a child session (subagent) | `subagent.finished` |
| `session.deleted` | `session.ended` |

Events carry `source: "opencode"`, the session id as `agentId`, the issue number from a branch `<type>/<nr>-<slug>`, and `sessionId`, `cwd`, `branch`, `issue`, `herdrPaneId` in `data`.

## Bus address

`KERYX_URL`, else `http://127.0.0.1:$KERYX_PORT`, else `http://127.0.0.1:4778`.

## Failure behaviour

If keryx is not running, the plugin logs once through OpenCode and drops the events. A report never takes longer than 500 ms and never throws, so the session is not affected.
