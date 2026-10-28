# keryx

Local event bus, Attention API and PR gates for Claude Code and OpenCode sessions, with a herdr plugin.

Successor of the bus part of [dromos](https://github.com/GravionLabs/dromos) (archived, see its decision 004). Delivering issues end to end is the `deliver` workflow of [apm-hub](https://github.com/GravionLabs/apm-hub) (apm-hub#821); keryx adds what no harness offers on its own:

- **Events**: Claude Code hooks and an OpenCode plugin report session state to one local bus.
- **Attention**: questions that wait for a human, with an id and a state.
- **Gates**: MCP tools that refuse to open or merge a PR without a green gate, for model-driven harnesses.
- **herdr**: a plugin that shows per pane which session needs you.

Status: planning. See the Epic in the issues.
