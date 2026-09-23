## Why

The Add Spec modal exposes context-scope as a 4-checkbox panel (Specrails specs, OpenSpec specs, Full repo read, External MCPs) that the user must mentally compose every time. With Contract Refine landing (5th dimension) the panel becomes harder to reason about, and the "right" combinations are essentially 5-6 named presets the user picks 95% of the time. A horizontal **6-stop snap slider** ("Minimal → Hub") collapses the cognitive load into one drag, exposes the relative *cost* of each stop, and surfaces the Contract Refine toggle without yet another standalone control. The 4 checkboxes (now 5) stay reachable behind a `▾ Fine-tune` disclosure for the power-user moments when none of the presets fit.

## What Changes

- Add `contractRefine: boolean` to the per-conversation `contextScope` (server-side `ContextScope` type, `chat_conversations.context_scope` JSON, default `false`). Existing scope normalisation MUST default unset values to `false`.
- The `from-draft` commit hook and the `runContractRefine` runner SHALL read `conversation.context_scope.contractRefine` instead of the project-wide `getExploreContractRefineEnabled` setting. The project-wide setting MUST remain as the *default boot value* the modal picks when the user has no `add_spec_context_scope_last` yet.
- Replace the existing context-scope checkbox row in `ProposeSpecModal` (Explore mode) with a new `<ContextScopeSlider>` component:
  - 6 snap stops at `Minimal | Light | Standard | Rich | Max | Hub`
  - Drag horizontally, snap-to-nearest on release; click on a dot jumps; keyboard `←/→` moves one stop, `Home`/`End` jumps to extremes; touch-drag supported (Tauri webview + mobile-style pointer events)
  - Below the slider: one-line summary of the active preset (toggles enabled + estimated relative cost like `~2× cost, ~5k tokens prefix`)
  - Disclosure `▾ Fine-tune` keeps the 5 individual checkboxes; toggling them off-preset shows a `Custom` indicator between the two nearest stops.
- The 6 preset → 5 boolean mapping table (locked v1):

  | Stop | specrails | openspec | full | mcp | contractRefine | Rough cost |
  |------|-----------|----------|------|-----|----------------|------------|
  | Minimal  | ☐ | ☐ | ☐ | ☐ | ☐ | 1× |
  | Light    | ☑ | ☐ | ☐ | ☐ | ☐ | 1.3× |
  | Standard | ☑ | ☑ | ☐ | ☐ | ☐ | 1.6× |
  | Rich     | ☑ | ☑ | ☑ | ☐ | ☐ | 2× |
  | Max      | ☑ | ☑ | ☑ | ☐ | ☑ | 4× |
  | Hub      | ☑ | ☑ | ☑ | ☑ | ☑ | 4-6× |

- `add_spec_context_scope_last` payload extends with `contractRefine`; missing legacy values normalise to the project default.
- Settings page Explore Spec card: relabel the existing "Enrich committed specs…" toggle to "Default Contract Refine for new specs" so it reads as a default boot value, not a global on/off.
- Quick mode in the Add Spec modal SHALL render a standalone `Enrich with Contract Layer` toggle (no slider, no other scope flags — Quick has no per-conversation `contextScope`). The toggle's default value is the project setting; the user's last choice persists in `add_spec_quick_contract_refine_last` (per project, free-form JSON like the existing scope-last keys).
- Quick mode's existing `POST /tickets/generate-spec` flow SHALL gain a `contractRefine: boolean` field in its request body. When `true`, the server schedules `runContractRefine` after the spec is generated (mirroring the from-draft hook). The refine runner gains a code path that accepts a *non-Explore* trigger: when there is no parent Explore conversation `session_id` to `--resume`, the runner SHALL spawn a fresh `claude` (no resume) seeded with a one-shot system prompt that includes the just-generated spec body as the only context. The same `contract-layer` block + PATCH + `explore.contract_refine_failed` / success broadcasts apply.
- In Explore mode, Contract Refine is positioned **only on the heaviest stops** of the slider (`Max` and `Hub`); the four lighter stops keep `contractRefine=false`. The Fine-tune disclosure still lets users opt-in independently (entering Custom).
- The retry endpoint `POST /tickets/:id/contract-refine` SHALL be gated by the *project default* toggle (unchanged) so retries continue to work after a conversation row is deleted. Tickets created with `contractRefine=false` in their `contextScope` SHALL still be eligible for retry if the project default is on.

## Capabilities

### New Capabilities
<!-- None — extension of existing explore-spec capability. -->

### Modified Capabilities
- `explore-spec`: per-conversation `contextScope` gains a `contractRefine` field; the commit hook reads it from the conversation, not from the project setting. The Add Spec modal exposes the field through a new slider control alongside the existing 4 scope flags. Quick mode (Fast spec generation) also gains a standalone Contract Refine toggle which extends the refine runner to fire after `POST /tickets/generate-spec`.

## Impact

- **Server (`server/modules/conversations/runtime/context-scope.ts`)**: extend `ContextScope` type, `defaultBootScope`, `normalizeContextScope`, and `buildScopedSystemPromptPrefix` for the new flag.
- **Server (`server/project-router.ts`)**: `POST /tickets/from-draft` hook reads `conversation.context_scope.contractRefine` (fallback to project setting only when scope is absent on legacy rows). `add_spec_context_scope_last` GET/PATCH already accepts a free-form JSON payload; just document the new field.
- **Server (`server/modules/specs/runtime/contract-refine-runner.ts`)**: no functional change; the toggle check stays as a defence-in-depth (still respects per-project + kill switch). New early-return path `reason='scope-disabled'` when the conversation's stored scope opted out.
- **Client (`client/src/features/chat/components/ContextScopeSlider.tsx`)**: new component (rail + 6 stops + drag + keyboard + touch + cost line). Headless dragging via pointer events; accessibility via `role="slider"` ARIA pattern.
- **Client (`client/src/features/specs/components/ProposeSpecModal.tsx` and `client/src/features/chat/hooks/useContextScope.ts`)**: switch the existing checkbox row to the slider; keep the checkboxes inside the `▾ Fine-tune` disclosure powered by the same state. Persist `contractRefine` alongside the other flags in `add_spec_context_scope_last`.
- **Client (`client/src/features/settings/pages/SettingsPage.tsx`)**: relabel the Contract Refine toggle copy.
- **Tests**: new client tests for the slider (drag/snap, keyboard, touch, Custom indicator); update existing `useContextScope` and `ProposeSpecModal` tests for the new toggle field; update `contract-refine-runner.test.ts` to cover the scope-driven gating path.
- **Storage**: no schema migration. `context_scope` is JSON; existing rows without `contractRefine` normalise to `false`. `add_spec_context_scope_last` is free-form per project.
- **Out of scope (deferred)**: custom preset definitions per project; preset budget shown in real tokens (instead of relative `Nx`); preset persistence per *user* across machines (only per project, local).
