# Roadmap

Order of work and release assignment for the open issues. Written 2026-10-28 after the refinement of Epic #1 (dromos decision 004: dromos is archived at v0.4.0; its bus, Attention API and herdr plugin continue here, delivery is the `deliver` workflow of [apm-hub](https://github.com/GravionLabs/apm-hub)). No release yet. Each release has a GitHub milestone of the same name; work runs on `release/next` and the release PR into `main` is the human review point.

## Where we are

| Feature | State | Release |
| --- | --- | --- |
| #2 repository foundation and bus core | #3 and #4 merged | 0.1.0 |
| #5 session events from the harnesses | #6, #7 planned | 0.1.0 |
| #11 PR gates for model-driven harnesses | #12, #20, #13 planned | 0.1.0 |
| #8 Attention API | #9, #23 planned; #24 `needs-decision`; #10 closed | 0.2.0 |
| #14 herdr plugin | #15, #16, #25, #18, #19, #17 planned | 0.2.0 |

## 0.1.0 — bus, session events, gates

Release PBI #21. Gates come before session events because apm-hub#827 (OpenCode orchestrator) needs #12, #20 and #13, and ships in apm-hub 3.3.0 only if this release is out.

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| merged | #3 | scaffold: pnpm workspace with `keryx` and `keryx-opencode`, CI, release | S | — |
| merged | #4 | `keryx serve`, event store, ingest, SSE stream, `keryx event` | M | #3 |
| 1 | #12 | `keryx mcp` (stdio) with `run_gate` and `record_review`; keryx runs the gate commands itself | M | #4 |
| 2 | #20 | `open_pr` and `merge` refuse without a green gate; PR lifecycle events | M | #12 |
| 3 | #6 | `keryx hook <event>` and `keryx install claude` | M | #4 |
| 4 | #7 | `@gravionlabs/keryx-opencode` reports session state | M | #4, #3 |
| 5 | #13 | the OpenCode plugin denies `gh pr create` and `gh pr merge` | S | #20, #7 |
| last | #21 | release PBI: both packages on npm, README, CHANGELOG, release PR with `github-release` | S | all of the above |

Features #2, #5 and #11 close with the release.

## 0.2.0 — Attention API and herdr plugin

Release PBI #22. Attentions come from unattended implementation runs only; planning and refinement always ask in a session.

| Order | Issue | Title | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1 | #9 | Attention API from dromos with kinds `BLOCKED`, `APPROVAL`, `QUESTION`, options, actions and `keryx attention` CLI | M | #4 |
| 2 | #23 | an approved `APPROVAL` attention with a `merge` action merges its PR (rules of #20) | M | #9, #20 |
| 3 | #15 | herdr plugin skeleton: manifest, `keryx herdr` daemon, keryx and herdr socket clients | M | #4 |
| 4 | #16 | waiting sessions: notification and jump key | S | #15 |
| 5 | #25 | attentions in herdr: notification, jump and answer with options | M | #15, #9, #16 |
| 6 | #18 | status badge per pane from session and PR events | M | #15, #6, #7, #20 |
| 7 | #19 | cost per pane through the agentlens CLI (optional) | S | #18, agentlens#437 |
| 8 | #17 | start `/deliver <nr>` in a new pane | S | #15, apm-hub#826 |
| last | #22 | release PBI: herdr docs, CHANGELOG, release PR with `github-release` | S | #21, #9, #23, #15, #16, #25, #18 |

#17 and #19 move to the next release if they are not ready. Feature #14 closes with the release; Feature #8 closes unless #24 is still open.

## Not planned

| Issue | Reason |
| --- | --- |
| #24 `ask` tool for unattended OpenCode runs | `needs-decision`: only useful once OpenCode implementation runs unattended |
| #10 open questions of headless runs | closed: questions are asked in a session (`grill-me`, `deliver` phase 1) |

## Decided on 2026-10-28

| Topic | Decision |
| --- | --- |
| Gate trust (#12) | keryx runs the commands of `.agents/config.json` key `gate` itself; only the review verdict is reported by the agent |
| MCP transport (#12) | `keryx mcp` is a stdio server per session; state goes through `keryx serve`; `open_pr`, `merge` and #23 call `gh` |
| Split (#12, #20) | `run_gate`/`record_review` and `open_pr`/`merge` are separate PBIs |
| Packages (#3) | pnpm monorepo, `@gravionlabs/keryx` and `@gravionlabs/keryx-opencode` with one version |
| State and config (#4) | database at `${XDG_STATE_HOME:-~/.local/state}/keryx/keryx.db`, optional `${XDG_CONFIG_HOME:-~/.config}/keryx/config.json`, env overrides, default port 4778; a dromos database is not migrated |
| Hook install (#6) | `keryx install claude`, the JSON block only as documentation |
| PR and CI state (#18) | events only, posted by `deliver` (`keryx event`) or the gate tools; the herdr plugin never calls `gh` |
| Attention producers (#9) | `BLOCKED` with `retry`/`skip` from `deliver` (apm-hub#846), `APPROVAL` for the release PR (apm-hub#847, merged by #23), `QUESTION` open (#24) |
| agentlens (#19) | CLI with JSON output, at most one call per pane every 60 s; one session through the new filter `agentlens cost --session <id>` (agentlens#437), not by filtering `cost --by session` in keryx |

## Dependencies on other repositories

| Repository | Direction | Status |
| --- | --- | --- |
| apm-hub#827 OpenCode orchestrator | waits for 0.1.0 (#12, #20, #13) | planned for apm-hub 3.3.0, else 3.4.0 |
| apm-hub#826 `deliver` | #17 waits for it; it adds the `gate` key to `.agents/config.json` and posts PR events through `keryx event` | merged on apm-hub `release/next`, ships with 3.3.0 |
| apm-hub#846, #847 | wait for 0.2.0 (#9, #23) | apm-hub 3.4.0 |
| agentlens#437 `--session` filter | #19 reads `agentlens cost --session <id> --format json` | planned for agentlens 0.13; #19 moves if it is late |
| herdr 0.9.5 | #15 verifies the socket protocol and composer input | — |

## Risks

- apm-hub 3.3.0 (#827) and 3.4.0 (#846, #847) depend on keryx releases; a late keryx moves them, not the other way round.
- The `gate` key belongs to the schema of apm-hub (#830, #826). If it changes shape there, #12 changes with it.
- The herdr protocol was verified against 0.8 only; #15 re-verifies on 0.9.5. Without composer input, #25 falls back to a pane running `keryx attention answer`.
- #23 merges without a human at the keyboard; it must refuse on any doubt (checks pending beyond 30 min, head changed, `gh` missing).
