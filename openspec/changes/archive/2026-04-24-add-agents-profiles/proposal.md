## Why

Today the hub lets each project tweak a handful of agent models from Project Settings. This is useful but it's also a ceiling — there is only one configuration per project, one orchestrator model, one chain of agents. Users who want to run a data-heavy feature with a different chain, or run a security review with different models, have to flip the project-wide setting and remember to flip it back. In a batch with multiple rails running in parallel, **every rail must share the same configuration**, which defeats the purpose of concurrent pipelines.

specrails-hub should expose **agent profiles**: named, catalogued configurations of orchestrator model, agent chain, per-agent models, and task routing — creatable from the UI, checked into the project, selectable per-rail at launch, and editable without touching any markdown file by hand. A new "Agents" section in the project sidebar houses profiles, the agent catalog (with custom-agent authoring and AI-assisted generation), and model defaults. This feature rests on the profile-aware pipeline contract shipped by `specrails-core@>=4.1.0` (see the sibling change `add-profile-aware-implement`).

## What Changes

- Add a new **Agents** section to the project sidebar, between Pipeline/Queue and Settings. It contains three tabs: `Profiles`, `Agents`, `Models`.
- Add a `ProfileManager` backend that reads/writes `<project>/.specrails/profiles/*.json`, validates against the `specrails-core` v1 schema, and handles snapshot-per-job.
- Extend `QueueManager` and `batch-implement` invocation paths to resolve a profile selection for each rail, snapshot it under `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json`, and spawn `claude` with `SPECRAILS_PROFILE_PATH` pointing at that snapshot.
- Add a per-rail profile picker to launch UIs (single feature launch + batch-implement dialog) so users can override the project default per invocation.
- Add an **Agent Studio** (under the `Agents` tab): Monaco-based editor with form+preview split, three entry points (Template / Duplicate / Generate from description via Claude), live validation, and a "Test agent" sandboxed-spawn feature that runs the draft agent against a sample task.
- **BREAKING for hub users, not for specrails-core**: move existing per-agent model settings out of Project Settings and into `Agents → Models` / `Agents → Profiles`. Settings UI shows a breadcrumb link. Existing settings migrate into `default.json` automatically on first Agents-tab visit (zero-loss).
- Add profile usage analytics (per-profile job count, success rate, avg tokens, avg duration) to the Analytics page.
- Extend the OTEL enrichment in `QueueManager` so each telemetry signal carries `specrails.profile_name` as a resource attribute.
- Pin `specrails-core` dependency to `>=4.1.0` in all scaffold/setup flows; the hub surfaces an upgrade prompt when a linked project has an older core.
- Add custom agent authoring: `.claude/agents/custom-*.md` files (never overwritten by `update.sh`, per the sibling change), creatable from Agent Studio, editable with version history kept in the hub DB.

## Capabilities

### New Capabilities
- `agent-profiles`: hub-side management of agent profiles — CRUD on `<project>/.specrails/profiles/*.json`, schema validation, profile resolution, snapshot-per-job, and env-var injection at spawn time.
- `agents-section`: sidebar Agents route + three-tab shell (`Profiles`, `Agents`, `Models`) + per-project memory of the active tab and profile selection.
- `agent-studio`: rich editor (Monaco split-view), agent generation from description via Claude, sandboxed "Test agent" runs, custom-agent CRUD with version history.

### Modified Capabilities
- `project-agent-models`: models-per-agent config moves from Project Settings into the Agents section. The Settings surface is removed; a breadcrumb points to the new location; existing values auto-migrate into the project's `default` profile.

## Impact

- **Code**:
  - `server/modules/agents/runtime/profile-manager.ts` — new module (CRUD + validation + resolve)
  - `server/project-router.ts` — new `/api/projects/:id/profiles/**` endpoints
  - `server/modules/execution/runtime/queue-manager.ts` — snapshot creation + `SPECRAILS_PROFILE_PATH` injection at spawn
  - `server/agent-studio.ts` — new module (template service, generator service, validator, test runner)
  - `server/db.ts` — new tables: `agent_versions`, `agent_tests`, `job_profiles`
  - `client/src/features/agents/pages/AgentsPage.tsx` — new page + subroutes
  - `client/src/features/agents/components/ProfilesTab.tsx`, `AgentsTab.tsx`, `ModelsTab.tsx`
  - `client/src/features/agents/components/AgentStudio.tsx` — Monaco editor + form + preview
  - `client/src/components/agents/ProfilePicker.tsx` — reusable launch-time selector
  - `client/src/features/settings/pages/SettingsPage.tsx` — remove agent-models section, add breadcrumb
  - `client/src/features/analytics/pages/AnalyticsPage.tsx` — per-profile metrics widget
  - `client/src/context/ProjectLayout.tsx` — sidebar entry for Agents
  - Telemetry: add `specrails.profile_name` resource attribute enrichment in `queue-manager.ts`
- **APIs**: new REST surface under `/api/projects/:projectId/profiles`, `/api/projects/:projectId/agents` (custom CRUD), `/api/projects/:projectId/agents/test`. WebSocket events: `profile.changed`, `agent.test_result`.
- **Dependencies**:
  - Add `@monaco-editor/react` to client.
  - Add `ajv` (JSON schema validator) to server.
  - Pin `specrails-core >= 4.1.0` in scaffold and doctor checks.
- **DB migration**: three new tables (`job_profiles`, `agent_versions`, `agent_tests`).
- **Feature flags**: gate the new section behind `VITE_FEATURE_AGENTS_SECTION` during rollout. Default on once a full pass completes. Settings UI migration is not gated — always on for users with `specrails-core >= 4.1.0`.
- **Docs**: CLAUDE.md gains an "Agents section" entry under Architecture. README surfaces the new feature with a screenshot.
- **Tests**: unit tests for `ProfileManager`, `AgentStudio` validators, snapshot-per-job behavior, and UI tests for profile selection in single launch and batch flows.
