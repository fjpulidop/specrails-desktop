# Tasks

Completed work derived from the frozen diff. Evidence names source files and assertions present in tests; this checklist does not claim those tests were run by the deriver.

## 1. Independent snapshot persistence and attachments

- [x] 1.1 Append migration 39 for provenance and inherited delivery fields; verify migration and legacy-upgrade expectations include 39.
  - Evidence: server/desktop-db.ts, server/desktop-db.test.ts (asserts migrations 1 through 39 are recorded), server/modules/missions/runtime/agent-input-store.test.ts (asserts legacy input upgrades preserve rows and reach version 39).
- [x] 1.2 Add fork provenance mapping and copy historical message records without execution ownership; verify snapshot fields and replay isolation.
  - Evidence: server/modules/agents/runtime/agent-store.ts, server/modules/missions/runtime/agent-chat-branch.test.ts (asserts fresh message IDs, preserved content/references/intents/status, null provider session, absent Core turn ID and no copied input rows).
- [x] 1.3 Copy only referenced attachments to a fresh conversation with validation and cleanup; verify independent files survive source deletion and failed copies leave no partial attachments.
  - Evidence: server/attachment-manager.ts, server/attachment-manager.test.ts (copyAgentAttachments cases assert deduplication, survival, missing-file refusal, disk-failure cleanup, occupied destination and unsafe-path rejection).
- [x] 1.4 Document snapshot persistence and attachment-copy ownership; verify the delivered module descriptions match the source contract.
  - Evidence: server/modules/agents/README.md, server/modules/missions/README.md; no direct automated documentation test evidence in the diff.

## 2. Branch API and first provider turn

- [x] 2.1 Add empty/fork branch creation with source-owned inclusive boundaries and source settings; verify creation never submits input.
  - Evidence: server/modules/missions/runtime/agent-chat-router.ts, server/modules/missions/runtime/agent-chat-branch.test.ts (asserts inclusive history, settings, provenance, empty mode and no manager.sendMessage calls).
- [x] 2.2 Roll back failed snapshots and reject invalid requests; verify no source mutation or creation announcement occurs on failure.
  - Evidence: server/modules/missions/runtime/agent-chat-router.ts, server/modules/missions/runtime/agent-chat-branch.test.ts (asserts 400/404 invalid requests, 409 missing-file/database failures, retained source rows/files and no creation notification).
- [x] 2.3 Seed eligible copied attachments only while starting a fork's own session; verify inherited files do not attach to the new user message or get re-resolved on resume.
  - Evidence: server/modules/missions/runtime/agent-chat-manager.ts, server/modules/missions/runtime/agent-chat-manager.test.ts (seeds copied fork attachments into a fresh session without reattaching them to the new user message; asserts skipped interrupted history and later resume without extraction).
- [x] 2.4 Document the branch endpoint and runtime snapshot lifecycle; verify the API reference includes payload, success and failure responses.
  - Evidence: docs/internals/api-reference.md, server/modules/missions/README.md; no direct automated documentation test evidence in the diff.

## 3. Selection capture and source-bound sending

- [x] 3.1 Add committed-message range capture and context menu keyboard/pointer operation; verify multi-message boundaries and invalid ranges.
  - Evidence: client/src/features/missions/components/MissionSelectionMenu.tsx, client/src/features/missions/components/AgentConversationView.tsx, client/src/features/missions/components/__tests__/MissionSelectionMenu.test.tsx (asserts final selected message, next-message zero-offset exclusion, cross-pane/live-tail rejection, Shift+F10 navigation and Escape focus restoration).
- [x] 3.2 Bind Add to mission to the captured send closure with a stable admission ID and concurrent-action guard; verify draft preservation and retry identity.
  - Evidence: client/src/features/missions/components/MissionSelectionMenu.tsx, client/src/features/missions/components/__tests__/MissionSelectionMenu.test.tsx (asserts captured-source send exactly once after active mission changes, preserved draft, equal retry calls and disabled archived sending).

## 4. Separate-mission preparation and inherited presentation

- [x] 4.1 Add branch API client types and compatible From scratch creation; verify source settings, encoded source IDs, missing boundaries and no empty fallback for forks.
  - Evidence: client/src/features/missions/lib/agent-api.ts, client/src/features/missions/lib/__tests__/agent-api.test.ts (asserts existing GET/POST flow, preserved settings, missing-boundary rejection and one fork request with endpointUnavailable failure).
- [x] 4.2 Store selection-only drafts and request an additional focused split pane after successful creation; verify no automatic send and no pane/draft on failure.
  - Evidence: client/src/features/missions/components/MissionSelectionMenu.tsx, client/src/features/missions/context/MissionSplitViewsContext.tsx, client/src/features/missions/context/AgentChatContext.tsx, client/src/features/missions/components/AgentConversationView.tsx, client/src/features/missions/components/__tests__/MissionSelectionMenu.test.tsx (asserts both modes write selected text, retain the source draft, call open with focusComposer and never send; failure retains menu and creates no pane), client/src/features/missions/components/__tests__/MissionSplitLayout.test.tsx (asserts for empty and fork modes that a third pane is appended with the selected text in a focused editor, branchAgentConversation is called once with the source ID, message ID and mode, and the existing panes, their drafts and the source log scrollTop of 137 are unchanged).
- [x] 4.3 Show fork origin and prevent inherited cards/options from activating work; verify disabled cards and absent shortcut sends.
  - Evidence: client/src/features/missions/components/AgentConversationView.tsx, client/src/features/missions/components/__tests__/streaming-store-regressions.test.tsx (keeps inherited cards read-only and refuses their option shortcuts in an idle fork). Origin text and inherited run-strip filtering have code evidence but no direct added assertion.
- [x] 4.4 Add localized selection labels and feedback in all eight supported agent locale files; verify the selection menu uses the English action labels in component tests.
  - Evidence: client/src/locales/de/agent.json, client/src/locales/en/agent.json, client/src/locales/es/agent.json, client/src/locales/fr/agent.json, client/src/locales/it/agent.json, client/src/locales/ja/agent.json, client/src/locales/pt/agent.json, client/src/locales/zh/agent.json; client/src/features/missions/components/__tests__/MissionSelectionMenu.test.tsx asserts English menu labels. No direct added translation-quality test evidence for other locales.
- [x] 4.5 Document selection reuse and index the new component; verify the delivered guides describe unsent preparation, context boundaries and inherited read-only records.
  - Evidence: client/src/features/missions/README.md, docs/guide/en/integrations/6-agent-chat.md, docs/guide/es/integrations/6-agent-chat.md, docs/internals/source-map.md; no direct automated documentation test evidence in the diff.
