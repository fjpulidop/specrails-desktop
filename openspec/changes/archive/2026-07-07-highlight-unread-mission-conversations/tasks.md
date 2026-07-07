# Implementation Tasks

> The developer agent runs these in order. Each "## N." block is
> a single TDD cycle: write the failing test, run it to confirm
> it fails, write production code, run again to confirm it
> passes. Do NOT skip the failing-test step.

## 1. Expose unread conversation state from the agent chat context
- [x] 1.1 Write a failing test in `client/src/context/AgentChatContext.test.tsx` or the nearest existing context test file that asserts `useAgentChat()` exposes `unreadConversationIds` and marks an inactive conversation unread when assistant output arrives. Run `npm --prefix client test -- AgentChatContext`; the new test MUST fail.
- [x] 1.2 Implement `unreadConversationIds`, `markUnread(conversationId)`, and `clearUnread(conversationId)` in `client/src/context/AgentChatContext.tsx`, and update `NOOP_AGENT_CHAT`. Run `npm --prefix client test -- AgentChatContext`; ALL tests MUST pass.
- [x] 1.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- AgentChatContext`; all tests still pass.

## 2. Mark hidden-document active output unread and clear on visibility return
- [x] 2.1 Write a failing test in `client/src/context/AgentChatContext.test.tsx` or the nearest existing context test file that sets `document.visibilityState` to `hidden`, sends assistant output for the active conversation, and expects it to be unread until a `visibilitychange` to `visible`. Run `npm --prefix client test -- AgentChatContext`; the new test MUST fail.
- [x] 2.2 Implement the `visibilitychange` listener in `client/src/context/AgentChatContext.tsx` and ensure output events use hidden-document state when deciding unread. Run `npm --prefix client test -- AgentChatContext`; ALL tests MUST pass.
- [x] 2.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- AgentChatContext`; all tests still pass.

## 3. Clear unread only after selecting conversation loads successfully
- [x] 3.1 Write a failing test in `client/src/context/AgentChatContext.test.tsx` or the nearest existing context test file that marks a conversation unread, calls `selectConversation(id)`, and expects unread to clear only after `getAgentConversation(id)` resolves. Run `npm --prefix client test -- AgentChatContext`; the new test MUST fail.
- [x] 3.2 Update `loadConversation(id)` in `client/src/context/AgentChatContext.tsx` to call `clearUnread(id)` after the API request succeeds and state is hydrated. Run `npm --prefix client test -- AgentChatContext`; ALL tests MUST pass.
- [x] 3.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- AgentChatContext`; all tests still pass.

## 4. Render unread sidebar icon state without breaking streaming shimmer
- [x] 4.1 Extend `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` with failing tests that mock `unreadConversationIds`, assert an unread background row gets `text-destructive` and the unread glow class, and assert streaming title shimmer still renders for the same row. Run `npm --prefix client test -- ArcSidebarAgentConversations`; the new tests MUST fail.
- [x] 4.2 Update `client/src/components/ArcSidebar.tsx` to pass `unread` into every `ConversationRow` path and to make unread icon styling take precedence over active/streaming icon styling. Run `npm --prefix client test -- ArcSidebarAgentConversations`; ALL tests MUST pass.
- [x] 4.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- ArcSidebarAgentConversations`; all tests still pass.

## 5. Add reduced-motion-safe unread breathing animation
- [x] 5.1 Write or extend a focused test/assertion in `client/src/components/__tests__/ArcSidebarAgentConversations.test.tsx` that verifies unread rows use the named unread animation class rather than `animate-pulse`. Run `npm --prefix client test -- ArcSidebarAgentConversations`; the new assertion MUST fail.
- [x] 5.2 Add the unread breathing keyframes/class in `client/src/globals.css`, with animation enabled only under `prefers-reduced-motion: no-preference` and static alert color under reduced motion. Run `npm --prefix client test -- ArcSidebarAgentConversations`; ALL tests MUST pass.
- [x] 5.3 Refactor if needed without changing behavior. Run `npm --prefix client test -- ArcSidebarAgentConversations`; all tests still pass.

## 6. Validation gate
- [x] 6.1 Run the full client test suite (`npm --prefix client test`); all pass.
- [x] 6.2 Run the client build (`npm --prefix client run build`); succeeds.
- [x] 6.3 No `console.log`, debug prints, or commented-out code in the diff.
