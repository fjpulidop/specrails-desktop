# Tasks

All checked tasks describe work already present in the frozen diff. Evidence names inspected test assertions, not test runs performed by the deriver.

## 1. Project generation settings

- [x] 1.1 Add project-owned provider/model/nullable-effort persistence and compatible catalog; verify project isolation and router recreation assertions.
  - Evidence: server/modules/builder/runtime/milestone-generation-settings.ts, server/project-router.ts, server/project-router.test.ts (asserts durable preference, independent project defaults, filtered Claude/Codex catalog and rejected invalid updates).
- [x] 1.2 Apply saved defaults only to milestone conversation creation and preserve explicit overrides; verify conversation response and unchanged preference assertions.
  - Evidence: server/project-router-chat.ts, server/project-router.test.ts (asserts milestone provider/model/context effort, ordinary chat defaults, temporary override and invalid effort rejection).
- [x] 1.3 Forward captured milestone effort into native generation turns; verify invocation arguments.
  - Evidence: server/modules/conversations/runtime/chat-manager.ts, server/modules/conversations/runtime/chat-manager.test.ts (asserts Claude --effort high and Codex model_reasoning_effort="high", alongside existing read-only contracts).
- [x] 1.4 Declare the settings module boundary and document project settings ownership; verify the manifest and module guide entries by inspection.
  - Evidence: server/modules/boundaries.json, server/modules/builder/README.md (no dedicated new test evidence; existing server/modules/architecture.test.ts is the applicable automated boundary check).

## 2. Blueprint generation controls

- [x] 2.1 Add usual configuration selectors and explicit saving; verify reopening restores saved values and unsaved/failed saves block generation.
  - Evidence: client/src/features/builder/components/project-builder/MilestoneGenerationControls.tsx, client/src/components/__tests__/MilestoneGenerationControls.test.tsx (asserts save/reopen, disabled unsaved changes, failed save, unavailable provider and obsolete effort reset).
- [x] 2.2 Add milestone-only exceptions and provider/model effort resets; verify no preference write occurs for an exception.
  - Evidence: client/src/features/builder/components/project-builder/MilestoneGenerationControls.tsx, client/src/components/__tests__/MilestoneGenerationControls.test.tsx (asserts temporary selection, no PUT, provider default model and effort reset on model changes).
- [x] 2.3 Integrate generation controls into the flyout and capture the project/milestone selection; verify stale-project responses cannot replace current controls.
  - Evidence: client/src/features/builder/components/project-builder/BuilderSidebarEntry.tsx, client/src/components/__tests__/MilestoneGenerationControls.test.tsx (asserts late previous-project response is discarded); no dedicated new assertion covers portaled-listbox dismissal or sidebar project-switch closure.
- [x] 2.4 Send selected generation configuration at conversation creation and handle HTTP failure before seeding; verify the request and rejected-creation behavior.
  - Evidence: client/src/features/builder/components/project-builder/MilestoneGenerateShell.tsx, client/src/components/__tests__/MilestoneGenerateShell.test.tsx (asserts provider/model/effort body before seed and no seed after rejected creation); no new dedicated assertion covers follow-up HTTP failure handling.
- [x] 2.5 Add localized configuration labels and document the controls; verify matching added locale entries by diff inspection.
  - Evidence: client/src/locales/de/builder.json, client/src/locales/en/builder.json, client/src/locales/es/builder.json, client/src/locales/fr/builder.json, client/src/locales/it/builder.json, client/src/locales/ja/builder.json, client/src/locales/pt/builder.json, client/src/locales/zh/builder.json, client/src/features/builder/README.md (no dedicated locale-parity test evidence in the changed tests).

## 3. Independent M1 execution selection

- [x] 3.1 Allow explicit-project API bases without mutating the active project; verify calls before and after active-project selection.
  - Evidence: client/src/lib/api.ts, client/src/lib/__tests__/api.test.ts (asserts new-project routing and unchanged active context).
- [x] 3.2 Add M1 execution selectors with catalog loading and retry; verify target-project fetch, selection emission and failure blocking.
  - Evidence: client/src/features/builder/components/project-builder/MilestoneLaunchControls.tsx, client/src/components/__tests__/MilestoneGenerationControls.test.tsx (asserts new-project catalog URL, selected provider/model/effort, unchanged generation preference and failed-load retry).
- [x] 3.3 Wire execution selection into the done screen, sidebar and launch request; verify both surfaces and serialized engine/checkpoint options.
  - Evidence: client/src/features/builder/components/project-builder/BuilderConversation.tsx, client/src/features/builder/components/project-builder/BuilderSidebarEntry.tsx, client/src/features/builder/hooks/useBuilderSession.ts, client/src/features/builder/lib/milestone-launch.ts, client/src/components/__tests__/ProjectBuilder.test.tsx, client/src/components/__tests__/BuilderSidebarEntry.test.tsx, client/src/features/builder/lib/__tests__/milestone-launch.test.ts (asserts selected engine reaches callbacks and launch request with autoAdvance).
- [x] 3.4 Expose independent launch settings and validate optional engine input before chain start; verify default separation and rejected launch inputs.
  - Evidence: server/modules/builder/runtime/milestone-generation-settings.ts, server/project-router.ts, server/project-router.test.ts, server/blueprint-progress-route.test.ts (asserts execution primary remains Claude after Codex generation save, forwards valid engine and never starts on invalid provider/model/effort).
- [x] 3.5 Persist chain engine through additive migration 92 and reuse it on retries and later rails; verify legacy NULL and replacement-manager behavior.
  - Evidence: server/db/migrations.ts, server/modules/builder/runtime/milestone-chain-store.ts, server/modules/builder/runtime/milestone-chain.ts, server/modules/builder/runtime/milestone-chain-store.test.ts, server/modules/builder/runtime/milestone-chain.test.ts (asserts stored JSON/legacy NULL and original engine after failure, manager replacement, caller mutation, retry and next rail).
- [x] 3.6 Reject conflicting loop-owned configuration for strict engine launches; verify no spawn on conflict and compatible runtime override.
  - Evidence: server/modules/delivery/runtime/rails-router.ts, server/modules/delivery/runtime/rails-router.test.ts (asserts 409 loop_engine_conflict with no run and matching Codex/model/effort runtime override on compatible launch).
- [x] 3.7 Keep the Builder visible when a created mission requests opening; verify refreshed list without mission selection.
  - Evidence: client/src/features/missions/context/AgentChatContext.tsx, client/src/features/missions/context/AgentChatContext.test.tsx (asserts placeholder appears, Builder stays active and mission detail is not loaded; test harness now dispatches all registered WS handlers).

## 4. Runtime fixes and reference updates

- [x] 4.1 Copy missing local OpenSpec config into isolated worktrees while preserving checkout and cleanup ownership; verify fallback copying, no shared changes and symlink preservation.
  - Evidence: server/worktree-overlay.ts, server/worktree-overlay.test.ts (asserts config-only fallback copy, recorded created/cleanup evidence, repeat overlay ownership, edited-copy deauthorization, alternate spelling preservation and no symlink write-through).
- [x] 4.2 Normalize Engine 2 node paths/structured errors in read-only diagnosis; verify repeated failures are recognized without execution or recovery writes.
  - Evidence: server/modules/agent-runtime/runtime/agent-runtime-controls.ts, server/modules/agent-runtime/runtime/agent-runtime-controls.test.ts (asserts architect step id, joined code/message, repeat count 2, repair_before_retry and no execute/recovery records).
- [x] 4.3 Document execution persistence, isolated configuration and diagnosis behavior and index new production sources; verify the guide and source-map diff entries.
  - Evidence: docs/internals/project-builder.md, docs/internals/source-map.md, server/modules/agent-runtime/README.md, server/modules/builder/README.md, client/src/features/builder/README.md (no dedicated documentation test evidence; source map adds the two controls and settings runtime).

## Proposed automated verification

These existing commands are proposals for Core; none were executed by this role.

- `npm run typecheck`
- `npx vitest run server/project-router.test.ts server/blueprint-progress-route.test.ts server/modules/builder server/modules/conversations/runtime/chat-manager.test.ts server/modules/delivery/runtime/rails-router.test.ts server/modules/agent-runtime/runtime/agent-runtime-controls.test.ts server/worktree-overlay.test.ts server/modules/architecture.test.ts`
- `npm run test --prefix client -- src/components/__tests__/BuilderSidebarEntry.test.tsx src/components/__tests__/MilestoneGenerateShell.test.tsx src/components/__tests__/MilestoneGenerationControls.test.tsx src/components/__tests__/ProjectBuilder.test.tsx src/features/builder/lib/__tests__/milestone-launch.test.ts src/features/missions/context/AgentChatContext.test.tsx src/lib/__tests__/api.test.ts`
- `npm run audit:architecture`
