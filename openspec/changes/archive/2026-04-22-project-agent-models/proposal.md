## Why

Users have no way to change which Claude model each specrails agent uses without manually editing agent `.md` files or re-running `npx specrails-core init`. The Settings page is the natural home for this control — especially since different agents have different cost/quality tradeoffs (Opus for architect, Haiku for doc-sync).

## What Changes

- New "Agent Models" section in the project `SettingsPage` (hub mode only)
- Combobox per agent showing current model, with full Claude model IDs as options
- "Apply to all" shortcut to set a global default in one action
- Server endpoint `GET /api/projects/:projectId/agent-models` — reads installed agents + current models from `.claude/agents/*.md`
- Server endpoint `PATCH /api/projects/:projectId/agent-models` — writes `install-config.yaml` first, then applies models to agent frontmatter files
- `applyModelConfig(projectPath)` helper on the server that reads `install-config.yaml` and patches `.claude/agents/*.md` frontmatter (replicates what `install.sh` does)

## Capabilities

### New Capabilities

- `project-agent-models`: UI + API for reading and writing per-agent Claude model configuration for specrails-installed projects

### Modified Capabilities

- `pipeline-telemetry`: No requirement changes — SettingsPage layout gains a new card above/below the telemetry section

## Impact

- `server/project-router.ts` — two new routes (`GET` / `PATCH` `/agent-models`)
- `client/src/features/settings/pages/SettingsPage.tsx` — new Agent Models card
- Filesystem: reads `.claude/agents/*.md` frontmatter, writes `.specrails/install-config.yaml` and patches `.claude/agents/*.md`
- No DB changes, no new dependencies
