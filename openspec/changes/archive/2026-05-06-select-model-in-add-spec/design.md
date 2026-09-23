## Context

Add Spec is the funnel for creating new tickets. It runs in two modes:

```
ProposeSpecModal
├── Quick   → POST /tickets/generate-spec → claude (no --model) | codex --model gpt-5.4-mini
└── Explore → ExploreSpecShell → conversation.model (currently provider default)
```

The model is fixed at the call site for Quick (no body field), and seeded from a hardcoded default for Explore. `client/src/components/ModelSelector.tsx` already exposes `CLAUDE_MODELS`, `CODEX_MODELS`, and `PRESET_DEFAULTS` for the agents profile editor; that component is preset-and-override based and is too heavy for a single-shot picker.

Project-level "default model" lives in `.specrails/install-config.yaml` under `models.defaults.model`, parsed by `readAgentModels` / regex helpers in `server/project-router.ts`. There is no existing client-facing endpoint that returns that value as a single field.

## Goals / Non-Goals

**Goals:**
- One model decision, made before generation, used identically by Quick and Explore.
- Provider-aware list (claude vs codex) — never offer a model the project's CLI cannot run.
- Sensible default that respects project config.
- Server-side validation so a forged or stale model name cannot reach the spawned process.
- Reuse `CLAUDE_MODELS` / `CODEX_MODELS` constants — no new model registry.

**Non-Goals:**
- Any model-change UI downstream of the Add Spec modal — the combo box exists in exactly one place, period. No Explore-header dropdown, no Explore composer model toggle, no per-message switcher, no restore-time picker, no Quick toast option.
- Persisting last-used model across modal opens (deferred — stateless until users ask).
- Exposing preset + per-agent overrides like the agents profile editor (wrong abstraction for a one-off authoring step).
- Touching `specrails-core` or any rail/profile flow.
- Changing the Quick spawn shape for `claude` beyond adding `--model` (no extra args).

## Decisions

### D1. Picker is a single dropdown, not the full `ModelSelector`

A single `<Select>` with provider-filtered options. Rationale: Add Spec produces one artefact via one process — preset + overrides UI implies multi-agent orchestration that does not exist here. The dropdown reuses the model-name → label map from `CLAUDE_MODELS` / `CODEX_MODELS` so we keep one source of truth without dragging in the heavier component.

Alternative considered: render `ModelSelector` with `agentId="spec-generator"`. Rejected — forces a fake agent into the override map and exposes preset semantics that don't apply.

### D2. Default resolution: project config → provider default, computed server-side

A new field `defaultSpecModel` is added to the existing project state response (`GET /api/projects/:projectId/state` or the closest equivalent — confirm exact endpoint during implementation; if no clean carrier exists, add `GET /api/projects/:projectId/default-spec-model`). The server reads `.specrails/install-config.yaml` `models.defaults.model`, falls back to `sonnet` (claude) or `gpt-5.4-mini` (codex). The client uses that value to preselect on modal open.

Alternative considered: client-side parsing of install-config. Rejected — config schema lives behind server helpers; duplicating parse logic in client invites drift.

Alternative considered: hardcoded `sonnet` / `gpt-5.4-mini` default. Rejected — silently overrides project defaults the user already configured.

### D3. Combo box ONLY in Add Spec; zero model-change UI downstream

The model selected in the modal flows into both the Quick body and the Explore launch payload. NO downstream surface — Explore overlay header, Explore composer, restore-from-minimize, Create Spec migration dialog, Quick toast — exposes any UI to change the model. Explore's existing `changeConversationModel` API may remain in code (used internally if ever needed) but MUST NOT be wired to any user-facing control in this change. Rationale: user explicitly framed this as one decision at Add Spec, inherited by both branches, immutable thereafter. Adding a downstream switcher later is a separate change with its own UX review.

### D4. Server-side validation against provider allow-list

`POST /tickets/generate-spec` validates `req.body.model`:
- If `provider=claude`: must appear in `CLAUDE_MODELS` (server gets a copy of the list, single export shared with client via a shared TS constants module under `shared/`).
- If `provider=codex`: must appear in `CODEX_MODELS`.
- Missing or empty: fall back to `defaultSpecModel`.
- Invalid: HTTP 400 `{ error, allowed: string[] }`.

Rationale: client validation is a UX nicety, not a security boundary. The model name is forwarded to a `spawn()` arg list — an unvetted value is a CLI-arg-injection vector even if `spawn` doesn't shell-parse, because future code might. Cheap to whitelist.

Alternative considered: pass-through with no validation. Rejected — hidden coupling to upstream CLI behavior; bad value surfaces as a confusing CLI error in the toast.

### D5. Server owns model constants; client renders what the endpoint returns

Define `CLAUDE_MODELS` / `CODEX_MODELS` (id + label pairs) in a new `server/modules/specs/runtime/spec-models.ts`. The `GET /api/projects/:projectId/default-spec-model` response carries the resolved default AND the full allow-list as `{ model, provider, allowed: [{ value, label }] }`. The client renders the dropdown directly from `allowed` — it does not maintain its own copy.

Existing `CLAUDE_MODELS` / `CODEX_MODELS` constants in `client/src/components/ModelSelector.tsx` are scoped to the agents profile editor and remain untouched (different concern: preset/override matrix). When they fall out of sync with server's list, the agent-profile picker may surface a stale entry — acceptable for now since the agents profile UI is a power-user surface and is independently audited.

Alternative considered: top-level `shared/spec-models.ts` consumed by both. Rejected — server `tsconfig.json` has `rootDir: "server"` and `outDir: "server/dist"`; introducing a sibling rootDir would either break `server/dist/index.js` paths (referenced from `package.json` "files" + scripts) or require a multi-tsconfig refactor disproportionate to the change.

Alternative considered: duplicate the array on the client. Rejected — guarantees drift.

### D6. Explore: `initialModel` on the launch payload

`ExploreLaunchPayload` gains `model: string`. `ExploreSpecShell` passes it to whatever creates the conversation row (server `POST /explore/conversations` or equivalent). Server uses it as the conversation's `model` column from row 0. No DB migration — `model` already exists.

## Risks / Trade-offs

- **[Drift between client and server model lists]** → Single shared `shared/spec-models.ts`. CI typecheck catches removal/rename of constants used by either side.
- **[New model ships in CLI before the hub knows about it]** → Whitelist gates new models behind a hub release. Mitigation: list lives in one file; PR is a one-line append. Acceptable trade-off vs the CLI-arg-injection risk.
- **[Project's `install-config.yaml` references a model not in our allow-list]** → Server falls back to provider default and logs a warning. Modal still opens; picker shows the provider default selected.
- **[User changes provider after modal opens]** (extremely edge) → Modal lifecycle scoped to single open; on next open default re-resolves. Acceptable.
- **[Codex flows that previously hardcoded `gpt-5.4-mini` produce different output]** → Default resolution honors project config first; behavior only changes when project explicitly configured a different default, which is the desired outcome.

## Migration Plan

No data migration. Rollout:
1. Land server changes (validation, default resolution endpoint, request body acceptance) — backwards compatible: missing `model` falls back to current behavior.
2. Land shared constants module.
3. Land client picker + thread-through.
4. Existing modals open without behavioural change for users on default config (default resolves to current implicit behavior).

Rollback: revert client commits — server tolerates missing `model` field, so no coordinated rollback needed.

## Open Questions

- Does Explore's "Create Spec" migration step spawn an additional model call, or only persist the draft? If it spawns one, that call must reuse `conversation.model`. If it only persists, no extra wiring needed. Resolve in the `tasks.md` step that touches the Explore commit path — read `server/explore-conversation*.ts` (or equivalent) to confirm.
- Exact endpoint that should carry `defaultSpecModel` to the client — extend an existing project-state response if one fits cleanly, otherwise add a focused `GET /api/projects/:projectId/default-spec-model`.
