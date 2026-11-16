# Design

## Context

See proposal.md for motivation. This is a retrospective description of the existing 48-file diff. Builder generation runs through project conversations; execution runs through durable milestone chains and ordinary rail launch guards. Both reuse installed-provider adapter catalogs. The two additional runtime fixes address failures described during the same flow.

## Goals / Non-Goals

Goals: preserve project ownership, freeze each conversation/chain choice at its existing persistence boundary, and retain explicit user control when a saved choice is unavailable.

## Non-Goals

- Changing project primary providers, day-0 generation defaults, ordinary conversations or loop recipes.
- Installing providers, automatically substituting an unavailable saved choice, or adding a new provider strategy.
- Automatically starting M1 after creation, changing milestone scheduling/delivery policy, or sharing OpenSpec specs and changes across worktrees.
- Repairing the simulated environment's storage location or claiming that every future generation/runtime failure is prevented.

## Decisions

1. Generation preferences use the existing per-project SQLite queue_state key `blueprint.milestone_generation`. Validation precedes a single INSERT OR REPLACE; no generation-settings migration is introduced. GET retains a well-shaped but unavailable saved selection. When none is saved, the compatible project primary or first compatible catalog entry supplies the default.
2. One catalog filters installed providers by native read-only support and exposes models and per-model effort levels. Shared mission selector primitives render it. Provider switches select the provider default model and clear effort; model switches clear effort. The flyout remounts controls and discards stale responses across project changes.
3. Generate snapshots a selection; conversation creation captures provider/model and optional effort in context_scope. Only milestone conversations read the saved generation defaults. Explicit selections do not write those defaults. Subsequent milestone turns read the captured effort and forward it only while supported by the current model catalog.
4. M1 controls use an explicit project API base before that project is active. Execution defaults derive independently of generation preferences. The launch route validates engine input before creating a chain. Migration 92 stores engine_config; every chunk deserializes that frozen choice and requests strict enforcement. Legacy NULL rows retain the preexisting route behavior. Loop recipe conflicts return 409 loop_engine_conflict rather than overriding the requested provider/model/effort.
5. Mission arrival still refreshes the list but reads a current Builder-active ref before selecting the new mission, preserving the post-create M1 controls.
6. Worktree overlay copies only the first available config.yaml/config.yml from ordered roots when neither spelling exists in the checkout. It preserves existing config and refuses to write through an openspec directory symlink. The copy participates in existing ownership/cleanup evidence; no specs or changes are copied.
7. Diagnosis projects Engine 2 nodePath into stepId and structured code/message into bounded text. Repeated-failure detection falls back to the latest failed-step error when run-level error is absent; diagnosis remains read-only.

## Rejected alternatives

The recorded decisions reject overwriting the usual generation preference with a one-off choice, silently switching unavailable saved AI, allowing a conflicting recipe to replace the explicit M1 choice, and sharing OpenSpec artifact directories across worktrees. No other considered alternatives were recorded.

## Risks / Trade-offs

- Provider catalogs can change → settings UI blocks an unavailable saved selection and offers explicit reset/save. Existing conversation effort is forwarded only if still supported; this is not a guarantee to reject every obsolete conversation effort.
- Loop recipes can own a different engine → strict launch rejects the conflict before spawning rather than modifying the recipe.
- Project-created mission arrival can arrive asynchronously → the current Builder-active ref guards automatic navigation after refresh.
- Copied configuration is overlay-owned → existing checkout config wins, directory symlinks are preserved and edited copies lose cleanup authorization.
- Tests inspect HTTP, persistence and native invocation arguments with fakes → they establish selection plumbing, not successful live provider execution or real-user validation.

## Migration Plan

The implementation appends migration 92, adding nullable TEXT engine_config to milestone_launch_chains. Existing rows remain NULL and use legacy launch behavior. Generation preferences reuse queue_state. No down migration or rollback automation is present in this diff.

## Assumptions

- No non-obvious product intention is required to explain the diff. The conversation's open question is resolved by code: both model and effort are selectable.
- The summary describes a broad block-on-unavailable policy. In code, settings UI and settings/launch validation enforce catalog availability, while ChatManager drops unsupported stored effort on later turns; this derivation does not claim stronger runtime rejection.
- Reopening persistence is supported by SQLite storage and tests recreating the router; no actual application-close/reopen or live CLI test was run by this derivation role.
- The worktree fix is general overlay behavior, not only Builder behavior. The summary's simulated node_modules environment repair is not part of the frozen diff.
- Existing main specs include historical branch-stacking language; unchanged requirements/scenarios are retained in modified deltas rather than expanding this change into a lifecycle rewrite.

## Blast radius

- `client/src/components/__tests__/BuilderSidebarEntry.test.tsx` — Assert sidebar launch sends the selected engine with auto-continue.
- `client/src/components/__tests__/MilestoneGenerateShell.test.tsx` — Assert selection precedes the seeded turn and rejected creation sends no turn.
- `client/src/components/__tests__/MilestoneGenerationControls.test.tsx` — Cover saved preferences, exceptions, stale responses, unavailable settings and M1 controls.
- `client/src/components/__tests__/ProjectBuilder.test.tsx` — Assert the done screen loads and passes the execution selection.
- `client/src/features/builder/components/project-builder/BuilderConversation.tsx` — Render M1 execution controls for the created project.
- `client/src/features/builder/components/project-builder/BuilderSidebarEntry.tsx` — Wire generation and execution controls, capture generation selection, reset on project switches and preserve selector listbox interaction.
- `client/src/features/builder/components/project-builder/MilestoneGenerateShell.tsx` — Send provider/model/effort at creation and handle HTTP failures.
- `client/src/features/builder/components/project-builder/MilestoneGenerationControls.tsx` — Add catalog selectors, persistent preference saving, temporary overrides and availability guards.
- `client/src/features/builder/components/project-builder/MilestoneLaunchControls.tsx` — Load explicit-project execution catalog, select engine and retry catalog errors.
- `client/src/features/builder/hooks/useBuilderSession.ts` — Forward optional M1 engine through the launch hook.
- `client/src/features/builder/lib/__tests__/milestone-launch.test.ts` — Assert engine and checkpoint preference request serialization.
- `client/src/features/builder/lib/milestone-launch.ts` — Accept execution selection and use explicit-project API base.
- `client/src/features/builder/README.md` — Document generation/execution controls and Builder mission-arrival behavior.
- `client/src/features/missions/context/AgentChatContext.test.tsx` — Cover preserving Builder on mission arrival and support multiple WS handlers in the test harness.
- `client/src/features/missions/context/AgentChatContext.tsx` — Refresh missions without auto-selecting arrivals while Builder is active.
- `client/src/lib/__tests__/api.test.ts` — Assert explicit-project routing does not alter the active project.
- `client/src/lib/api.ts` — Allow a project id override for newly created projects.
- `client/src/locales/de/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/en/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/es/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/fr/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/it/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/ja/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/pt/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `client/src/locales/zh/builder.json` — Add localized generation preference, exception, unavailable/reset, execution and retry labels.
- `docs/internals/project-builder.md` — Document selection scope, persistence, launch engines and isolated OpenSpec config.
- `docs/internals/source-map.md` — Index three added production files and update the inventory count.
- `server/blueprint-progress-route.test.ts` — Assert execution selection forwarding and invalid engine rejection before chain start.
- `server/db/migrations.ts` — Append migration 92 for nullable chain engine_config.
- `server/modules/agent-runtime/README.md` — Document Engine 2 diagnosis normalization.
- `server/modules/agent-runtime/runtime/agent-runtime-controls.test.ts` — Cover structured repeated failure diagnosis without execution or recovery mutation.
- `server/modules/agent-runtime/runtime/agent-runtime-controls.ts` — Normalize node paths/structured errors and use attempt errors for repetition detection.
- `server/modules/boundaries.json` — Declare the generation-settings public subpath and dependencies.
- `server/modules/builder/README.md` — Document settings routes, project persistence and frozen chain engines.
- `server/modules/builder/runtime/milestone-chain-store.test.ts` — Assert explicit engine serialization and legacy NULL compatibility.
- `server/modules/builder/runtime/milestone-chain-store.ts` — Store optional execution engine in each durable chain row.
- `server/modules/builder/runtime/milestone-chain.test.ts` — Assert frozen selection across failure, manager replacement, retry and next rail.
- `server/modules/builder/runtime/milestone-chain.ts` — Load and validate frozen engine shape and forward strict selection for every chunk.
- `server/modules/builder/runtime/milestone-generation-settings.ts` — Provide compatible catalogs, project defaults, preference validation and durable read/write.
- `server/modules/conversations/runtime/chat-manager.test.ts` — Assert native Claude/Codex effort flags for milestone generation.
- `server/modules/conversations/runtime/chat-manager.ts` — Read stored milestone effort and forward supported values to each native turn.
- `server/modules/delivery/runtime/rails-router.test.ts` — Assert strict selection execution and rejection of conflicting recipe-owned engines.
- `server/modules/delivery/runtime/rails-router.ts` — Reject loop configuration conflicts when strict engine selection is required.
- `server/project-router-chat.ts` — Apply milestone-only defaults, validate effort and persist conversation provider/effort.
- `server/project-router.test.ts` — Cover project isolation, durable defaults, catalog filtering, overrides and invalid settings.
- `server/project-router.ts` — Expose settings routes and validate optional launch engine before chain start.
- `server/worktree-overlay.test.ts` — Cover isolated config copying, fallback roots, cleanup authentication and checkout/symlink preservation.
- `server/worktree-overlay.ts` — Copy only missing OpenSpec config and authorize its cleanup against configured roots.
