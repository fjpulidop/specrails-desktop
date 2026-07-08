# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is a single TDD cycle: write the failing test, run it to confirm it fails, write production code, run again to confirm it passes. Do NOT skip the failing-test step.

## 1. Server registry exposes background process lifecycle
- [x] 1.1 Write a failing test in `server/transient-children.test.ts` that starts a fake/background child, records pid/command/cwd/startedAt/status/chatId/projectId, emits started/output/exited hooks, and removes the process on close.
- [x] 1.2 Implement `BackgroundProcessStatus`, `BackgroundProcess`, `startBackgroundProcess`, and registry lookup/update code in `server/transient-children.ts`. Run `npx vitest run server/transient-children.test.ts`; ALL tests MUST pass.
- [x] 1.3 Refactor if needed without changing behaviour. Run `npx vitest run server/transient-children.test.ts`; all tests still pass.

## 2. Server kill and cleanup prevent orphaned process trees
- [x] 2.1 Write a failing test in `server/transient-children.test.ts` that `killBackgroundProcess(pid)` only kills a registered process, escalates SIGTERM to SIGKILL through the tree-kill-safe pattern when needed, and `killTransientChildren(projectId)` kills background processes for that project.
- [x] 2.2 Implement immediate kill and shutdown/project cleanup integration in `server/transient-children.ts`, reusing `treeKillSafe` or the existing SIGTERM-to-SIGKILL pattern from `server/queue-manager.ts`. Run `npx vitest run server/transient-children.test.ts`; ALL tests MUST pass.
- [x] 2.3 Refactor if needed without changing behaviour. Run `npx vitest run server/transient-children.test.ts`; all tests still pass.

## 3. MCP/project surface starts and kills confirmed background shell commands
- [x] 3.1 Write failing tests in `server/mcp/mcp-units.test.ts` or the nearest project-router test that assert background start requires command + chatId, validates cwd within the project, returns process metadata, classifies the action as `operate`, and background kill requires a registered pid in the same project/chat.
- [x] 3.2 Implement the MCP action and any project-router endpoint it needs, using broadcast hooks to emit `background_process.started`, `background_process.output`, and `background_process.exited`. Run the targeted server tests; ALL tests MUST pass.
- [x] 3.3 Refactor if needed without changing behaviour. Run the targeted server tests again; all tests still pass.

## 4. Websocket and frontend context maintain chat-scoped background state
- [x] 4.1 Write failing client tests for `BackgroundProcessesContext` that feed websocket messages for two chats/projects and assert only the active chat/project's processes are exposed in append order and terminal events update/remove the matching process.
- [x] 4.2 Implement `client/src/context/BackgroundProcessesContext.tsx`, add `BackgroundProcess`/WS types as needed, and wire the provider into the agent chat surface where the active project and conversation id are known. Run `cd client && npx vitest run <new-context-test>`; ALL tests MUST pass.
- [x] 4.3 Refactor if needed without changing behaviour. Run the context test again; all tests still pass.

## 5. Composer renders animated background process chips
- [x] 5.1 Write failing tests in `client/src/components/agent-chat/__tests__/agent-background-process-chips.test.tsx` that assert chips appear above the composer input in append order, rotate accent variants, show the close control and elapsed-time tooltip on hover, and call kill without a confirmation dialog.
- [x] 5.2 Implement `client/src/components/BackgroundProcessChip.tsx` and integrate it into `client/src/components/agent-chat/AgentComposer.tsx` near the existing attachment chip row, reusing `AttachmentChip` animation style, `Tooltip`, lucide `X`, and elapsed-duration interval logic. Run the targeted client tests; ALL tests MUST pass.
- [x] 5.3 Refactor if needed without changing behaviour. Run the targeted client tests again; all tests still pass.

## 6. Agent confirmation contract and validation gate
- [x] 6.1 Write or update the closest agent-tool test to assert the in-app agent does not invoke background start until the user has explicitly confirmed the proposed command.
- [x] 6.2 Implement the prompt/tool gating path so the agent proposes background execution first and only calls the MCP action after confirmation. Run the targeted tests; ALL tests MUST pass.
- [x] 6.3 Run the full project test suite (`npm test`); all pass.
- [x] 6.4 Run the project build (`npm run build`); succeeds.
- [x] 6.5 No `console.log`, debug prints, or commented-out code in the diff.
