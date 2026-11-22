# MCP v2 evaluation harness

Measures whether a person can run Specrails from Claude Code or Codex alone (design §14 of the MCP v2 plan,
[internals](../../docs/internals/mcp-v2.md)). Each scenario is a natural-language task given to a real agent
client; a checker then verifies the **end state through the app's HTTP API**, and metrics come from the
**MCP server side** (a logging proxy in front of the bridge).

```sh
npm run eval:mcp -- --client replay --scenario all            # reference solutions, no model, $0
npm run eval:mcp -- --client claude --scenario S5 --repeat 3  # Claude Code (haiku by default)
npm run eval:mcp -- --client codex  --scenario S3,S15
npm run eval:mcp -- --client claude --scenario all --v1       # v1 baseline (flag off) for the token bar
npm run eval:mcp -- --client codex  --scenario S14 --auth session  # the person's own sign-in, config untouched
npm run eval:mcp -- --client claude --baseline eval/mcp/results/<v1>.json
npm run eval:mcp -- --client replay --scenario S15 --probe    # + load probe on the 100-project seed
```

Reports land in `eval/mcp/results/<date>-<client>[-v1]-<time>.{json,md}` (`--out` to change).

## What runs where

| Piece | File | Notes |
|---|---|---|
| Isolated instance | `lib/instance.mjs` | `tsx server/index.ts` with its own `SPECRAILS_REGISTRY_HOME` (default `~/.specrails-dev-mcpeval`), port 4400/4401, `SPECRAILS_HEADLESS=1`, `SPECRAILS_MCP_V2=true` (`false` with `--v1`), the sibling built Core, and on `PATH` first: the scripted engine, then the benchmark's fake installers. Reuses `scripts/benchmark/lib/server.mjs`, which signals only a listener started with that home |
| Scripted engine | `engine/claude`, `engine/scripted.mjs`, `engine/builder.mjs` | A stand-in `claude` CLI: Specrails runs cost $0 and are reproducible. Mode per spec through a marker in its text, `[eval-engine:<mode>]`: `complete` (plays architect/developer/reviewer through the role's own OpenSpec workflow tool and delivers), `stall` (each Core step takes `EVAL_ENGINE_STALL_S`, default 30 s), `limit` (Claude's session-limit message), `fail` (a provider error), `flaky` (a provider error on a project's first Core step only, as a passing 500: S7's Continue then completes), `question` (the architect asks with options). The stand-in `codex` also serves `codex app-server --listen stdio://` (`engine/codex-app-server.mjs`): mission turns on Codex (S11) get one scripted answer |
| Logging proxy | `lib/proxy.mjs` | Stdio relay client ⇄ `mcp-bridge`, appending every JSON-RPC message with timestamps |
| Clients | `lib/clients.mjs` | Claude: `claude -p --output-format stream-json --mcp-config <temp> --strict-mcp-config`, only `mcp__specrails` and `ToolSearch` allowed. Codex: `codex exec --json` with a temp `CODEX_HOME/config.toml` holding only the Specrails server (`tool_timeout_sec = 90`). Both run with `HOME` set to a fresh directory under the work dir and a scrubbed environment (`--auth session`: see Safety) |
| Simulated person | `lib/person.mjs`, `lib/person-dialog.mjs` | Answers from the keyboard. Between turns (`--resume`): when the agent's message ends with a numbered menu, the number of the item the scenario wants (`person.pick`; yes/no for a preview; else the first, recommended one), never "Something else"; its one free-text answer (`person.freeText`) only where no item fits; without a menu, the old chat words (counted as free text). In the server's forms (MCP elicitation) it picks an option id or writes that free text (`formAnswer`): the replay client declares form elicitation and answers choice forms this way, cancelling confirmations so the token flow runs; Claude Code's project-level `Elicitation` hook (scenario's temp cwd) answers choice forms the same way and confirmations with the scenario's yes/no (`--no-dialog`: chat only). Codex `exec` declines forms, so it stays on the chat menus |
| Scenarios | `lib/scenarios.mjs` | S1–S17 with seed, prompt, person, reference solution (`replay`), reference call count and checker |
| Metrics | `lib/metrics.mjs` | calls and logical actions (a preview plus the call that confirms it count as one: the protocol requires both, the preview does no work and the person's decision sits between them; the calls bar uses logical actions against `referenceLogical`, raw calls are reported next to it), confirmations given in the client dialog (counted only when the server marks `confirmed: "in_client"` and the log shows the dialog's accept during that call), tool names, errors (invalid args, wrong tool), confirmations requested/used, irreversible calls without a confirmToken, destructive calls, response tokens (o200k), catalog tokens (Codex shape, as the budget test), read latency, `wait` use, repeated identical reads |
| Report | `lib/report.mjs` | Pass bars of the plan, per-scenario table, failed assertions, savings vs v1, probe, quota. Two choice bars (`decisionMetrics`): **every decision reaches the person as choices** (each server form, choice or confirmation, plus each agent turn that waited for the person, which counts only when its message carried a numbered menu) and **keyboard-only completion** (of the scenarios where the person answered, those that passed with numbers, option ids or form buttons and at most one free-text answer) |
| Load probe | `lib/probe.mjs` | Read mix over the 100-project seed (`--fleet n`), and `wait` wake-up after an HTTP change |

## Scenarios that need more than HTTP

All 17 scenarios have a seed, a reference solution and an HTTP checker. A scenario is reported `pending` only when a
v2 tool it needs is not implemented on the instance (probed at start: a stub answers `not_implemented`, a v1 action
served through the legacy bridge carries a deprecation warning).

- **S1/S2 (blueprint):** the scripted engine answers Project Builder turns (a system prompt carrying the
  `blueprint-draft` contract) with a complete, gate-valid snapshot of five Milestone-1 specs (`engine/builder.mjs`,
  mirroring the server's premium spec fixtures). A marker in the person's idea rides into the first spec, so S2's seed
  (`[eval-engine:question]`) makes the chain's first run ask; seeds that need MCP-only states use the probe connection
  (`ctx.mcp`), whose calls never count as the scenario's. Builder projects are created under the work dir.
- **S12 (Intent):** the seed starts a real Intent session on the scripted engine and trashes spec 9.
- **S16 (continue an open Intent):** the seed starts an Intent; the agent sends it a request, answers the Intent
  agent's ```options choice and hands it off (default rail, mission engine). The stand-in `claude` also plays Core
  agent sessions (`--input-format stream-json`: one scripted turn per input, with the CLI's `command_lifecycle`
  frames); an Intent turn answers a request with a choice. The checker fails if any reply sends the person to the app.
- **S17 (change a few settings by talking):** the seed sets a $10 app daily cap and every notification on; the agent raises the cap to $25 (costly: confirmed), adds `npm test` as a verification command (risky: confirmed; the window's one-line grammar, the project's only repository) and turns off the finished-run notifications. The checker reads `/budget`, the project's runtime config and `/attention-prefs`.
- **S13 (connect):** a second, throwaway instance (port 4402) runs with `HOME` set to a fresh directory, because
  `mcp connect` edits the client configuration of the server's home. The reference runs
  `specrails-desktop mcp connect --client claude --json`; the checker starts the entry it wrote, as a new client
  session would, and verifies that the person's own `~/.claude.json` is untouched. A scenario's `teardown` stops it.

## Safety

- The home and ports of the person's apps (`~/.specrails`, `~/.specrails-dev`, 4200/4201, 4300/4301) are refused; a
  fresh boot (`--fresh`) wipes only a home that carries the harness's `.eval-mcp-home` marker.
- By default (`--auth temp`) clients never see `~/.claude` or `~/.codex`. A temp home has no sign-in: pass a credential
  in the environment (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`;
  `OPENAI_API_KEY`/`CODEX_API_KEY` for Codex). Without one the scenario ends as `error: client not signed in`.
- `--auth session` uses the person's current sign-in without changing their configuration. Claude Code runs with the
  real `HOME` (its login is in the keychain), a temp cwd under the work dir, `--strict-mcp-config` with a temp config
  holding only the eval server, `--setting-sources project,local` (no user settings, hooks, plugins or `CLAUDE.md`),
  only `mcp__specrails` + `ToolSearch` allowed (`--permission-mode dontAsk`, no `--dangerously-*`) and
  `--max-budget-usd`. Codex reads auth from the real `~/.codex` but runs `--ignore-user-config --ignore-rules`; the
  eval server, approval/sandbox and `model_reasoning_effort` (`--effort`, default `low`) come only from `-c`
  overrides, and apps, plugins, hooks, sub-agents and browser/computer use are `--disable`d. No credential is
  forwarded from the environment. What the clients still write themselves: session transcripts
  (`~/.claude/projects/<temp-cwd slug>/`, `~/.codex/sessions/`), Codex's state/log SQLite and caches, and Claude
  Code's feature-flag caches inside `~/.claude.json` (`cachedGrowthBookFeatures` and friends). Snapshot the
  configuration files before and after a live run to verify.
- Quota: before each Claude scenario the harness reads the 5-hour window through the isolated app's own
  subscription-usage reader and skips at `--stop-at-window` (default 70 %). `--max-cost-usd` (default $1) caps the
  client spend of one run.
- Repositories are throwaway, with local bare remotes under the work dir. Nothing is pushed elsewhere. A seeded
  project commits what registration leaves uncommitted (as a real project would). The agent files the first run
  installs stay untracked: a local integration stashes them and puts them back after the merge (Specrails' own setup
  files the delivery also committed take the delivered copy; only the person's own differing files need attention).
- Between scenarios: a provider quota refusal that outlives a scenario (S4's scripted Claude limit) would hold every
  later run, so the harness stops the instance, drops the persisted refusal from its own `desktop.sqlite` and boots it
  again. Each turn's raw client stream is kept as `clients/<scenario>/turn-<n>.jsonl`.

Tests: `node --test eval/mcp/*.test.mjs` (also part of `npm run test:scripts`; macOS/Linux).
