# Working on specrails-desktop

## Start with the smallest useful context

Specrails Desktop is a local Tauri application with a React UI and a Node server
that orchestrates projects, agents, jobs, loops and PR delivery. Keep changes
scoped to the feature and preserve project isolation and recovery semantics.

1. Inspect `git status --short`, the affected entry point and its nearest tests.
2. Read the relevant row below, then the referenced source. Use `rg` to find
   consumers before changing a contract. Do not load all reference documents.
3. For module design, read [the architecture decision](docs/internals/modular-architecture.md)
   and [source boundaries](docs/internals/source-architecture.md).
4. For an unfamiliar path, search [the generated source map](docs/internals/source-map.md).
   It links source/build files and nearby tests. It is a lookup index, not required context.
5. Treat [historical notes](docs/internals/legacy-implementation-notes.md) as optional
   feature background; verify their claims against current code and tests.

## Locate the feature

| Concern | Entry points and contracts | Focused reference |
| --- | --- | --- |
| Startup and composition | [server/index.ts](server/index.ts), [project-registry.ts](server/project-registry.ts), [project-router.ts](server/project-router.ts) | [architecture](docs/internals/architecture.md), [API](docs/internals/api-reference.md) |
| Project settings module | [public API](server/modules/project-settings/index.ts), [domain](server/modules/project-settings/domain.ts), [port](server/modules/project-settings/ports.ts), [use cases](server/modules/project-settings/application.ts), [HTTP](server/modules/project-settings/adapters/http.ts), [SQLite](server/modules/project-settings/adapters/sqlite.ts) | [module guide](server/modules/project-settings/README.md), [architecture tests](server/modules/architecture.test.ts) |
| Persistence and migrations | [db facade](server/db.ts), [connection](server/db/connection.ts), [migrations](server/db/migrations.ts), [jobs](server/db/jobs.ts), [desktop DB](server/desktop-db.ts) | [source boundaries](docs/internals/source-architecture.md), [DB tests](server/db.test.ts) |
| Queue, cancellation, recovery | [queue-manager.ts](server/queue-manager.ts), [interactive-job-session.ts](server/interactive-job-session.ts), [spawn-lifecycle.ts](server/spawn-lifecycle.ts) | [interactive jobs](docs/internals/interactive-jobs.md), [startup recovery](docs/internals/startup-recovery-audit.md) |
| Loop execution | [loop-run-manager.ts](server/loop-run-manager.ts), [loop-executors.ts](server/loop-executors.ts), [loop-graph.ts](server/loop-graph.ts), [loop-runs-store.ts](server/loop-runs-store.ts) | [loop logs](docs/internals/loop-step-log-explorer.md), [companion contract](docs/internals/companion-rails-as-loops-contract.md) |
| Rails and PR decisions | [rails-router.ts](server/rails-router.ts), [rail-isolated-launch.ts](server/rail-isolated-launch.ts), [rail-pr-decision.ts](server/rail-pr-decision.ts), [rail-merge-orchestrator.ts](server/rail-merge-orchestrator.ts) | [safe PR flow](docs/internals/safe-pr-review-flow.md), [review packet](docs/internals/review-packet.md) |
| AI providers and runtime | [provider contract](server/providers/types.ts), [registry](server/providers/registry.ts), [runtime bridge](server/agent-runtime-bridge.ts), [runtime settings](server/agent-runtime-settings.ts) | [adding providers](docs/internals/adding-a-provider.md), [programmatic runtime](docs/internals/programmatic-agent-runtime.md) |
| Chats and missions | [chat-manager.ts](server/chat-manager.ts), [agent-chat-manager.ts](server/agent-chat-manager.ts), [AgentChatContext](client/src/context/AgentChatContext.tsx) | [mission rail cards](docs/internals/mission-rail-cards.md), [MCP mission audit](docs/internals/mcp-mission-audit.md) |
| Specs, tickets, project builder | [ticket-store.ts](server/ticket-store.ts), [project-router-tickets.ts](server/project-router-tickets.ts), [milestone-chain.ts](server/milestone-chain.ts), [DashboardPage](client/src/pages/DashboardPage.tsx) | [project builder](docs/internals/project-builder.md), [spec addenda](docs/internals/spec-addenda.md) |
| Accounting and telemetry | [ai-invocations.ts](server/ai-invocations.ts), [spending.ts](server/spending.ts), [result-event.ts](server/result-event.ts), [integer allocation](server/util/distribute-int.ts) | [cost audit](COST-ACCOUNTING-AUDIT.md), [analytics audit](ANALYTICS-AUDIT-REPORT.md) |
| Browser and code exploration | [browser-capture-manager.ts](server/browser-capture-manager.ts), [browser-playwright.ts](server/browser-playwright.ts), [code-explorer-router.ts](server/code-explorer-router.ts) | [browser performance](docs/internals/browser-capture-performance.md), [login popups](docs/internals/browser-login-popups.md), [file stories](docs/internals/code-explorer-story.md) |
| Frontend shell and state | [App.tsx](client/src/App.tsx), [useDesktop](client/src/hooks/useDesktop.tsx), [API](client/src/lib/api.ts), [project cache](client/src/hooks/useProjectCache.ts) | [visual design](docs/internals/visual-design-audit.md), [client test config](client/vitest.config.ts) |
| Jira and integrations | [Jira sync](server/jira/jira-sync-manager.ts), [Jira client](server/jira/jira-client.ts), [IntegrationsPage](client/src/pages/IntegrationsPage.tsx) | [configuration](docs/internals/configuration.md) |
| Local engines and MCP | [local runner](local-runner/src/runner.ts), [MCP bridge](mcp-bridge/src/bridge.ts), [MCP tools](server/mcp/index.ts) | [local runner](docs/internals/local-agent-runner.md), [runtime evaluation](docs/internals/agent-runtime-framework-evaluation.md) |
| Packaging and native shell | [Tauri manifest](src-tauri/Cargo.toml), [build-sidecar](scripts/build-sidecar.mjs), [package checks](scripts/check-package.mjs), [CI](.github/workflows/ci.yml) | [operations](docs/internals/operations-runbook.md), [Windows](docs/platforms/windows.md), [Core updates](docs/internals/core-runtime-updates.md) |

## Design rules

- Prefer a modular monolith organized by business capability. New bounded modules
  use `server/modules/<capability>/`; do not move legacy files solely for symmetry.
- Use the module's public `index.ts`. Composition roots may import adapters to wire
  dependencies; other features must not reach into another module's internals.
- Keep domain rules pure. Application code depends on narrow, use-case-owned ports.
  Express, SQLite, filesystem/process access and provider transports belong in adapters.
- Apply SOLID where a responsibility or substitution boundary is real. Prefer
  composition and functions; avoid generic repositories, base managers, service
  locators, DI containers and interfaces that merely duplicate every class method.
- Preserve transactional and lifecycle ownership when splitting code. Moving a
  transaction across module boundaries requires rollback/recovery tests.
- Reuse existing provider strategies, injected executors and Git abstractions.
  Verify capability and failure contracts before adding a provider-specific branch.
- Add a module dependency rule with the extraction; see [architecture tests](server/modules/architecture.test.ts).
  For module additions, update the public API, module README and source map.

## Behavior that must remain intact

- Each project owns its connection, queue and runtime state. No global mutable
  cache may leak project data. Bind dependencies at composition time.
- Desktop `/api` routes mount before `/api/projects` routes. Preserve overlapping
  route precedence, response shapes and WebSocket event contracts.
- Frontend API calls use `getApiBase()`. Project switching must retain cached data
  while refreshing; include `activeProjectId` in effects and filter WS messages
  using the current project ref, not a stale closure.
- Keep spawn reservation, cancellation, terminal settlement, ticket ownership,
  outbox effects and restart replay idempotent. Test failure paths as well as success.
- Preserve provider-reported usage and missing-value semantics. Keep estimates
  distinguishable from billed cost; share [integer allocation](server/util/distribute-int.ts).
- Append database migrations; never renumber or rewrite shipped migrations.
  Preserve WAL settings, secure file permissions and transaction scope.
- App settings are a modal; project settings are a route. Follow existing i18n
  and theme conventions when changing visible UI.

## Verification

Root and `client/` have separate dependency trees. Use `npm ci` in each when needed.
Inspect [root scripts](package.json), [client scripts](client/package.json) and
[CONTRIBUTING.md](CONTRIBUTING.md) for setup; prefer repository commands.

| Change | Checks |
| --- | --- |
| TypeScript source | `npm run typecheck` (includes unused locals/imports) |
| Module/core rules | `npx vitest run server/modules` and affected integration suites |
| Server feature | `npx vitest run server/<feature>.test.ts` plus lifecycle/store tests it affects |
| React feature | `npm run test --prefix client -- <test-path>` |
| Scripts, bundling | `npm run test:scripts`, `npm run build`, `npm run check:package` |
| Provider/Core integration | `npm run check-core-compat` plus provider/runtime contract tests |
| Broad refactor | Root and client `test:coverage`, typecheck, build and package checks |
| Source removal | `npm run audit:source`; inspect tests, demo, scripts, dynamic loading and external contracts before deletion |
| File moves/additions | `npm run docs:source-map`; check imports and references |

Coverage thresholds are enforced in [root](vitest.config.ts) and
[client](client/vitest.config.ts) configuration. Never lower them to pass a change.
Keep tests for live behavior; remove tests only when their exclusive production
implementation is proven unused. Rust/native changes also need relevant Cargo
and platform smoke checks from [CI](.github/workflows/ci.yml).

## Finish the change

Update the narrowest relevant guide and module README, not this file with a
feature diary. Report what changed, validation, and unresolved limitations.
Separate unrelated/generated changes from source edits. Preserve user work.
For an existing OpenSpec change, follow its artifacts and the
[OpenSpec workflow](docs/internals/openspec-workflow.md).
