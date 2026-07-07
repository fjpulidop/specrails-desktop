# Design - highlight-unread-mission-conversations

## Context
The React client already centralizes app-global `agent_*` WebSocket handling in `client/src/context/AgentChatContext.tsx`, including `activeIdRef`, per-conversation `liveByConv`, and the derived `streamingConversationIds` set used by `ArcSidebar`. `ArcSidebar` already renders conversation rows in favorites, Home, and project trees, and `ConversationRow` owns the `MessageSquare` icon plus the streaming title shimmer. The change should stay client-side and use `document.visibilityState` as the only background signal; unread state is intentionally ephemeral.

Scope: frontend

## Goal
Show a persistent unread alert on mission conversation icons when assistant or system output arrives while that conversation is not visible to the user, and clear it once the conversation is visible again.

## Non-Goals
- Do not persist unread state to the server or local storage.
- Do not add notification counts, toasts, sounds, operating-system notifications, or a notification center.
- Do not change project folder icons or non-mission sidebar entries.
- Do not remove or weaken the existing streaming title shimmer.
- Do not mark user queue events as unread; unread only tracks assistant/system output.

## Design

### Architecture
Add `unreadConversationIds` state inside `AgentChatProvider`, using the same immutable `ReadonlySet<string>` shape as favorites and streaming IDs. The WebSocket handler should call a local `markUnread` helper for agent events that represent assistant/system output when either `convId !== activeIdRef.current` or `document.visibilityState === 'hidden'`. The visible active conversation remains read.

`ArcSidebar` should read `agentChat.unreadConversationIds` and pass a boolean `unread` prop into every `ConversationRow` render path: favorites, Home, and project-pinned conversations through `ProjectItem`. `ConversationRow` should give unread icon styling precedence over active/streaming icon color, while leaving the title shimmer controlled by `streaming`.

### Data shapes
```ts
interface AgentChatContextValue {
  // existing fields unchanged
  unreadConversationIds: ReadonlySet<string>
}
```

```ts
type ConversationRowProps = {
  // existing props unchanged
  streaming?: boolean
  unread?: boolean
}
```

```ts
type ProjectItemProps = {
  // existing props unchanged
  streamingConversationIds?: ReadonlySet<string>
  unreadConversationIds?: ReadonlySet<string>
}
```

### State & lifecycle
```text
READ
  -> agent_stream / agent_done / agent_error / agent_pr_decision for conversation
     AND (conversation is not active OR document.visibilityState === 'hidden')
  -> UNREAD

UNREAD
  -> loadConversation(id) succeeds
  -> READ for that id

UNREAD
  -> visibilitychange to visible AND activeIdRef.current is set
  -> READ for the active id only
```

Use two helpers in `AgentChatProvider`:

```ts
function markUnread(conversationId: string): void
function clearUnread(conversationId: string): void
```

`markUnread` should be a no-op if the conversation is already active while `document.visibilityState !== 'hidden'`. `clearUnread` should remove only the specified id.

### Public API / surface
`useAgentChat()` exposes one additional context field:

```ts
unreadConversationIds: ReadonlySet<string>
```

`ConversationRow` accepts:

```ts
unread?: boolean
```

No backend API, WebSocket payload, CLI flag, or persisted schema changes are introduced.

### Styling
Add a global class near `title-shimmer`, for example:

```css
.conversation-unread-glow { ... }
```

The class should animate only inside `@media (prefers-reduced-motion: no-preference)` and should leave reduced-motion users with static `text-destructive` color and no glow animation. The icon class order should make unread visually win over `active` and `streaming`, e.g. apply `text-destructive conversation-unread-glow` when unread, otherwise keep current active/streaming `text-accent-primary` behavior.

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Store unread IDs in `AgentChatContext` | Uses the existing app-global WebSocket owner, makes sidebar wiring simple, and keeps state ephemeral | Adds one more context field and set update path | Yes |
| Derive unread entirely in `ArcSidebar` | Keeps context smaller | Sidebar does not receive WebSocket events and cannot observe hidden-document arrival semantics reliably | No |
| Persist unread server-side | Survives restart and multi-window sessions | Explicitly out of scope and requires backend/storage semantics | No |

Context-owned ephemeral unread state is the smallest design that can correctly observe both background conversations and hidden-document active conversations.

## Risks
- Marking too many event types unread could alert on user queue bookkeeping; limit unread marking to assistant/system output events such as `agent_stream`, `agent_done`, `agent_error`, and `agent_pr_decision`.
- `document.visibilityState` may be hard to set in tests; use `Object.defineProperty(document, 'visibilityState', ...)` with `configurable: true` and dispatch `visibilitychange`.
- Clearing on select before the server load succeeds could hide unread even when the conversation fails to load; clear only after `getAgentConversation(id)` resolves.
- Icon class precedence can be lost if `cn` order is wrong; tests should assert the icon receives the unread class/color while streaming shimmer remains present.

## Open questions
- None.
