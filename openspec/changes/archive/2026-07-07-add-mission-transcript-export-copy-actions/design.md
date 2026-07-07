# Design - add-mission-transcript-export-copy-actions

## Context
Agent Mode already renders the active mission title bar in `client/src/components/agent-chat/AgentConversationHeader.tsx`, including rename, favorite, delete, and metadata-copy actions in a hand-rolled overflow menu. The component has access to `active` from `useAgentChat()` and pinned project data from `useDesktop()`, and the ticket requires adding transcript actions without changing server persistence, Board-mode mission selection, or existing menu behavior.

Scope: frontend

## Goal
Add observable copy-all and `.txt` export actions for the currently loaded active mission transcript from the Agent Mode title overflow menu.

## Non-Goals
- Do not add server routes, database records, or persistent exported-file management.
- Do not add export formats beyond plain text.
- Do not add controls to `AgentMissionSelector` or other Board-mode menus.
- Do not render attachments or binary content beyond text already present on messages.
- Do not reorder or change the semantics of rename, favorite, delete, or existing metadata-copy actions.

## Design

### Architecture
Keep the feature local to `AgentConversationHeader.tsx`. Extend the `useAgentChat()` destructure to include `messages`, add a pure exported formatter helper near the component, then add two menu buttons that call small handlers for clipboard copy and object-URL download.

Data flow:

```text
useAgentChat() active + messages
useDesktop() projects -> pinned project lookup
          |
          v
formatMissionTranscript(active, messages, project, exportedAt?)
          |
          +--> navigator.clipboard.writeText(...)
          +--> Blob(["..."], { type: "text/plain;charset=utf-8" }) + anchor.download
```

The formatter should be deterministic for tests by accepting an optional timestamp or options object while defaulting to `new Date().toISOString()` in production handlers. It should preserve the message order as supplied by `messages`; the acceptance criteria define this as chronological order because the current hook's loaded message array is already the active conversation stream.

### Data shapes

```ts
type TranscriptProject = {
  name?: string | null
  path?: string | null
}
```

```ts
type TranscriptOptions = {
  exportedAt?: string
}
```

```ts
type AgentMessage = {
  id: string
  conversation_id: string
  role: string
  content: string
  attachment_ids?: string[]
  context_refs?: unknown
  created_at: string
}
```

The implementation should use the existing conversation and project shapes rather than introducing app-wide exported types unless TypeScript requires a local structural type.

### State & lifecycle
The feature adds no durable state. `handleCopyTranscript()` and `handleExportTranscript()` should close the menu before attempting their action, surface localized failures through `toast.error`, and leave `active`, `messages`, and the current mission selection unchanged. Copy success should follow the existing `copied` state pattern with a new key such as `transcript`; export success may show a localized toast so users know the browser download was triggered.

### Public API / surface

```ts
export function formatMissionTranscript(
  active: AgentConversationLike,
  messages: AgentMessage[],
  project?: TranscriptProject | null,
  options?: TranscriptOptions,
): string
```

The helper is exported from `AgentConversationHeader.tsx` for focused unit coverage. It returns plain text only and never JSX.

```ts
function handleCopyTranscript(): Promise<void>
function handleExportTranscript(): void
```

These remain component-local handlers. Add menu controls with stable test ids, for example `agent-conv-copy-transcript` and `agent-conv-export-transcript`.

```ts
function safeTranscriptFilename(title: string | null | undefined, id: string): string
```

This may be component-local or a small exported helper if the tests need direct coverage. It should derive a lower-case safe slug from the mission title and fall back to the mission id when the title is empty or slugifies to nothing.

## Trade-offs

| Option | Pros | Cons | Chosen? |
|---|---|---|---|
| Keep formatter and handlers in `AgentConversationHeader.tsx` | Minimal blast radius, matches the ticket contract, easy colocated tests | Header file grows slightly | Yes |
| Move transcript logic to a new shared lib file | Cleaner separation if other export surfaces appear later | Premature public surface and more files for a single menu feature | No |
| Use browser download via Blob/object URL | No backend work, matches existing app export pattern | Browser download behavior must be mocked in tests | Yes |
| Add server-side transcript endpoint | Centralized export could include unloaded messages later | Outside scope and adds backend/API risk | No |

The chosen approach keeps the change client-only and local while leaving the formatter pure enough to test thoroughly.

## Risks
- Clipboard or URL APIs may be absent in the test or runtime environment; mitigate by catching failures, showing localized errors, and mocking these APIs in tests.
- Locale files may drift if new keys differ by language; mitigate by adding identical key names under `header` in all eight `agent.json` files.
- Menu behavior could regress if new actions disturb rename/favorite/delete ordering; mitigate by appending transcript actions near the existing copy section and extending the current header tests.
- Filenames can become unsafe or empty for non-Latin titles; mitigate with conservative slug sanitization and mission-id fallback.

## Open questions
