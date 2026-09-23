## Why

The Add Spec dialog runs a Claude (or Codex) process to draft the spec, but the model is hardcoded — `claude` falls through to its CLI default and `codex` is pinned to `gpt-5.4-mini`. Users have no way to bias spec generation toward speed (Haiku), depth (Opus), or a Codex variant without leaving the modal and editing project-level config. Putting model selection at the entry point makes Add Spec feel like a first-class authoring surface and removes a hidden coupling to project defaults.

## What Changes

- Add a single-model picker to the Add Spec modal (top-right, persistent across the Quick / Explore tab toggle).
- The picker is provider-aware: lists `CLAUDE_MODELS` for `provider=claude` projects and `CODEX_MODELS` for `provider=codex` projects (reuses `client/src/components/ModelSelector.tsx` model lists, NOT the full preset+overrides UI — Add Spec is a one-off, not a multi-agent profile).
- The combo box lives EXCLUSIVELY in the Add Spec modal. No window, panel, or surface downstream of Add Spec exposes any UI to change the model — not the Explore overlay, not the Explore composer, not any restore/minimize path, not the Quick toast. The model is chosen once, at Add Spec, and inherited:
  - **Quick mode** — sent in `POST /tickets/generate-spec` body as `model`; server uses it as `--model` for `claude` or as `--model` for `codex`.
  - **Explore mode** — passed to `ExploreSpecShell` as `initialModel` and used to seed `conversation.model` on first turn; every subsequent turn AND the Create Spec migration step (if it spawns a model call) use the same model. The conversation's `model` field MUST NOT be mutable from the Explore UI in this change.
- Default selection on modal open: project's `models.defaults.model` from `.specrails/install-config.yaml` when readable, else provider default (`sonnet` for claude, `gpt-5.4-mini` for codex). Last user choice is **not** persisted across modal opens in v1 — keep stateless until we have evidence users want it.
- Server: `POST /tickets/generate-spec` accepts an optional `model` field, validated against the provider's model allow-list; rejected values fall back to provider default with a `400` describing the allowed values.

## Capabilities

### New Capabilities
- `add-spec-model-selection`: model-picker contract for the Add Spec entry point — covers UI placement, default resolution, provider-awareness, propagation into Quick and Explore flows, and server-side validation.

### Modified Capabilities
- `explore-spec`: explore conversations now accept an `initialModel` from the launch payload and seed `conversation.model` from it instead of always falling back to the provider default.

## Impact

- **Code**:
  - `client/src/features/specs/components/ProposeSpecModal.tsx` — picker UI, default resolution hook, model passed in submit.
  - `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` — accept `initialModel`, pass to conversation start.
  - `client/src/features/specs/components/SpecsBoard.tsx` — thread `initialModel` through `onExploreLaunch`.
  - `server/project-router.ts` — `generate-spec` accepts and validates `model`, threads into `claude`/`codex` args.
  - Server-side helper to expose project's effective default model to client (small `GET` endpoint OR include in existing project state response — design.md decides).
- **APIs**: `POST /api/projects/:projectId/tickets/generate-spec` body gains optional `model: string`. New (or extended) endpoint for default-model resolution.
- **Specs files**: new `specs/add-spec-model-selection/spec.md`; delta on `specs/explore-spec/spec.md`.
- **No changes to `specrails-core`**. No DB migrations. No new dependencies.
- **Out of scope**: persisting last-used model, ANY model-change UI downstream of Add Spec (Explore composer, Explore header, Create Spec confirm dialog, Quick toast, restored sessions), exposing the full preset+overrides UI, surfacing model in Codex's other one-off flows.
