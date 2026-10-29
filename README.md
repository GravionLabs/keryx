# keryx

Local event bus, Attention API and PR gates for Claude Code and OpenCode sessions, with a herdr plugin.

Successor of the bus part of [dromos](https://github.com/GravionLabs/dromos) (archived, see its decision 004). Delivering issues end to end is the `deliver` workflow of [apm-hub](https://github.com/GravionLabs/apm-hub) (apm-hub#821); keryx adds what no harness offers on its own:

- **Events**: Claude Code hooks and an OpenCode plugin report session state to one local bus.
- **Attention**: questions that wait for a human, with an id and a state.
  An `APPROVAL` attention with action `{ "type": "merge", "pr": <nr>, "repo": "<owner>/<repo>" }` is merged by `keryx serve` once you answer `approve`, if the PR head is unchanged and every required check is green (`approval.failed` otherwise).
- **Gates**: MCP tools that refuse to open or merge a PR without a green gate, for model-driven harnesses.
- **herdr**: a plugin that shows per pane which session needs you.

## Packages

| Package | Purpose |
|:--|:--|
| [`@gravionlabs/keryx`](packages/keryx) | CLI and server (bin `keryx`) |
| [`@gravionlabs/keryx-opencode`](packages/keryx-opencode) | OpenCode plugin, no server dependencies |

## Development

```sh
pnpm install
pnpm run check   # build, typecheck, lint, test
```

See [AGENTS.md](AGENTS.md) for the repository conventions. Licensed under [MIT](LICENSE).

Status: in development, no release yet. Order of work and releases: [ROADMAP.md](ROADMAP.md).
