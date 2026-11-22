# MCP v2 (`server/mcp/v2`)

The second MCP surface: 15 resource-style tools, envelope v2, decision-ready
state, bound confirmations, localized text and response budgets. Served to
external clients by default; `SPECRAILS_MCP_V2=false` or
`desktop_settings.mcp_v2='false'` serves the v1 catalog in `../tools`
unchanged. In-app (first-party) mission turns always get the v1 catalog.

Contracts, file ownership per work package, helper APIs, test patterns and
budgets: [docs/internals/mcp-v2.md](../../../docs/internals/mcp-v2.md).

| Path | Role |
|---|---|
| `index.ts` | `registerV2Surface`, `v2Catalog`, flag and instructions exports |
| `core/registry.ts` | `defineTool`, the per-call pipeline (admission, tiers, fields, language, confirmation, envelope, size guard) |
| `core/envelope.ts` | envelope v2, `result()`, `V2ToolError`, minified rendering |
| `core/views.ts`, `core/cursor.ts`, `core/size-guard.ts` | common fields, views, cursors, response caps |
| `core/refs.ts` | global refs and fuzzy project resolution |
| `core/status-map.ts`, `core/decision-state.ts`, `core/decision-sources.ts` | status vocabulary, `DecisionState`, offers from domain rules |
| `core/confirm.ts` | confirmTokens (HMAC, single use, stale detection) and the spend threshold |
| `core/lang.ts`, `i18n/**` | language resolution and message catalogs |
| `core/text.ts` | shared value helpers (`present`, `asRecord`, `clip`, `clipDeep`) |
| `core/untrusted.ts` | untrusted-content pointers, `neutralize`, `reveal`, `clipUntrusted` |
| `core/loopback.ts` | loopback routes: `apiRow` (v1 errors), `api` (typed `V2ToolError`), `maybe` |
| `core/bus.ts` | bounded bus waits (`listen`, `waitMsOf`) |
| `core/forecast.ts` | cost forecasts: `launchForecast`/`scaledCost` (launches), `turnCostBand`/`turnCostFromLedger` (turns) |
| `core/commit-tracker.ts` | in-process `blueprint:<commitId>` tracking from `blueprint.commit_*` frames |
| `tools/*.ts` | one file per tool, owned by its work package |
| `instructions.ts` | server instructions (≤ 600 tokens; `prompts.test.ts` checks every protocol rule is stated) |
| `prompts.ts` | MCP prompts: start-my-day, review-waiting, ship-milestone, why-stuck |
| `guide.ts` | v2 guide topics for `specrails_system(help, topic)` and `specrails://guide/{topic}` |
| `docs-reference.ts` | generates `docs/agents/mcp.md` from the catalog (`UPDATE_MCP_DOCS=1` on `docs-reference.test.ts`) |
| `../connect/` | one-command connect for Claude Code and Codex (`/api/mcp-admin/connect`, `specrails-desktop mcp connect`) |
| `legacy.ts` | v1 tools as hidden aliases while v2 is served |
| `__fixtures__/harness.ts` | shared test harness (`registerTools` wires `dispatch` between tools) |

Tests: `npx vitest run server/mcp/v2` (the budget test needs the `js-tiktoken`
dev dependency).
