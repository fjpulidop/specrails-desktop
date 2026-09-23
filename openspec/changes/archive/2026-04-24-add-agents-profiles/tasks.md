## 1. Upstream dependency readiness

- [ ] 1.1 Confirm `specrails-core@4.1.0` is published with `add-profile-aware-implement` complete — **gated on core release**
- [ ] 1.2 Bump dep in scaffold/setup code paths (`SetupManager`, doctor preflight) to require `>=4.1.0` — **pending core release**
- [x] 1.3 Add `ajv` to `server/package.json`; add `@monaco-editor/react` to `client/package.json` — ajv added; monaco-editor pending client work in group 7-11

## 2. Database migrations

- [x] 2.1 Add `job_profiles` table to per-project SQLite schema (`server/db.ts`): `(job_id TEXT PRIMARY KEY, profile_name TEXT, profile_json TEXT, created_at INTEGER)`
- [x] 2.2 Add `agent_versions` table to hub-level or per-project SQLite: `(id INTEGER PK, agent_name TEXT, version INTEGER, body TEXT, created_at INTEGER)` with unique (`agent_name`, `version`)
- [x] 2.3 Add `agent_tests` table: `(id INTEGER PK, agent_name TEXT, draft_hash TEXT, sample_task_id TEXT, tokens INTEGER, duration_ms INTEGER, output TEXT, created_at INTEGER)`
- [x] 2.4 Index `job_profiles.profile_name`, `agent_versions(agent_name, version)`, `agent_tests(agent_name)`

## 3. `ProfileManager` backend module

- [x] 3.1 Create `server/modules/agents/runtime/profile-manager.ts` with `list/get/create/update/duplicate/rename/delete` over `.specrails/profiles/*.json`
- [x] 3.2 Load and cache `schemas/profile.v1.json` — bundled at `server/schemas/profile.v1.json` (copied from specrails-core 4.1.0; to keep in sync via a future script)
- [x] 3.3 Add `ajv`-based validator; every write passes through it; structural checks (default-last, exactly-one-default) enforced in code beyond the schema
- [x] 3.4 Implement `resolveProfile(projectPath, explicit?)` honoring resolution order (explicit → `.user-preferred.json` → `default`/`project-default`)
- [x] 3.5 Implement `snapshotForJob(slug, jobId, resolved)` that copies bytes to `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json` and chmods 400
- [x] 3.6 Implement `persistJobProfile(db, jobId, resolved)` writing to `job_profiles`
- [x] 3.7 Unit tests for CRUD, validation errors, resolution order, snapshot semantics (see `profile-manager.test.ts`)

## 4. API endpoints

- [x] 4.1 `GET/POST/PATCH/DELETE /api/projects/:projectId/profiles` — list/create/update/delete profiles
- [x] 4.2 `POST /api/projects/:projectId/profiles/:name/duplicate` — duplicate with new name
- [x] 4.3 `POST /api/projects/:projectId/profiles/:name/rename` — rename
- [x] 4.4 `GET /api/projects/:projectId/profiles/resolve?profile=<name>` — preview what would resolve
- [x] 4.5 `GET /api/projects/:projectId/profiles/active` — read `.user-preferred.json`
- [x] 4.6 `PUT /api/projects/:projectId/profiles/active` — write `.user-preferred.json`
- [x] 4.7 Mount endpoints in `server/project-router.ts` and gate by `SPECRAILS_AGENTS_SECTION` env
- [x] 4.8 WebSocket events: `profile.changed` broadcast on write
- [x] 4.9 `.gitignore` auto-append on first `.user-preferred.json` write (handled by `setUserPreferred` in `profile-manager.ts`)

## 5. `QueueManager` integration

- [x] 5.1 Extend `QueueManager` enqueue+spawn to accept `profileName`, resolve via `ProfileManager`, snapshot, and persist to `job_profiles`
- [x] 5.2 Inject `SPECRAILS_PROFILE_PATH=<abs snapshot path>` into the spawn env
- [x] 5.3 Add `specrails.profile_name` and `specrails.profile_schema_version` to the OTEL resource attributes (extended `buildTelemetryEnv` signature)
- [x] 5.4 Legacy fallback: if `specrails-core` version < 4.1.0, DO NOT inject env var (wired via `projectSupportsProfiles` reading `.specrails/specrails-version`)
- [x] 5.5 Unit tests for `projectSupportsProfiles` and `buildTelemetryEnv` (full spawn-env integration tests deferred — `server/projects-supports-profiles.test.ts`)

## 6. Batch-implement per-rail forwarding (hub side)

- [x] 6.1 `BatchImplementWizard` collects per-feature profile overrides and emits `--profiles "ref=profile,..."` on the `/specrails:batch-implement` command for the core orchestrator to consume
- [x] 6.2 Top-level batch spawn inherits its `SPECRAILS_PROFILE_PATH` from the batch-level picker; per-rail overrides flow to the orchestrator via the flag — actual per-rail env injection inside batch-implement is in core's hands (`add-profile-aware-implement` change)
- [ ] 6.3 Unit tests: deferred — requires the core orchestrator changes to be testable end-to-end

## 7. Sidebar + Agents page shell

- [x] 7.1 Add "Agents" entry to the top navbar (Home/Analytics/Agents/Settings layout) — hub mode only via existing project routing
- [x] 7.2 Create `client/src/features/agents/pages/AgentsPage.tsx` with three-tab shell (`Profiles`, `Agents`, `Models`)
- [x] 7.3 Route: `/agents` → default Profiles tab (hub mode uses per-project base via `getApiBase()`)
- [x] 7.4 Per-tab memory of active sub-tab (Profiles vs Agents Catalog) via localStorage
- [x] 7.5 Gate client-side behind `VITE_FEATURE_AGENTS_SECTION` (via `FEATURE_AGENTS_SECTION` in `feature-flags.ts`)
- [x] 7.6 Upgrade banner when `specrails-core` version is older than 4.1.0 (reads `/profiles/core-version` endpoint; yellow warning banner above tabs)

## 8. Profiles tab UI

- [x] 8.1 `ProfilesTab.tsx` — list pane with profiles, "New" action, per-row duplicate/delete/preferred
- [x] 8.2 Profile editor: orchestrator model selector, agent chain builder (move up/down, per-agent model dropdown), routing rules editor (move up/down, first-match-wins hint, terminal `default:true` pinned last)
- [x] 8.3 Required agents marked non-removable (`sr-architect`, `sr-developer`, `sr-reviewer`)
- [x] 8.4 Live structural validation in the editor: baseline trio, terminal default rule, routing target-exists. Disables Save while issues exist
- [x] 8.5 Save action calls `PATCH /api/projects/:id/profiles/:name`
- [x] 8.6 Duplicate/rename/delete actions (rename via duplicate+delete flow; explicit rename endpoint wired but not yet surfaced in UI)
- [x] 8.7 Loading/empty states

## 9. Agents tab UI

- [x] 9.1 `AgentsCatalogTab.tsx` — catalog segmented into Upstream (`sr-*`, read-only viewer) and Custom (`custom-*`, read-only for now)
- [x] 9.2 Read-only viewer for upstream agents shows metadata + body
- [ ] 9.3 Custom agents expose "Open in Studio" and "Version history" — **requires Agent Studio (group 11); deferred**

## 10. Models tab UI — **DROPPED**

The Models tab was removed during implementation: models live per-agent inside profiles (decision taken in the Profiles tab UX pass). The three tasks below are intentionally not shipped and will not be in v1.

- [ ] 10.1 ~~ModelsTab~~ — dropped
- [ ] 10.2 ~~Test connectivity~~ — moved into the existing CLI badge in the top navbar
- [ ] 10.3 ~~Per-role defaults~~ — superseded by per-agent models in the default profile

## 11. Agent Studio

- [x] 11.1 `AgentStudio.tsx` — textarea body editor + inline validation hints (Monaco upgrade deferred for smaller bundle)
- [x] 11.2 Create-new modal: "New" button in the catalog rail; Duplicate copies from any agent
- [x] 11.3 Template entry: 4 bundled templates (Security Reviewer, Data Engineer, Performance Profiler, UI/UX Polisher) available from the catalog rail and empty state
- [x] 11.4 Duplicate entry: copy existing agent, prefill body, user supplies the new `custom-*` name
- [x] 11.5 Generate entry: server endpoint spawns Claude with agent-authoring system prompt (`server/modules/agents/runtime/agent-generator.ts`); Studio opens in create mode with the draft for review
- [x] 11.6 Live validation: name regex, frontmatter presence (collision check is server-side via 409)
- [x] 11.7 Save: validate → write `.claude/agents/<name>.md` → append `agent_versions` row
- [x] 11.8 Version history panel: list revisions, restore (writes next version on save)
- [x] 11.9 "Test agent" action: sandboxed claude spawn (`testCustomAgent` in `agent-generator.ts`), streams output, enforces 4000-token ceiling + 120s wall-clock, persists to `agent_tests`
- [x] 11.10 Sample-task library — curated 5-entry dropdown in the Test pane (IaC, SQL injection, a11y, migration, perf)

## 12. Launch-time profile pickers

- [x] 12.1 Extend single-feature launch dialog with `ProfilePicker` preselected to the resolved default
- [x] 12.2 Extend batch-implement launch dialog with `ProfilePicker` (single for all rails) — **per-rail overrides in the batch dialog deferred as polish**
- [x] 12.3 Rail header: compact profile picker (`RailProfileSelector`) — persists per rail in the rails table, hides while running, falls back to "legacy" option when the user wants no profile
- [x] 12.4 Submitting a single-feature launch writes `.user-preferred.json` when the user picked a non-default profile (via `PUT /profiles/active` fire-and-forget)

## 13. Migration from legacy Project Settings

- [x] 13.1 Migration triggered manually via "Migrate from current agents" button in ProfilesTab empty state; reads frontmatter models and generates `.specrails/profiles/default.json`
- [x] 13.2 Idempotency: endpoint returns 409 if `default.json` already exists
- [x] 13.3 Agent Models section in `SettingsPage.tsx` replaced with a breadcrumb card pointing to `/agents`; dead state + functions removed
- [ ] 13.4 Decommission `agent-models` server endpoint and `applyModelConfig` code path — **kept as safety net for one release cycle; remove in a follow-up change**

## 14. Analytics integration

- [x] 14.1 Add SQL aggregation for per-profile metrics (join `jobs` × `job_profiles`) via GET /profiles/analytics
- [x] 14.2 Profile usage card surfaced at the top of the Profiles tab (bars + success rate + avg duration + avg tokens) — **lives in Agents → Profiles, not AnalyticsPage; redirecting there deferred**
- [x] 14.3 Time window selector (7d / 30d / 90d)

## 15. Telemetry enrichment

- [x] 15.1 `buildTelemetryEnv` accepts extra OTEL resource attributes so spawns under a profile emit `specrails.profile_name` + `specrails.profile_schema_version`
- [x] 15.2 OTLP receiver surfaces attributes inline via existing enrichment (no receiver-side change needed)
- [x] 15.3 Diagnostic ZIP export includes `profile.json` snapshot + `profile_name` in `job-metadata.json`

## 16. Doctor / compat-check hooks

- [ ] 16.1 Doctor reports specrails-core version and whether profile mode is available
- [ ] 16.2 Doctor warns if `.specrails/` contains invalid profiles
- [ ] 16.3 `compat-check` surfaces the profile schema version the project uses

## 17. Tests

- [x] 17.1 Unit tests for `ProfileManager` CRUD + validation (`profile-manager.test.ts`)
- [x] 17.2 Unit tests for snapshot-per-job (bytes match; chmod 400) — `profile-manager.test.ts::snapshotForJob`
- [x] 17.3 Unit tests for resolution order (explicit / `.user-preferred.json` / `default`) — `profile-manager.test.ts::resolveProfile`
- [ ] 17.4 Unit tests for batch per-rail forwarding — **deferred: batch per-rail override still TODO (architectural block, see 12.2)**
- [ ] 17.5 Integration test: launch a single feature with profile; verify `SPECRAILS_PROFILE_PATH` reaches the spawned process (mock claude binary) — **deferred: heavier mock setup**
- [x] 17.6 Legacy-core detection tested directly (`projects-supports-profiles.test.ts`); full spawn-env integration deferred
- [ ] 17.7 Client tests: Profiles tab renders; validation errors shown — **deferred: UI tests live outside the critical path**
- [ ] 17.8 Client tests: Agent Studio flows — **deferred**
- [ ] 17.9 Client tests: launch dialog profile picker — **deferred**
- [x] 17.10 Migration logic test coverage via `profile-migrate.test.ts` (baseline trio success, missing baseline, custom-* ignored, overwrite refused)
- [ ] 17.11 Coverage threshold not yet verified locally — **rely on CI to enforce**

## 18. Documentation

- [x] 18.1 `CLAUDE.md` Architecture section added (Agents section, profiles, reserved paths)
- [ ] 18.2 README with feature overview + screenshot — **separate doc pass; screenshots needed**
- [x] 18.3 Dedicated "Profiles quick start" doc (`docs/profiles-quick-start.md`)
- [x] 18.4 Migration behavior documented in the empty-state copy + CLAUDE.md

## 19. Release readiness

- [x] 19.1 Feature flag defaults to ON (`VITE_FEATURE_AGENTS_SECTION`) — can be set to `false` at build time for staged rollouts
- [ ] 19.2 Internal dogfood pass — **user-driven**
- [ ] 19.3 Flip flag default — **already default-on; this task is about flipping after dogfood, which happens later**
- [ ] 19.4 Changelog entry — **handled by release-please on merge to main**
