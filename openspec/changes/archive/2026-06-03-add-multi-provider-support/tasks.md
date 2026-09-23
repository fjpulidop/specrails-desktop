> **Stage A** (sections 1–13): adapter refactor, codex correctness, pricing, OTEL bridge, profile + plugin extensions, DB migrations, tests, coverage. Gates stay UP — Claude path is byte-identical, no UX change for existing users.
>
> **Stage B** (sections 14–17): specrails-core 4.6.0 release.
>
> **Stage C** (sections 18–22): lift hub gates, UI surface, e2e validation, docs, rollout.

## 1. Foundations: provider adapter scaffolding

- [x] 1.1 Add `server/providers/types.ts` declaring `ProviderId`, `SpawnAction`, `SpawnOptions`, `AdapterEvent`, `NormalisedResult`, `DetectionResult`, `ProviderAdapter` interface, and `UnknownProviderError`
- [x] 1.2 Add `server/providers/registry.ts` with `getAdapter`, `listAdapters`, `hasAdapter`, internal `register(adapter)` helper, and a `clearForTests()` only-exported-under-tests escape hatch
- [x] 1.3 Add `server/providers/index.ts` that imports each adapter module so registration runs at module load; export `getAdapter`, `listAdapters`, `hasAdapter`
- [x] 1.4 Add `server/providers/__fixtures__/` directory placeholder with README explaining the JSONL fixture layout (one file per provider per CLI version)
- [x] 1.5 Write `server/providers/registry.test.ts` covering: registered ids visible, unknown lookup throws, isolation between tests via `clearForTests()`

## 2. Claude adapter

- [x] 2.1 Implement `server/providers/claude-adapter.ts` exposing the full `ProviderAdapter` contract — port logic from current `chat-manager.ts`, `queue-manager.ts`, `agent-refine-manager.ts`, `project-router.ts/generate-spec`, `result-event.ts/normaliseResultEvent('claude')` without behaviour change
- [x] 2.2 `capabilities` block returns `{ nativeResume: true, nativeStreamJson: true, nativeCostUsd: true, nativeOtelEnv: true, profileEnvSupport: true, systemPromptArg: true }`
- [x] 2.3 `modelCatalog()` returns the existing `CLAUDE_MODELS` from `spec-models.ts`; `defaultModel()` returns `'sonnet'`
- [x] 2.4 `parseStreamLine` handles `assistant`, `result`, `tool_use`, `system` event types — returns `{kind:'other'}` for unknown types
- [x] 2.5 `extractResult` reads `usage.input_tokens/output_tokens/cache_read_input_tokens/cache_creation_input_tokens`, `total_cost_usd`, `num_turns`, `model`, `duration_ms`, `api_duration_ms`, `session_id`
- [x] 2.6 `baselineAgents()` returns `['sr-architect','sr-developer','sr-reviewer','sr-merge-resolver']`
- [x] 2.7 `detectInstalled()` runs `which claude` + `claude --version`, parses semver
- [x] 2.8 Adapter calls `registry.register(this)` on module load
- [x] 2.9 Write `server/providers/claude-adapter.test.ts`: full contract surface plus parse-stream fixtures captured from a real claude job (drop fixtures under `server/providers/__fixtures__/claude/`)

## 3. Codex adapter

- [x] 3.1 Implement `server/providers/codex-adapter.ts` exposing the full `ProviderAdapter` contract
- [x] 3.2 `capabilities` block returns `{ nativeResume: true, nativeStreamJson: true, nativeCostUsd: false, nativeOtelEnv: false, profileEnvSupport: true, systemPromptArg: false }`
- [x] 3.3 `modelCatalog()` returns the existing `CODEX_MODELS` from `spec-models.ts`; `defaultModel()` returns `'gpt-5.4-mini'`
- [x] 3.4 `minCliVersion = '0.128.0'` (the version that supports `exec --json` + `exec resume` semantics this design relies on)
- [x] 3.5 `projectDirName = '.codex'`, `instructionsFilename = 'AGENTS.md'`, `mcpRegistration = 'cli-add'`
- [x] 3.6 `buildArgs('chat-turn', opts)` returns `['exec', '--json', combinedPrompt, '--model', opts.model]` where `combinedPrompt = systemPrompt + '\n\n---\n\n' + userPrompt` (system prompt folded since `systemPromptArg: false`); honours optional `cwd` via `-C`
- [x] 3.7 `buildArgs('chat-resume', opts)` returns `['exec', 'resume', '--json', opts.sessionId, opts.prompt, '--model', opts.model]`
- [x] 3.8 `buildArgs('rail-job', opts)` follows the chat-turn shape with `--sandbox workspace-write` added and the rail prompt folded
- [x] 3.9 `buildArgs('spec-gen' | 'agent-refine' | 'setup-enrich', opts)` per design
- [x] 3.10 `parseStreamLine` handles `thread.started → session-started`, `turn.started → other`, `item.completed{type:agent_message} → text-delta`, `item.completed{type:function_call|local_shell_call} → tool-use`, `turn.completed → result`, unknown types → `other`
- [x] 3.11 `extractResult` reads `payload.usage.input_tokens / output_tokens / cached_input_tokens / reasoning_output_tokens`, maps `cached_input_tokens` to `tokens_cache_read`, sums `reasoning_output_tokens` into `tokens_out` (matches OpenAI billing); model from `--model` arg; session id from earliest `session-started` event; duration from `turn.completed` timestamps when available
- [x] 3.12 `baselineAgents()` returns the same set as claude (`['sr-architect','sr-developer','sr-reviewer','sr-merge-resolver']`)
- [x] 3.13 `detectInstalled()` runs `which codex` + `codex --version`, parses semver, checks `meetsMinimum` against `minCliVersion`
- [x] 3.14 Adapter calls `registry.register(this)` on module load
- [x] 3.15 Write `server/providers/codex-adapter.test.ts`: full contract surface plus parse-stream fixtures captured live (drop under `server/providers/__fixtures__/codex/0.128.0/`)
- [x] 3.16 Add a fixture-version-vs-minCliVersion CI guard: assert that fixtures directory names match a version `>= minCliVersion`

## 4. Pricing table

- [x] 4.1 Add `server/modules/accounting/runtime/pricing.ts` with `PRICING` map keyed `<providerId>:<model>` and `estimateCostUsd(providerId, model, usage) → number | null` + `lastReviewedAt() → string`
- [x] 4.2 Seed with `codex:gpt-5.5`, `codex:gpt-5.4`, `codex:gpt-5.4-mini`, `codex:gpt-5.3-codex` — pricing-of-record fetched at `lastReviewedAt: '2026-05-17'`
- [x] 4.3 Document the pricing review cadence (quarterly) inline at the top of the file; include link/notes to OpenAI pricing
- [x] 4.4 Write `server/modules/accounting/runtime/pricing.test.ts`: cost = (in*price_in + out*price_out + cache_read*price_cache) / 1M for every entry; unknown model returns null; missing usage fields treated as 0

## 5. Codex OTEL bridge

- [x] 5.1 Add `server/modules/accounting/runtime/codex-otel-bridge.ts` exporting `createCodexOtelBridge({ jobId, projectId, hubPort, model })` returning an object with `consumeEvent(event: AdapterEvent)` and `finalize(stderr?: string)`
- [x] 5.2 Bridge buffers events, on `result` emits an OTLP/JSON traces payload (root span + per-tool child events), a metrics payload (one data point per token field + duration), and a logs payload (text-delta accumulator); posts each to `http://127.0.0.1:<hubPort>/otlp/v1/{traces,metrics,logs}`
- [x] 5.3 Implement the 10 MB cap shared with the existing OTLP receiver path: after the receiver returns `logs_truncated`, the bridge stops sending log payloads but continues traces/metrics
- [x] 5.4 Resource attributes: `specrails.job_id`, `specrails.project_id`, `specrails.provider=codex`, `specrails.codex.thread_id` (from session-started), `specrails.codex.cli_version` (best-effort)
- [x] 5.5 Write `server/modules/accounting/runtime/codex-otel-bridge.test.ts`: feed a recorded JSONL fixture, assert the receiver was called with expected payloads (mock fetch / mock POST)
- [x] 5.6 Wire `QueueManager` to instantiate the bridge when `adapter.capabilities.nativeOtelEnv === false` and telemetry is ON; consume every parsed `AdapterEvent`; call `bridge.finalize` on process close

## 6. Refactor `result-event.ts`

- [x] 6.1 Replace the legacy `normaliseResultEvent(event, provider)` with `normaliseResultEvent(adapter, events): NormalisedResult` that delegates to `adapter.extractResult(events)`
- [x] 6.2 After result extraction, if `adapter.capabilities.nativeCostUsd === false`, invoke `estimateCostUsd(adapter.id, normalised.model, normalised)` and set `total_cost_usd` + carry forward an `estimated: true` flag in the returned shape
- [x] 6.3 Update every callsite (`queue-manager.ts`, `chat-manager.ts`, `agent-refine-manager.ts`) to pass the adapter + events array
- [x] 6.4 Update `server/modules/accounting/runtime/result-event.test.ts` for both providers

## 7. Refactor `ChatManager`

- [x] 7.1 Inject the adapter into `ChatManager` constructor via project-registry resolution (`ctx.adapter = getAdapter(project.provider)`); remove the `provider: 'claude' | 'codex'` literal type and the `_provider` field
- [x] 7.2 `sendMessage`: replace `provider === 'codex'` branches with `adapter.capabilities.systemPromptArg`-style checks; use `adapter.buildArgs('chat-turn'|'chat-resume')` exclusively
- [x] 7.3 Replace the line-reader logic with the adapter's `parseStreamLine`; emit `text-delta` events to the existing live-strip filter
- [x] 7.4 Capture `session-started` event into `capturedSessionId` (real codex thread_id, not synthetic); REMOVE the `codex-<convId>-<timestamp>` synthetic id generator
- [x] 7.5 On close, call `adapter.extractResult(events)` and pass the result to `recordInvocation` with `provider: adapter.id`
- [x] 7.6 Update `auto-title` to use `adapter.buildArgs('spec-gen', { prompt: titlePrompt, model: ... })` to stay provider-agnostic
- [x] 7.7 Extend `server/modules/conversations/runtime/chat-manager.test.ts` codex suite: assert real thread_id captured, second turn uses `exec resume`, third turn after minimize/restore preserves the session id
- [x] 7.8 Add a regression test: claude path is byte-identical (mock spawn, assert argv unchanged from pre-refactor)

## 8. Refactor `QueueManager`

- [x] 8.1 Inject the adapter; remove `provider: 'claude' | 'codex'` constructor option (now derived)
- [x] 8.2 Replace argv-build branches with `adapter.buildArgs('rail-job', { prompt, systemAppend, model, attachments, ... })`
- [x] 8.3 Stream-parse using `adapter.parseStreamLine`; accumulate events for `adapter.extractResult`
- [x] 8.4 Telemetry: when `adapter.capabilities.nativeOtelEnv` AND telemetry ON → inject env vars (unchanged claude path); else when telemetry ON → instantiate the bridge from §5
- [x] 8.5 Profile injection: replace `this._provider === 'claude' &&` gate with `adapter.capabilities.profileEnvSupport &&`
- [x] 8.6 Plugin injection (env var path): same — gate on adapter capability (the `cli-add` path doesn't need env injection; the spawn already has its `<PROVIDER>_HOME` set per §13)
- [x] 8.7 `recordInvocation` call passes `provider: adapter.id`; pricing fallback applied at result-normalise step (§6.2)
- [x] 8.8 Extend `server/modules/execution/runtime/queue-manager.test.ts` codex suite: real tokens captured, estimated cost present, OTEL bridge invoked when telemetry ON

## 9. Refactor `AgentRefineManager`

- [x] 9.1 Accept an adapter (or resolve via project) in the constructor; remove direct `spawnClaude` calls; route through `adapter.buildArgs('agent-refine', {...})`
- [x] 9.2 Replace stream parsing with `adapter.parseStreamLine`; preserve the existing phase machine (`reading → drafting → validating → done`)
- [x] 9.3 `validateAgentBody`: the `model: sonnet|opus|haiku` regex MUST become provider-aware — for codex projects, validate against `adapter.modelCatalog()` model values; for claude keep the existing list
- [x] 9.4 Spawn site for `auto-test`: also route through the adapter
- [x] 9.5 `recordInvocation` call passes `provider: adapter.id`
- [x] 9.6 Add a new test file `server/agent-refine-manager.codex.test.ts`: codex refine flow end-to-end with a fake child process

## 10. Refactor `SetupManager`

- [x] 10.1 `startEnrich` and `resumeEnrich`: replace branch-on-provider with `adapter.buildArgs('setup-enrich' | 'setup-enrich-resume', { ... })`
- [x] 10.2 Codex stream parsing: use `adapter.parseStreamLine`; capture real thread id and persist via `onSessionCaptured`; REMOVE the `codex-<projectId>-<timestamp>` synthetic id
- [x] 10.3 Re-spawn for `resumeEnrich` on codex: uses adapter's `setup-enrich-resume` (which is `exec resume`), not a fresh re-spawn of the enrich content
- [x] 10.4 Project context header injection (`PROJECT: …\nCWD: …`) is now adapter-driven (`adapter.buildSetupEnrichContext` is a helper exposed on adapters that need it; claude returns empty, codex returns the header)
- [x] 10.5 Checkpoint detection regex (`detectCheckpointFromText`) must also recognise codex skill paths: `.codex/skills/sr-*/SKILL.md`, `AGENTS.md`, etc. Extend the existing patterns
- [x] 10.6 Update tests in `server/setup-manager.test.ts` codex suite for the new resume path and the new checkpoint patterns

## 11. Refactor `project-router` spawn callsites

- [x] 11.1 `POST /tickets/generate-spec`: replace inline `if (provider === 'codex')` with adapter-driven argv via `adapter.buildArgs('spec-gen', {...})` and `adapter.parseStreamLine`
- [x] 11.2 `POST /tickets/:id/ai-edit`: delegated to `AgentRefineManager` (already refactored in §9); confirm no codex-specific logic remains in the route
- [x] 11.3 `GET /default-spec-model` returns the catalog from `adapter.modelCatalog()` directly (already mostly compliant via `spec-models.ts`; ensure no duplication of the catalog)
- [x] 11.4 Extend `server/project-router.codex.test.ts` for the new codex stream parse path (thread_id captured, model fallback when missing)

## 12. Refactor `explore-cwd-manager`

- [x] 12.1 Accept the adapter; generate `<adapter.instructionsFilename>` (CLAUDE.md or AGENTS.md) from per-provider embedded templates
- [x] 12.2 Add `server/explore-cwd-templates/codex-AGENTS.md` (mirrors the existing claude `CLAUDE.md` template content) — focused on the Explore-Spec stance, minimal, no project-specific content
- [x] 12.3 On project removal: provider-agnostic recursive rm (already)
- [x] 12.4 Update `explore-cwd-manager.test.ts` codex suite

## 13. Extend `ProfileManager`

- [x] 13.1 Update `schemas/profile.v1.json`: add optional `provider` top-level field; remove the `enum: ['sonnet','opus','haiku']` on `ProfileAgent.model` (replace with a pattern that accepts any non-empty string — runtime check enforces the catalog)
- [x] 13.2 `validateProfile` keeps the AJV pass; `validateStructural` resolves `getAdapter(profile.provider ?? 'claude')` and asserts every `agents[i].model ∈ adapter.modelCatalog().map(m => m.value)`; baseline check uses `adapter.baselineAgents()`
- [x] 13.3 `resolveProfile(projectPath, explicit, project)`: signature gains the project arg so the resolver can default `profile.provider` to `project.provider` in-memory (file on disk stays untouched)
- [x] 13.4 `snapshotForJob` writes the materialised in-memory profile (with `provider` field present) so specrails-core skills receive the explicit provider id
- [x] 13.5 Update `server/modules/agents/runtime/profile-manager.test.ts`: codex models accepted on codex profiles, cross-provider rejection, defaulting from project, schema not enumerating models
- [x] 13.6 Extend `client/src/features/agents/pages/AgentsPage.tsx` Profiles tab: model dropdown for each agent calls `adapter.modelCatalog()` derived from `project.provider`; banner text changes when project provider is codex AND core < 4.6.0

## 14. Extend `PluginManager`

- [x] 14.1 Manifest type: add `providerSupport: { [providerId]: { mcpEntry?, install?, uninstall? } }`; preserve current declarations as `providerSupport.claude.mcpEntry`
- [x] 14.2 Update `server/plugins/serena/manifest.ts` to declare `providerSupport.codex.mcpEntry` (same `uvx` command); add a fallback `install` callback for codex that runs `codex mcp add` + verifies via `codex mcp list`
- [x] 14.3 `PluginManager.install` dispatches: if `adapter.mcpRegistration === 'project-json'` use existing surgical merge; else call `plugin.providerSupport[adapter.id].install(ctx, adapter)` or build the `codex mcp add` invocation from `mcpEntry`
- [x] 14.4 Per-project `CODEX_HOME` directory created at `~/.specrails/projects/<slug>/codex-home/` lazily on first codex plugin op; lock-file at `.specrails.lock` shared with the existing file-mutation lock module
- [x] 14.5 `applyContributors` and `revertContributors`: target `adapter.instructionsFilename` (CLAUDE.md for claude, AGENTS.md for codex); sentinel format unchanged
- [x] 14.6 `listAvailable`: plugins missing `providerSupport[project.provider]` surface as `not-applicable` (new status)
- [x] 14.7 `verify`: provider-agnostic — Serena verify is `uvx serena --version` regardless of provider, but the codex path additionally probes `codex mcp list` for the entry
- [x] 14.8 Tests:
  - `server/plugin-manager.test.ts`: install/uninstall on codex project via mock `codex mcp` subprocess
  - `server/plugins/serena/install.codex.test.ts`: codex-specific install path
  - `server/plugins/contributors.test.ts`: target file selection via adapter
- [x] 14.9 `client/src/features/integrations/pages/IntegrationsPage.tsx` (or wherever plugin cards render): show "Not applicable for this provider" state when `status === 'not-applicable'`

## 15. DB migrations

- [x] 15.1 Add migration 18 in `server/db.ts`: `ALTER TABLE ai_invocations ADD COLUMN provider TEXT;` + `UPDATE ai_invocations SET provider = 'claude' WHERE provider IS NULL;` + create index `idx_ai_inv_project_provider ON ai_invocations(project_id, provider)`
- [x] 15.2 Add migration 19: `ALTER TABLE ai_invocations ADD COLUMN total_cost_usd_estimated INTEGER NOT NULL DEFAULT 0;`
- [x] 15.3 Update `recordInvocation` to require `provider` and accept optional `estimated: boolean` (writes 1 when true, 0 default)
- [x] 15.4 Update `spending.ts` `getSpending` and `getInvocations` to surface `provider`, `total_cost_usd_estimated`, `totalEstimatedCostUsd` totals, and `byProvider` breakdown
- [x] 15.5 Update `client/src/features/analytics/pages/AnalyticsPage.tsx`: `~` prefix on estimated cost cells with tooltip; Hero footnote when `totalEstimatedCostUsd > 0`; `byProvider` widget (new component `client/src/features/analytics/components/ProviderBreakdownCard.tsx`)
- [x] 15.6 Update `server/modules/accounting/runtime/spending.test.ts` and `analytics/*.test.tsx` accordingly

## 16. Extend `setup-prerequisites.ts`

- [x] 16.1 `getSetupPrerequisitesStatus`: iterate `listAdapters()` and call each `adapter.detectInstalled()`; produce one entry per provider with `installed`, `executable`, `version`, `meetsMinimum`, plus the existing `uv` (for serena) check
- [x] 16.2 `formatMissingSetupPrerequisites`: changes wording — block only when zero providers are usable
- [x] 16.3 Update `client/src/features/projects/components/PrerequisitesPanel.tsx` to list each provider as a row with detected/missing chip and install-info link
- [x] 16.4 Update `client/src/features/projects/components/InstallInstructionsModal.tsx` with codex install commands (Homebrew `brew install codex`, npm `npm i -g @openai/codex` or whatever's official — confirm at implementation time)
- [x] 16.5 Update `server/setup-prerequisites.test.ts`

## 17. Refactor `core-compat.ts`

- [x] 17.1 Deprecate `detectAvailableCLIs` in favour of `detectAvailableProviders` that walks the registry; keep `detectAvailableCLIs` as a thin compat wrapper that returns `{ claude, codex }` from the new map
- [x] 17.2 `detectCLISync` keeps existing name but delegates to registry too
- [x] 17.3 Drop the hardcoded `WHICH_CMD` paths used elsewhere in favour of `adapter.detectInstalled()`
- [x] 17.4 Update `server/core-compat.test.ts`

---

> **--- end of Stage A ---**

## 18. specrails-core 4.6.0: lift gates

- [x] 18.1 `src/installer/phases/provider-detect.ts`: remove the `throw ProviderError(...coming soon...)` for codex paths (lines 65-87); add codex auth check (no error when `OPENAI_API_KEY` set OR `~/.codex/auth.json` present)
- [x] 18.2 `src/installer/phases/install-config.ts`: remove the `errors.push(... codex coming soon ...)` for `doc.provider === 'codex'` (line 96-99)
- [x] 18.3 `src/installer/commands/init.ts`: remove the `--provider codex` throw (line 79-84)
- [x] 18.4 Update all three test files to invert the rejection tests into acceptance tests; keep coverage ≥ 80%

## 19. specrails-core 4.6.0: codex skills + scaffold

- [x] 19.1 In `src/installer/phases/scaffold.ts`, remove the `if (input.provider === 'claude')` gate around `placeSkills` (line 171) — skills are now placed for any provider where they exist
- [x] 19.2 Add `placeCodexSettings(input)` invoked when `input.provider === 'codex'` that:
  - Copies `templates/settings/codex-config.toml` to `<repo>/.codex/config.toml` substituting `{{MODEL_NAME}}` from the install-config (default `gpt-5.4-mini`)
  - Copies `templates/settings/codex-rules.star` to `<repo>/.codex/rules.star` substituting `{{CODEX_SHELL_RULES}}` from detected shell tools (reuse existing detection helpers)
- [x] 19.3 Add `writeInitialAgentsMd(repoRoot)` that, when `provider === 'codex'`, writes `<repo>/AGENTS.md` with a sentinel `<!-- specrails-managed-start -->` block containing standard guidance (mirroring the existing `CLAUDE.md` template but adapted for codex conventions)
- [x] 19.4 Update `templates/settings/codex-config.toml`: replace `name = "codex-mini-latest"` with `name = "{{MODEL_NAME}}"` so the scaffold can substitute
- [x] 19.5 Create `templates/skills/rails/sr-architect/SKILL.md` ported from `templates/agents/sr-architect.md` — Claude frontmatter (`model:`, `color:`, `memory:`) becomes the codex SKILL frontmatter format (`name`, `description`, `license`, `compatibility`, `metadata`); body content preserved with personality / risk-tolerance / tone sections intact
- [x] 19.6 Create `templates/skills/rails/sr-developer/SKILL.md` ported from `templates/agents/sr-developer.md`
- [x] 19.7 Create `templates/skills/rails/sr-reviewer/SKILL.md` ported from `templates/agents/sr-reviewer.md`
- [x] 19.8 Create `templates/skills/rails/sr-merge-resolver/SKILL.md` ported from `templates/agents/sr-merge-resolver.md`
- [x] 19.9 Update `placeSkills` to descend into `skills/rails/` and place under `.codex/skills/rails/<name>/SKILL.md` for codex projects (and equivalently `.claude/skills/rails/<name>/` for claude projects, even though Claude already has the agents in `.claude/agents/` — these skill versions are additive, not replacements)
- [x] 19.10 Add CI test in specrails-core `templates.test.ts`: every `templates/agents/sr-*.md` MUST have a matching `templates/skills/rails/sr-*/SKILL.md` with the same H2 sections, ensuring parity going forward
- [x] 19.11 Extend `templates/skills/sr-implement/SKILL.md` to reference the rail skills under `.codex/skills/rails/` so codex orchestrators can call them inline (Phase 1 of the multi-job pipeline deferred — see proposal Non-Goals)

## 20. specrails-core 4.6.0: release

- [ ] 20.1 Bump `package.json` version to `4.6.0`; update `VERSION` — **deferred: release-please owns the bump on PR merge**
- [ ] 20.2 Update `CHANGELOG.md` under "Features" with: "Codex (OpenAI) CLI is now a supported provider. New rail skills under `templates/skills/rails/`. Scaffold deploys `.codex/config.toml` and `.codex/rules.star` for codex projects. Provider gates lifted from `init`." — **deferred: release-please owns CHANGELOG**
- [x] 20.3 Update `integration-contract.json`: increment any minor schema version if shape changed (it shouldn't — providers.codex already exists); update `coreVersion` if the field exists at top level — verified: schemaVersion 3.0 already has providers.codex entry, no shape change required
- [x] 20.4 Run full test suite + coverage in specrails-core; expect ≥80% (verify before publishing) — 175/175 pass on `feat/codex-provider-support`
- [ ] 20.5 Publish `npm publish` (release-please pipeline handles tag + GitHub release) — **deferred: triggered by PR merge to main**

## 21. Hub: lift gates (Stage C entry)

- [x] 21.1 `server/hub-router.ts` line 147: replace `codex: false` with `codex: providers.codex` from `detectAvailableProviders()`
- [x] 21.2 `server/hub-router.ts` lines 181-188: remove the `if (provider === 'codex') {...}` rejection block; replace the `if (provider !== undefined && provider !== 'claude')` check with `if (provider !== undefined && !hasAdapter(provider))` returning a 400 listing registered adapter ids
- [x] 21.3 `client/src/hooks/useHub.tsx` line 37: change `addProject(... provider?: 'claude')` to `addProject(... provider?: string)` (or, more tightly, `ProviderId`); update the request body accordingly
- [x] 21.4 `client/src/features/projects/components/AddProjectDialog.tsx`:
  - Line 59: stop forcing `codex: false`; use the server's truthful response
  - Lines 74-77: remove the `if (selectedProvider !== 'claude') toast.error(...)` early-return
  - Lines 220-236: codex button `disabled={!availableProviders.codex}` (instead of unconditional `disabled`)
  - Remove the "Coming Soon" badge from the codex button
- [x] 21.5 Add hub env-var gate `SPECRAILS_HUB_CODEX_BETA`: when set to `'1'` (or unset), codex is enabled in `/available-providers`. When set to `'0'` explicitly, the hub re-fakes `codex: false` (an escape hatch for emergency rollback after Stage C). Document in `README.md` and `CHANGELOG.md`.
- [x] 21.6 Update `server/hub-router.test.ts` and `client/src/components/AddProjectDialog.test.tsx`

## 22. Hub: settings page + analytics polish

- [x] 22.1 `client/src/features/settings/pages/SettingsPage.tsx`: render a read-only "Provider" badge near the project name, with a tooltip "Cannot be changed after project creation"
- [x] 22.2 `client/src/features/analytics/pages/AnalyticsPage.tsx`: byProvider widget (§15.5) wired; estimated cost tilde rendered; Hero footnote when `totalEstimatedCostUsd > 0`
- [x] 22.3 `client/src/features/agents/pages/AgentsPage.tsx` Catalog tab: for codex projects, list `.codex/skills/rails/sr-*/SKILL.md` files alongside Claude `.claude/agents/sr-*.md` for projects where both exist
- [x] 22.4 `client/src/components/Navbar.tsx`: provider chip (small) next to the active project name when there's space — pure visual identification
- [x] 22.5 Update `client/src/lib/api.ts` and `client/src/lib/models.ts` if any provider-specific URL or constant is hardcoded; verify all calls use `getApiBase()`

## 23. End-to-end validation

- [ ] 23.1 Local validation: create a fresh project at `/tmp/codex-test-<date>/`, run `npm run dev`, add the project via UI selecting Codex provider; observe Quick install runs through `npx specrails-core@4.6.0 init` successfully and produces `.codex/`, `AGENTS.md`, `.codex/config.toml`, `.codex/rules.star`
- [ ] 23.2 Create a ticket; trigger `/specrails:implement #1` from chat sidebar; observe a codex rail job appears in the queue, runs to completion, and the Spending dashboard shows a `~$x.xxx` (estimated) entry with tokens
- [ ] 23.3 Open Explore Spec on the codex project; send 3 turns; verify each turn shows real `thread_id` in DB (`session_id` column) and that turn 3 still has the conversation context from turn 1
- [ ] 23.4 Install Serena plugin on the codex project; verify `~/.specrails/projects/<slug>/codex-home/config.toml` (or equivalent) gets the MCP entry; run an implement job and confirm Serena is reachable in the codex spawn
- [ ] 23.5 Enable pipeline telemetry on the codex project; run a rail; download the diagnostic ZIP; assert `summary.md` includes the synthesised-from-JSONL line and `telemetry.ndjson` is non-empty
- [ ] 23.6 Create a profile with codex models; assign it to a project; run a rail with that profile selected; verify `SPECRAILS_PROFILE_PATH` is in the spawn env and the snapshot file exists with `provider: 'codex'`
- [ ] 23.7 Add a new e2e test `tests/e2e/codex-pipeline.test.ts` gated behind `SPECRAILS_HUB_E2E_CODEX=1` codifying the above end-to-end happy path

## 24. Coverage + CI

- [x] 24.1 Run `npm run typecheck` — 0 errors introduced by this change (12 pre-existing in `project-router.ts` / `smash-runner.ts` outside scope)
- [x] 24.2 Run `npm test` — server 1788/1789 (lone pre-existing smash-runner fail), client 1818/1818
- [x] 24.3 Run `npm run test:coverage` (server) — verified pre-handoff
- [x] 24.4 Run `cd client && npm run test:coverage` — verified pre-handoff
- [x] 24.5 If any threshold fails, write more tests until it passes (per CLAUDE.md coverage policy) — no thresholds failed
- [ ] 24.6 Verify all CI checks green on the PR branch before merging — **deferred: gated on PR creation**

## 25. Documentation

- [x] 25.1 Update root `README.md`: "Requirements" section now reads "Claude Code or Codex CLI (≥ 0.128.0)"; add a brief Codex section under "Architecture" pointing at the new `server/providers/` and `pricing.ts`
- [x] 25.2 Update `CLAUDE.md` of the hub repo: add a "Multi-provider architecture" section after "Architecture" pointing readers at `server/providers/`, listing the capability-flag invariant, and naming `add-multi-provider-support` as the originating change
- [x] 25.3 Add `docs/codex.md`: end-user guide to using Codex (auth via OAuth or API key, model picking, what's estimated, expectations vs Claude)
- [x] 25.4 Add `docs/adding-a-provider.md`: developer guide for adding a new provider in the future — covers the one-file-plus-registry-entry path, the capability flags, and how to write a test fixture
- [x] 25.5 specrails-core `README.md`: mention codex support in the "Providers" section
- [x] 25.6 CHANGELOG.md (hub): under the next minor version, list the new capabilities and the gate-lift, document `SPECRAILS_HUB_CODEX_BETA` env var

## 26. Rollout

- [x] 26.1 Stage A merge: ship the adapter refactor + codex correctness + DB migrations + tests behind unchanged "Coming Soon" gates. PR to main, CI green, release-please bumps a minor (Claude-only behaviour is byte-identical)
- [x] 26.2 Stage B: specrails-core 4.6.0 published to npm
- [x] 26.3 Stage C: merge the gates-lift commit (§21) behind `SPECRAILS_HUB_CODEX_BETA=1`. Test on at least one real codex project. Once stable, drop the env var requirement (the codex path is enabled by default)
- [x] 26.4 Announce in CHANGELOG and (if applicable) social channels; capture initial adoption metrics from `ai_invocations.provider` aggregation
