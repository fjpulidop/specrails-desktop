## Context

specrails-hub already has per-project isolation (`ProjectRegistry`, `ProjectContext`, per-project SQLite, WebSocket filtering by `projectId`). Per-agent model configuration lives today as a small section of Project Settings, writing directly to the agent `.md` frontmatter via `QueueManager` pre-spawn hooks.

This change moves that surface into a larger home (a dedicated **Agents** section), introduces a richer config model (profiles), and adds creation/editing of custom agents with optional AI-assisted generation. The runtime contract that makes all of this possible — profile-aware `implement.md` — is shipped by the sibling change `add-profile-aware-implement` in specrails-core 4.1.0, which the hub depends on.

The hub's job is twofold: **manage the catalog** (CRUD on profiles and custom agents, stored in the project tree) and **resolve + inject at spawn time** (snapshot the chosen profile into a job-scoped file, pass the path via env var).

## Goals / Non-Goals

**Goals:**
- Present Agents as a first-class sidebar section alongside Pipeline/Queue/Chat/Analytics/Settings.
- Allow multiple named profiles per project with a default, checked into `.specrails/profiles/`.
- Allow per-rail profile selection at launch (single and batch flows).
- Allow creation and editing of custom agents (`custom-*.md`) with Monaco split-view, validation, AI-assisted generation, and sandboxed "Test agent" runs.
- Preserve existing per-agent model configurations via automatic migration into the project's default profile.
- Add per-profile analytics (usage, success rate, tokens, duration).
- Enrich telemetry signals with `specrails.profile_name`.

**Non-Goals:**
- Cross-project profile library / marketplace (deferred; this change only supports in-project profiles).
- Editing `sr-*.md` upstream agent files (read-only in the hub UI; only `custom-*.md` is editable).
- Running profiles against pre-4.1.0 specrails-core (blocked with an upgrade prompt in doctor).
- Migration tooling for users who hand-edited `implement.md` (out of scope; they continue to own their fork).
- Modifying `ChatManager` or `SetupManager` flows — profiles apply only to `QueueManager` spawns (pipeline jobs).

## Decisions

### 1. Section layout — three tabs

```
/projects/:id/agents
  ├─ /profiles          (default landing)
  ├─ /agents
  └─ /models
```

**Profiles**: tab strip showing each profile + "New". Per profile: orchestrator model, ordered chain of agents (each with model dropdown), routing rule editor (drag to reorder, first-match-wins), validation summary.

**Agents**: catalog view (upstream `sr-*` listed read-only, custom `custom-*` editable). Click-through into Agent Studio for editing or creating.

**Models**: default model selectors (per role), test-connectivity action, model availability display. Essentially the "Models" piece extracted from the old Settings surface.

**Rationale:** three tabs keep each concept on one page without vertical scroll. Profiles is the highest-traffic tab, so it's the default landing.

**Alternative considered:** single sprawling "Agents" page with all config inline. Rejected: too dense, hard to scan, no natural mental break between "catalog" and "configuration".

### 2. Profile catalog storage (`.specrails/profiles/`)

Catalog lives in the project tree:

```
<project>/.specrails/profiles/
  default.json               ← committed, team-shared
  data-heavy.json            ← committed, team-shared
  custom-qa.json             ← committed, team-shared
  .user-preferred.json       ← gitignored, per-developer picker default
```

The hub writes/reads these files via `ProfileManager` in `server/modules/agents/runtime/profile-manager.ts`. Validation against `schemas/profile.v1.json` (from specrails-core npm package) using `ajv` before any write.

`.gitignore` entry is added automatically on first profile creation: `.specrails/profiles/.user-preferred.json`.

**Rationale:** team-shared profiles version naturally; per-developer picker preference stays local. Matches the mental model of `.env` vs `.env.local`.

**Alternative considered:** store profiles in the hub's per-project SQLite. Rejected: profiles are declarative config that should follow the project across clones; SQLite makes them hub-specific and invisible to anyone using the project standalone.

### 3. Profile selection model — catalog vs selection

Two orthogonal concepts the UI must communicate clearly:

- **Catalog**: the set of named profiles available in the project. Shared across all rails.
- **Selection**: the profile chosen for *this particular invocation*. Per-invocation.

The project has a *default selection* (`.user-preferred.json` wins if set, otherwise the profile named `default`). The Launch UI preselects this default. In Batch-implement the default is preselected for every rail; the user can override per rail.

**Rationale:** catalog-shared, selection-per-invocation is the only model that supports concurrent rails with distinct configurations (see the sibling core change's "no batch-level profile coupling" requirement).

### 4. Snapshot-per-job

When `QueueManager` spawns a rail:

1. Resolve the selected profile name.
2. Read the current file contents of the corresponding `.specrails/profiles/<name>.json`.
3. Write the bytes to `~/.specrails/projects/<slug>/jobs/<jobId>/profile.json` (parent dir created as needed).
4. Set `chmod 400` on the snapshot so it cannot be edited mid-run.
5. Spawn `claude` with `SPECRAILS_PROFILE_PATH=<absolute path to snapshot>` in env.

Persistence: the `job_profiles` table stores `{jobId, profileName, profileJson, createdAt}` so analytics can report on what ran.

**Rationale:** immutability across the job lifetime; zero mid-run races; analytics source of truth lives in SQL, not filesystem.

**Alternative considered:** pass the profile name and let `implement.md` re-read from disk. Rejected: user could edit the catalog mid-run, causing inconsistent behavior and brittle debugging.

### 5. Custom agent authoring — `.claude/agents/custom-*.md`

Custom agents live in `.claude/agents/` alongside upstream agents, distinguished by the `custom-` prefix. The sibling core change guarantees `update.sh` never touches files matching `custom-*.md`.

Creation flows (Agent Studio):
1. **Template**: start from a curated template shipped by specrails-core (`templates/agents/`). List fetched via a new core endpoint or bundled copy.
2. **Duplicate**: copy an existing agent (upstream or custom) with new name. All fields editable.
3. **Generate**: user describes the agent in natural language; hub spawns a meta-Claude with a prompt builder; returned draft opens in the Studio diff-viewer for review before save.

Hub-side version history lives in `agent_versions` table (hub DB). Disk always holds the current version; earlier revisions are retrievable from the hub. "Restore v2" writes v2 back to disk.

**Rationale:** aligns with how users naturally think ("my custom agent vs the specrails ones"); no separate render step; `update.sh` is the only moving part and we've already secured it via the core change.

**Alternative considered:** keep custom agents in hub DB and render to disk on activation. Rejected: invisible-to-git, loses team-share property, extra sync step.

### 6. "Test agent" sandbox

Runs the draft agent against a sample task in an isolated spawn:

- Hub invokes `claude` with `--no-interactive` style flags, supplying the draft agent's body as an inline tool prompt and a mock task (user-chosen or library).
- Output streamed to the Studio's Test pane. No filesystem writes occur (workspace is a temp dir, discarded).
- Token/time metrics captured in `agent_tests` table for "how much does this agent cost per run" insight.

**Rationale:** turns agent authoring from "write markdown, cross fingers, run full pipeline" into a <30s inner loop. Differentiator.

**Alternative considered:** skip "Test" in this change, ship editor only. Rejected: the editor without validation of *behavior* is commodity; "Test" is the premium hook that makes the Agent Studio feel like a product.

### 7. Launch-time picker surfaces

- **Single feature launch**: dropdown in the launch dialog, preselected to project default. Change persists to `.user-preferred.json`.
- **Batch-implement launch dialog**: table of rails with a per-rail profile dropdown. One "Same for all: [default ▼]" convenience selector at top that, when changed, updates all unchanged rails.
- **Compact rail header picker** (secondary): small dropdown in the rail's toolbar for quick re-launch with a different profile without reopening the dialog.

**Rationale:** default path stays one-click simple; advanced path is discoverable but never forced.

### 8. Migration of existing Project Settings

On first visit to Agents tab (or on hub upgrade), the migrator:

1. Reads current Project Settings agent-model values.
2. Creates `.specrails/profiles/default.json` from the v1 schema with those values filled in (orchestrator + per-agent models + today's legacy routing rules).
3. Removes the agent-models section from Project Settings UI and shows a one-time banner pointing to Agents.
4. Never runs again once `.specrails/profiles/default.json` exists.

Idempotent and lossless. If the user has a pre-existing `default.json` (edited by hand), the migrator skips and warns.

### 9. Analytics integration

Analytics page gains a "Profile usage" card:

- Profile usage (last 30d): bar chart, job count per profile.
- Success rate by profile: table.
- Avg tokens by profile: table.
- Avg duration by profile: table.

Data source: SQL join of `jobs` × `job_profiles` grouped by `profile_name`, filtered by time window. No new ingestion; reuses existing telemetry rollups.

### 10. Telemetry enrichment

`queue-manager.ts` sets two additional OTEL resource attributes when spawning:

- `specrails.profile_name`: the selected profile's `name` field.
- `specrails.profile_schema_version`: from the profile JSON.

These appear on every trace/metric/log emitted during that job. Downstream OTEL backends (Grafana, Tempo, etc.) can now group by profile without joining against hub SQL.

### 11. Feature flagging

The entire Agents section is gated behind `VITE_FEATURE_AGENTS_SECTION` during rollout. Server-side, `SPECRAILS_AGENTS_SECTION !== 'false'` gates the `/api/projects/:id/profiles/**` endpoints. Follows the same pattern as `VITE_FEATURE_TERMINAL_PANEL`.

Flag ships default-off and flips to default-on once the feature is complete and bite-tested. Users on pre-4.1.0 specrails-core see the section but with a banner: *"Requires specrails-core ≥ 4.1.0. Run `npx specrails-core@latest update` in this project."*

## Risks / Trade-offs

| Risk | Mitigation |
|------|-----------|
| Hub gets ahead of core (hub ships profiles UI before core 4.1.0 releases) | Block merge of hub change until core 4.1.0 is published; doctor command and Agents section banner clearly communicate version requirement to users |
| `.specrails/profiles/` committed with secret-like content by accident | Schema validation rejects unknown fields; profiles are small, structured JSON — low surface for accidental PII |
| User edits a profile file directly while a rail is running | Snapshot-per-job makes this safe for running rails. Newly-launched rails pick up the edit as expected. |
| Agent Studio's "Test agent" spawns unbounded Claude costs | Test runs have a token ceiling (default 4000, configurable); runs visible in `agent_tests` for review |
| Migration overwrites a hand-authored `default.json` | Migrator checks existence; skips and warns if found |
| Monaco bundle size inflates client payload | Monaco is code-split into its own chunk, loaded only when Agents tab is opened |
| Generate-with-Claude produces a bad agent | Draft opens in diff-viewer first; user must explicitly save; version history allows rollback |
| Profile dropdown in launch UIs adds friction for casual users | Preselect default; one-click launch path unchanged for the common case |
| Custom agent name collides with future upstream agent | Validator reserves `sr-*` prefix for upstream; custom names must start with `custom-`; hub's name-availability check rejects collisions |
| Analytics queries slow on projects with many jobs | `job_profiles.profile_name` indexed; metrics pre-aggregated into `telemetry_summaries` on a rolling basis (reuse existing compaction job) |
| Desktop packaging breaks (node-pty-style issue) for `ajv` or `monaco` | Both are pure-JS with no native deps; no sidecar implications |

## Migration Plan

1. **Ship behind feature flag** (`VITE_FEATURE_AGENTS_SECTION=false` default). Internal dogfooding only.
2. **Enable for selected projects** via per-project toggle in hub settings.
3. **Default on** once core 4.1.0 is stable and integration validated.
4. **Remove old Project Settings agent-models surface** after two release cycles (not in this change — tracked as a follow-up cleanup).

**Rollback**: flip the feature flag to false. The `.specrails/profiles/` files are harmless when unused; `QueueManager` falls back to legacy spawn (no env var) and core falls back to legacy mode transparently. No data loss.

## Open Questions

- Should the Models tab be distinct from Profiles, or merge into "the default profile has these models"? Leaning distinct: some users want to set defaults independent of any profile.
- Should Agent Studio's "Generate with Claude" use the same Claude session as the user's project, or a dedicated system prompt? Leaning dedicated with a system prompt specific to agent authoring.
- Does version history for custom agents need diff UI in v1 or is "list + restore" enough? Leaning list + restore for v1.
- How do we expose the profile to the running pipeline's UI (e.g. a badge on the rail view showing "running with: data-heavy")? Design the badge, ship in this change or follow-up?
- Should we support profile import/export between projects in v1? (Mentioned as out of scope but users may ask immediately.) Recommendation: out of scope; file a follow-up.
