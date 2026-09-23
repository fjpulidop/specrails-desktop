# Architecture decision: capability modules with selective ports and adapters

Status: capability ownership is implemented across the application, including
server features, React features and CLI responsibilities. Hexagonal boundaries
are applied to cores that benefit from substitutable effects. Runtime coordinators
are explicitly effectful; this is not a claim that every class is infrastructure-free.

## Decision and scope

Keep a modular monolith and the existing deployment units. A change should have an
identifiable owner, focused public entry points and adjacent behavioral tests.
Use functions and composition; a generic repository, base-manager hierarchy,
service locator or DI container would add machinery without solving the observed
coupling. Folder moves alone do not constitute dependency inversion.

| Area | Implemented ownership and boundary | Why this shape |
| --- | --- | --- |
| Server capabilities | [14 modules](../../server/modules/README.md), [195 production files and public subpaths](../../server/modules/boundaries.json) | Related stores, runtime coordination and tests are discoverable together; dependencies are reviewed explicitly |
| React capabilities | [21 features](../../client/src/features/README.md), [public subpaths and dependencies](../../client/src/features/boundaries.json) | UI, hooks, state, feature clients and tests belong to the same feature; focused subpath imports avoid eagerly loading every view |
| Project settings | [Domain, application, repository port, HTTP/SQLite adapters](../../server/modules/project-settings/README.md) | Validation is independent of transport; updates validate first and commit atomically |
| Execution | [Scheduling, accounting, recovery and budget enforcement](../../server/modules/execution/README.md) | Policies run without a database/process manager; recovery reads ordered evidence through a lazy adapter and preserves native-vs-estimated usage |
| Delivery | [Decision policy and workflows](../../server/modules/delivery/README.md) | Lifecycle vocabulary is independent of storage; publication, recovery, discard and local merge have separate workflows with an acyclic dependency guard |
| Conversations | [Recovery context and stream policies](../../server/modules/conversations/README.md) | Byte limits, exact missing-session detection and chunk filtering are testable independently of provider processes |
| Persistence | [Connection, migrations and domain repositories](../../server/db/) behind [the public facade](../../server/db.ts) | Preserve schema history, query behavior and transaction ownership while separating unrelated concerns |
| CLI | [Parsing, formatting, output, HTTP transport, execution and lifecycle modules](../../cli/README.md) | The executable only dispatches; parsing/formatting have no infrastructure imports and commands cannot depend on the executable |

## Boundaries deliberately retained

These areas were assessed and keep their existing responsibility boundaries;
moving them again would obscure package/resource contracts or duplicate adapters.

| Area | Retained entry points | Rationale |
| --- | --- | --- |
| Server composition | [startup](../../server/index.ts), [project registry](../../server/project-registry.ts), [project routes](../../server/project-router.ts), [desktop routes](../../server/desktop-router.ts) | Own project lifetime, route ordering and dependency wiring |
| Provider strategies | [provider contract](../../server/providers/types.ts), [registry](../../server/providers/registry.ts), [runtime](../../server/providers/runtime.ts) | Existing substitutable provider strategies already model different capabilities and stream semantics |
| Integrations | [Jira](../../server/jira/), [plugins](../../server/plugins/), [mobile](../../server/mobile/), [MCP](../../server/mcp/) | Existing cohesive subsystems; preserve their public contracts rather than create parallel frameworks |
| Resource/platform adapters | [Core compatibility](../../server/core-compat.ts), [command resolver](../../server/command-resolver.ts), [shell resources](../../server/terminal-shell-integration.ts), [MCP configuration](../../server/agent-mcp-config.ts) | Resource lookup depends on source/npm/sidecar locations; retain stable package anchors |
| Local engine | [runner](../../local-runner/src/runner.ts), [HTTP client](../../local-runner/src/openai-client.ts), [tools](../../local-runner/src/tools.ts), [sessions](../../local-runner/src/sessions.ts) | The existing executable, protocol, transport, tools and session split is useful and contract-tested |
| MCP bridge | [entry](../../mcp-bridge/src/index.ts), [bridge](../../mcp-bridge/src/bridge.ts), [HTTP transport](../../mcp-bridge/src/http-transport.ts) | Already separates process wiring, protocol handling and transport |
| Native shell | [Tauri composition](../../src-tauri/src/lib.rs), [invoke guard](../../src-tauri/src/invoke_guard.rs), [browser ownership](../../src-tauri/src/browser_ownership.rs), [mission windows](../../src-tauri/src/mission_windows.rs) | Platform/window integration belongs at the native boundary, not behind JavaScript repository interfaces |
| Shared frontend infrastructure | [App](../../client/src/App.tsx), [API context](../../client/src/lib/api.ts), [project cache](../../client/src/hooks/useProjectCache.ts), [UI primitives](../../client/src/components/ui/) | Application composition and reusable infrastructure remain shared; feature-specific code lives with its owner |

## SOLID and patterns in the implemented design

- **Single responsibility:** persistence repositories, CLI handlers, delivery
  workflows and feature-owned source replace unrelated responsibilities in one
  entry file. Runtime coordinators retain lifecycle/state ownership.
- **Open/closed:** add real variation through existing provider strategies,
  executor callbacks and use-case ports. Do not add an interface for every function.
- **Liskov substitution:** fake and production ports must preserve atomic writes,
  error propagation, unknown usage values, ordering and provider capability limits.
- **Interface segregation:** settings exposes read/update; accounting exposes
  write/identity; recovery exposes ordered evidence and provider interpretation;
  budgets expose snapshots and exceeded effects. No complete project registry is
  passed into these application cores.
- **Dependency inversion:** domain/application files have fixed import allowlists.
  SQLite and provider interpretation implement the recovery boundary; settings
  HTTP/SQLite adapters are wired at composition.

Retain strategies/adapters, explicit application use cases, compatibility facades,
composition roots and durable outboxes. Preserve existing compare-and-set leases
and transactions: replacing them with ephemeral pub/sub would break crash recovery.
A state machine is useful for action legality; it does not require replacing the
existing persisted lifecycle vocabulary with a competing model.

## Enforcement and review

[Server architecture tests](../../server/modules/architecture.test.ts) verify the
reviewed [manifest](../../server/modules/boundaries.json), every core's fixed
allowlist and the acyclic delivery workflow graph. Regenerating the runtime
manifest cannot authorize an infrastructure dependency inside a protected core.
[CLI architecture tests](../../cli/architecture.test.ts) protect pure parsing/
formatting, entry-point direction and acyclic command dependencies.

[Frontend boundary checks](../../scripts/audit-client-features.mjs) record public
subpaths and direct capability dependencies and reject imports back into
application composition. Existing cross-feature collaborations are explicit;
this inventory does not claim that every feature is independent or acyclic.

Use `npm run audit:architecture` after a boundary change. Regenerate manifests only
after reviewing the new dependency and update the owning README. Typecheck enforces
unused imports/locals; [source audit](../../scripts/audit-source.mjs) inventories
reachability across application, demo, CLI, local-runner and MCP entry points.

## Preserved behavior and limits

- Source moves update imports, dynamic imports, test mocks, source-reading fixtures,
  coverage paths, packaging probes and navigation links together.
- Keep queue reservation synchronous; keep cancellation, durable promotion,
  terminal settlement, replay and PR ownership idempotent.
- No historical database migrations are rewritten. Settings updates are atomic;
  accounting/recovery continue inside their original transaction owner.
- Frontend project switching, streaming state, route shapes and UI behavior remain
  unchanged. Coverage exclusions move to equivalent files; thresholds are unchanged.
- Large stateful coordinators still exist inside `runtime/`. Their location is
  explicit and their policies have narrower seams; no claim is made that every
  controller is a pure application service or that all architectural debt is gone.
- No blanket runtime-performance gain is claimed. The concrete query improvement
  reads the six project settings in one query. Source ownership is intended to
  reduce change scope and navigation cost, not to manufacture a benchmark result.

## Human and AI navigation

[AGENTS.md](../../AGENTS.md) supplies concise working rules and a feature map;
[CLAUDE.md](../../CLAUDE.md) imports it. Feature READMEs expose public contracts,
collaborators and test commands. The [generated source map](source-map.md) links
source and adjacent tests; historical detail stays in optional reference documents.
