## Why

specrails-hub ships with "Codex (OpenAI) coming soon — currently being tested in our lab" gates on five surfaces (hub-router, AddProjectDialog, useHub, specrails-core init / install-config / provider-detect). Internally, ~60 % of the codex code path already exists — provider field in DB, codex branch in ChatManager / QueueManager / project-router generate-spec, codex models in spec-models, ChatManager session_id synthesis, scaffold.ts `.codex/` placement — but the path is broken: streams are read as plain text instead of `codex exec --json`, `codex exec resume <UUID>` is not used (synthetic session IDs lose context), tokens and cost are NULL or 0 because `turn.completed.usage` is never parsed, AgentRefineManager / ProfileManager / PluginManager are Claude-only, and the rails `sr-architect / sr-developer / sr-reviewer` exist only as Claude agents with `model: sonnet` frontmatter. The user has asked us to ship full codex compatibility as a qualitative leap. We will do it by introducing a provider-adapter architecture that scales to additional providers in the future (one file + one registry entry per provider), not by sprinkling more `if (provider === 'codex')` branches across the codebase.

## What Changes

- **NEW** `ProviderAdapter` interface + `providerRegistry` (one module): every spawn-time decision (binary, arg shape, stream parser, resume mechanism, system-prompt placement, MCP integration mode, agent-fragment file conventions) is encapsulated per provider; managers depend on the interface, not on the enum.
- **NEW** local pricing table (`server/modules/accounting/runtime/pricing.ts`) keyed by provider+model with `inputPer1M / outputPer1M / cacheReadPer1M` and a `lastReviewedAt` stamp. Used by `result-event.normaliseResultEvent` to populate `total_cost_usd` for codex (and any future provider that does not emit it natively).
- **NEW** synthetic OTEL bridge for codex (`server/modules/accounting/runtime/codex-otel-bridge.ts`): consumes the JSONL emitted by `codex exec --json` and writes spans / metrics / logs to the same in-process OTLP receiver QueueManager already feeds, so `telemetry_blobs` rows, `telemetry.ndjson`, and the diagnostic export ZIP work identically across providers.
- **NEW** capability `multi-provider-architecture` documenting the contract, capability flags (`supportsResume`, `supportsMcpJson`, `supportsProfileEnv`, `supportsOtelEnv`, `instructionsFilename`, `projectDirName`, `pluginMcpRegistration`), and provider-discovery rules.
- **MODIFIED** ChatManager / QueueManager / SetupManager / AgentRefineManager: delegate `buildArgs`, `parseStreamLine`, `extractSessionId`, `extractResult` to the adapter. Codex multi-turn now uses `codex exec resume <UUID>`; codex jobs persist real `tokens_in / tokens_out / cache_read` from `turn.completed.usage`; cost is calculated post-stream via the pricing table.
- **MODIFIED** ProfileManager: `ProfileAgent.model` accepts any string accepted by the resolved provider's adapter (validated against `adapter.modelCatalog()`); `Profile.provider?: string` (optional, default `'claude'`) chooses which adapter validates; baseline agents are resolved from `adapter.baselineAgents()` rather than a Claude-specific hardcoded list.
- **MODIFIED** PluginManager: per-plugin manifest gains `install(ctx, adapter)` and `uninstall(ctx, adapter)`. Codex plugins are registered via `codex mcp add` with a per-project `CODEX_HOME=<~/.specrails/projects/<slug>/codex-home/>`; Claude plugins continue to merge `.mcp.json`. Shared-file contributors target `adapter.instructionsFilename` (`CLAUDE.md` or `AGENTS.md`), not a hardcoded path.
- **MODIFIED** explore-cwd-manager: provider-aware. Generates the lightweight isolated cwd with `adapter.instructionsFilename` and the right sentinel content; codex gets `AGENTS.md`.
- **MODIFIED** specrails-core (separate package, version bump to 4.6.0):
  - Lift the three "coming soon" gates (`provider-detect.ts`, `install-config.ts`, `init.ts`).
  - Extend `scaffold.ts` to deploy `.codex/skills/sr-*` for codex projects (today only happens for Claude — line 171 `if provider === 'claude'`).
  - **NEW** codex-flavoured rail skills: `templates/skills/rails/sr-architect / sr-developer / sr-reviewer / sr-merge-resolver` (SKILL.md format, ported from the Claude `templates/agents/sr-*.md` frontmatter-bearing files).
  - Apply `templates/settings/codex-config.toml` → `.codex/config.toml` (model placeholder substituted) and `templates/settings/codex-rules.star` → `.codex/rules.star` (with `{{CODEX_SHELL_RULES}}` resolved).
  - Generate `AGENTS.md` initial content for codex projects with `<!-- specrails-managed -->` sentinel.
- **MODIFIED** Hub: lift the gates after the above is shipped — `hub-router GET /available-providers` reports the real codex availability, `POST /projects` accepts `provider: 'codex'`, `setup-prerequisites` reports codex, AddProjectDialog stops force-falsifying codex, `useHub.addProject` signature accepts `'codex'`.
- **MODIFIED** AnalyticsPage: per-row "Estimated cost" badge for codex invocations (the pricing table is best-effort, not authoritative from a billing API), and `byMode` / hero burn meter include codex without misrepresenting it as free.
- **MODIFIED** AgentsPage Profiles + Catalog tabs: for codex projects, the catalog reads `.codex/skills/` instead of `.claude/agents/`. Profiles edition surface uses `adapter.modelCatalog()` for the model dropdown.

**Non-goals (deferred to future changes):**
- Multi-fase pipeline orchestration for codex (architect → developer → reviewer as separate jobs with `dependsOnJobId`). Phase 1 ships the inline-orchestration approach (one codex skill = one job) for parity. Multi-job orchestration is a follow-up.
- Provider switching after project creation. Stays immutable, as today's UI already documents.
- OpenAI Usage API integration for authoritative cost. Local pricing table is "estimated" and disclaimed.

## Capabilities

### New Capabilities
- `multi-provider-architecture`: the ProviderAdapter contract, registry, capability flags, and the rules every manager follows when interacting with a provider. The home of the design that prevents `if (provider === ...)` from leaking across the codebase as new providers are added.

### Modified Capabilities
- `agent-profiles`: profile schema accepts models from any registered provider; baseline agents resolved via adapter, not hardcoded; profile resolution considers project provider.
- `plugin-system`: install / uninstall delegate per-provider via adapter; shared-file contributors target `instructionsFilename` not `CLAUDE.md`; manifest gains optional provider-specific install callback.
- `pipeline-telemetry`: codex spawns emit synthetic OTEL via the JSONL bridge; existing requirements (per-project toggle, OTLP receiver, retention, export ZIP) unchanged.
- `project-spending`: cost calculation falls back to the local pricing table when the provider does not emit `total_cost_usd` natively; analytics rows surface an `estimated` flag.
- `explore-spec`: codex multi-turn uses `codex exec resume <thread_id>`; explore-cwd contains `AGENTS.md` (not `CLAUDE.md`) for codex projects; idle-kill / concurrency cap / queue / crash respawn behaviours unchanged.

> `add-spec-model-selection` already mandates a provider-aware model list with codex models (its existing requirements cover both providers); this change lifts the upstream gates but does not alter that capability's normative requirements. `setup-wizard-install-cta` is a CSS-only capability with no codex implications.

## Impact

**Files touched in `specrails-hub`** (approximate, from the investigation matrix):

- New: `server/providers/{provider-adapter.ts, claude-adapter.ts, codex-adapter.ts, registry.ts}`, `server/modules/accounting/runtime/pricing.ts`, `server/modules/accounting/runtime/codex-otel-bridge.ts`
- Modified server: `chat-manager.ts`, `queue-manager.ts`, `agent-refine-manager.ts`, `setup-manager.ts`, `profile-manager.ts`, `plugin-manager.ts`, `plugins/{ownership.ts, contributors.ts}`, `plugins/serena/{manifest.ts, install.ts}`, `explore-cwd-manager.ts`, `result-event.ts`, `core-compat.ts`, `setup-prerequisites.ts`, `hub-router.ts`, `project-router.ts`, `util/cli-prompt.ts`, `schemas/profile.v1.json`
- Modified client: `hooks/useHub.tsx`, `components/AddProjectDialog.tsx`, `components/SetupWizard.tsx`, `pages/AgentsPage.tsx`, `pages/AnalyticsPage.tsx`, `pages/SettingsPage.tsx`, `components/analytics/*`, `lib/models.ts` (or wherever spec-models lives client-side)
- Migrations: per-project SQLite — none required for v1 (ai_invocations already provider-agnostic). Hub SQLite — none required.
- Tests: cover the adapter contract; provider-specific tests under `server/providers/*.test.ts`; existing `chat-manager.codex / queue-manager.codex / project-router.codex / result-event.test` extended; new e2e harness `tests/e2e/codex-pipeline.test.ts` gated behind `SPECRAILS_HUB_E2E_CODEX=1` (needs real codex binary).

**Files touched in `specrails-core`** (separate PR, version bump to 4.6.0):

- `src/installer/phases/{provider-detect.ts, install-config.ts, scaffold.ts}`, `src/installer/commands/{init.ts, init.test.ts}`, `src/installer/phases/*.test.ts`
- New skills: `templates/skills/rails/sr-architect/SKILL.md`, `sr-developer/SKILL.md`, `sr-reviewer/SKILL.md`, `sr-merge-resolver/SKILL.md`
- Updated: `templates/settings/codex-config.toml` (model `gpt-5.4-mini`, drop `codex-mini-latest`), `integration-contract.json` (bump coreVersion), `package.json`, `CHANGELOG.md`

**API & WS contracts:**

- `GET /api/hub/available-providers` response shape unchanged; values become truthful.
- `POST /api/hub/projects` accepts `provider: 'codex'`.
- `GET /api/hub/setup-prerequisites` includes a `codex` entry (severity `optional` — not required for hub to start).
- `POST /api/projects/:id/profiles` schema validation accepts codex models.
- No WebSocket message shape changes. New event types are not introduced; existing `plugin.installed / plugin.uninstalled / spending.invalidated / cost_alert` reach codex projects identically.

**Risk surface:** cost-table accuracy (mitigated with the `estimated` UI badge and a `lastReviewedAt` field reviewed quarterly); codex stream-shape drift across CLI versions (mitigated with tolerant parser, version-pinned fixtures, and a `minVersion` requirement in setup-prerequisites); concurrent `codex mcp add` across plugins (mitigated with per-process file lock identical to the existing `.mcp.json` write path).

**Rollback plan:** the gates are re-enable-able by reverting `hub-router.ts` lines 147 and 181–188 plus the matching client-side gates — no DB migration to undo. The internal adapter refactor is behaviour-preserving so reverting only the gates is safe at any time.
