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
npm run eval:mcp -- --client claude --baseline eval/mcp/results/<v1>.json
npm run eval:mcp -- --client replay --scenario S15 --probe    # + load probe on the 100-project seed
```

Reports land in `eval/mcp/results/<date>-<client>[-v1]-<time>.{json,md}` (`--out` to change).

## What runs where

| Piece | File | Notes |
|---|---|---|
| Isolated instance | `lib/instance.mjs` | `tsx server/index.ts` with its own `SPECRAILS_REGISTRY_HOME` (default `~/.specrails-dev-mcpeval`), port 4400/4401, `SPECRAILS_HEADLESS=1`, `SPECRAILS_MCP_V2=true` (`false` with `--v1`), the sibling built Core, and on `PATH` first: the scripted engine, then the benchmark's fake installers. Reuses `scripts/benchmark/lib/server.mjs`, which signals only a listener started with that home |
| Scripted engine | `engine/claude`, `engine/scripted.mjs` | A stand-in `claude` CLI: Specrails runs cost $0 and are reproducible. Mode per spec through a marker in its text, `[eval-engine:<mode>]`: `complete` (plays architect/developer/reviewer through the role's own OpenSpec workflow tool and delivers), `stall` (each Core step takes `EVAL_ENGINE_STALL_S`, default 30 s), `limit` (Claude's session-limit message), `fail` (a provider error), `question` (the architect asks with options) |
| Logging proxy | `lib/proxy.mjs` | Stdio relay client ⇄ `mcp-bridge`, appending every JSON-RPC message with timestamps |
| Clients | `lib/clients.mjs` | Claude: `claude -p --output-format stream-json --mcp-config <temp> --strict-mcp-config`, only `mcp__specrails` and `ToolSearch` allowed. Codex: `codex exec --json` with a temp `CODEX_HOME/config.toml` holding only the Specrails server (`tool_timeout_sec = 90`). Both run with `HOME` set to a fresh directory under the work dir and a scrubbed environment |
| Simulated person | `lib/person.mjs` | Replies between turns (`--resume`): the scenario's yes/no to a pending preview, or its answer to a question |
| Scenarios | `lib/scenarios.mjs` | S1–S15 with seed, prompt, person, reference solution (`replay`), reference call count and checker |
| Metrics | `lib/metrics.mjs` | calls, tool names, errors (invalid args, wrong tool), confirmations requested/used, irreversible calls without a confirmToken, destructive calls, response tokens (o200k), catalog tokens (Codex shape, as the budget test), read latency, `wait` use, repeated identical reads |
| Report | `lib/report.mjs` | Pass bars of the plan, per-scenario table, failed assertions, savings vs v1, probe, quota |
| Load probe | `lib/probe.mjs` | Read mix over the 100-project seed (`--fleet n`), and `wait` wake-up after an HTTP change |

## Pending scenarios

A scenario runs only when every v2 tool it needs is implemented on the instance (probed at start: a stub answers
`not_implemented`, a v1 action served through the legacy bridge carries a deprecation warning) and it has a seed and
a checker. Today S1, S2 (blueprint), S8 (insights), S11, S12 (missions/Intent), S13 (`specrails mcp connect`) and
S14 (insights) are reported as `pending`. Wiring one = add `seed`, `reference` and `check` in `lib/scenarios.mjs`.

## Safety

- The home and ports of the person's apps (`~/.specrails`, `~/.specrails-dev`, 4200/4201, 4300/4301) are refused; a
  fresh boot (`--fresh`) wipes only a home that carries the harness's `.eval-mcp-home` marker.
- Clients never see `~/.claude` or `~/.codex`. A temp home has no sign-in: pass a credential in the environment
  (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, or `ANTHROPIC_API_KEY`; `OPENAI_API_KEY`/`CODEX_API_KEY` for
  Codex). Without one the scenario ends as `error: client not signed in`.
- Quota: before each Claude scenario the harness reads the 5-hour window through the isolated app's own
  subscription-usage reader and skips at `--stop-at-window` (default 70 %). `--max-cost-usd` (default $1) caps the
  client spend of one run.
- Repositories are throwaway, with local bare remotes under the work dir. Nothing is pushed elsewhere.

Tests: `node --test eval/mcp/*.test.mjs` (also part of `npm run test:scripts`; macOS/Linux).
