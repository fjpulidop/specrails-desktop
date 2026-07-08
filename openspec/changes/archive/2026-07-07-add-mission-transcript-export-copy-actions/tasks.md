# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is
> a single TDD cycle: write the failing test, run it to confirm
> it fails, write production code, run again to confirm it
> passes. Do NOT skip the failing-test step.

## 1. Transcript formatter
- [x] 1.1 Write a failing test in `client/src/components/agent-chat/__tests__/agent-conversation-header.test.tsx` that imports `formatMissionTranscript` and asserts the transcript includes mission title, mission id, project name/path, export timestamp, role labels, message timestamps, and multiline content in loaded order. Run `cd client && npx vitest run src/components/agent-chat/__tests__/agent-conversation-header.test.tsx`; the new test MUST fail.
- [x] 1.2 Implement the minimum production code in `client/src/components/agent-chat/AgentConversationHeader.tsx` to export a pure `formatMissionTranscript` helper and read `messages` from `useAgentChat()`. Run the same test command; ALL tests MUST pass.
- [x] 1.3 Refactor if needed without changing behavior. Run the same test command; all tests still pass.

## 2. Copy transcript menu action
- [x] 2.1 Write a failing test in `client/src/components/agent-chat/__tests__/agent-conversation-header.test.tsx` that opens the mission menu, activates the copy-transcript action, and asserts `navigator.clipboard.writeText` receives the full transcript and localized failure handling is used on rejection. Run `cd client && npx vitest run src/components/agent-chat/__tests__/agent-conversation-header.test.tsx`; the new test MUST fail.
- [x] 2.2 Implement `handleCopyTranscript()` and a `agent-conv-copy-transcript` menu item in `client/src/components/agent-chat/AgentConversationHeader.tsx`, reusing the existing copied/check/toast pattern without changing existing copy-name/id/project/path behavior. Run the same test command; ALL tests MUST pass.
- [x] 2.3 Refactor if needed without changing behavior. Run the same test command; all tests still pass.

## 3. Export transcript menu action
- [x] 3.1 Write a failing test in `client/src/components/agent-chat/__tests__/agent-conversation-header.test.tsx` that opens the mission menu, activates the export action, and asserts a `text/plain;charset=utf-8` Blob/object URL download is triggered with a safe `.txt` filename derived from the mission title, plus mission-id fallback coverage. Run `cd client && npx vitest run src/components/agent-chat/__tests__/agent-conversation-header.test.tsx`; the new test MUST fail.
- [x] 3.2 Implement `handleExportTranscript()`, filename sanitization, and a `agent-conv-export-transcript` menu item in `client/src/components/agent-chat/AgentConversationHeader.tsx` using the same anchor/object-URL pattern as `client/src/components/ExportDropdown.tsx`. Run the same test command; ALL tests MUST pass.
- [x] 3.3 Refactor if needed without changing behavior. Run the same test command; all tests still pass.

## 4. Localized strings
- [x] 4.1 Write or extend a failing test/check that verifies the new `header` keys exist in `client/src/locales/en/agent.json`, `client/src/locales/es/agent.json`, `client/src/locales/fr/agent.json`, `client/src/locales/de/agent.json`, `client/src/locales/pt/agent.json`, `client/src/locales/it/agent.json`, `client/src/locales/zh/agent.json`, and `client/src/locales/ja/agent.json`. Run the relevant test command; the new check MUST fail before adding keys.
- [x] 4.2 Add identical key names for copy/export transcript labels and success/failure messages under `header` in all eight locale files. Run the relevant test command; ALL tests MUST pass.
- [x] 4.3 Refactor if needed without changing behavior. Run the same test command; all tests still pass.

## 5. Validation gate
- [x] 5.1 Run the focused client test (`cd client && npx vitest run src/components/agent-chat/__tests__/agent-conversation-header.test.tsx`); all pass.
- [x] 5.2 Run the full client test suite (`npm run test:client`); all pass.
- [x] 5.3 Run the project build (`npm run build`); succeeds.
- [x] 5.4 No `console.log`, debug prints, or commented-out code in the diff.
