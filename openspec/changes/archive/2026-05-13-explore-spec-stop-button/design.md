## Context

`ExploreSpecShell` (`client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx`) is the full-screen overlay used by Explore Spec turns. Its composer (`RichAttachmentEditor` + a Send button) submits on click or `⌘⏎`. While a turn is streaming (`conversation.isStreaming === true`), the textarea is hidden behind a placeholder, the Send button is disabled, and the user has no way to interrupt the model — they must wait for `result`.

The sidebar chat solved the same problem in `client/src/features/chat/components/ChatInput.tsx`: while `isStreaming`, it swaps the Send button for a red `Stop` button that calls `useChat.abortStream(conversationId)`, which `DELETE`s `/chat/conversations/:id/messages/stream`. On the server, that route calls `chatManager.abort(conversationId)` which `treeKill`s the spawned `claude` child (SIGTERM). The next turn resumes the conversation via `--resume <session_id>`, so context is preserved.

All the infrastructure already exists; only an Explore-shell affordance is missing.

## Goals / Non-Goals

**Goals:**
- Add a visible, mouse-reachable Stop button in the Explore Spec composer while streaming.
- Honour `⌘⏎` / `Ctrl+⏎` as a Stop shortcut while streaming (mirrors the send shortcut when idle).
- Reuse the existing server abort endpoint and `useChat.abortStream` client method — no new server code.
- Match the visual treatment used by the sidebar chat (red, secondary visual weight) so the affordance feels native.

**Non-Goals:**
- Stop on AI Edit (`AiEditShell`). Out of scope; will be tracked separately if needed.
- Stop on Quick spec generation (`POST /tickets/generate-spec`). Requires server-side child-process tracking that does not exist today.
- Stop on the sidebar chat. Already shipped.
- Changes to `ChatManager.abort()` or the `DELETE …/stream` route.
- Preserving / discarding the partial assistant turn. Existing behaviour (partial bubble remains on screen as the conversation's tail until the next user turn) is unchanged.

## Decisions

### D1 — Reuse `useChat.abortStream`, do not add a new hook method

`useChat.abortStream(conversationId)` already exists, is covered by tests, and is the exact method `ChatInput` uses. The shell already pulls `chat` from `useChat()`, so we add `chat.abortStream` to the consumed surface — no new exports.

_Alternative considered:_ adding a dedicated `explore-abort` endpoint. Rejected — the server's chat-cancel path is the same code path Explore turns already run through (Explore is just `kind === 'explore'` on `chat_conversations`).

### D2 — Swap Send → Stop while `isStreaming`, do not show both

Two buttons would clutter the composer and require deciding which one `⌘⏎` triggers. Swapping is the pattern users already see in the sidebar; consistency wins.

State machine (composer button):

```
                 isStreaming=false                isStreaming=true
                ┌────────────────┐               ┌────────────────┐
   text empty   │ Send (disabled)│               │      Stop      │ (always enabled)
   text non-∅   │ Send  (enabled)│               │      Stop      │
                └────────────────┘               └────────────────┘
                          │  click / ⌘⏎                    │  click / ⌘⏎
                          ▼                                ▼
                  sendComposer()                  chat.abortStream(id)
```

The Stop button is enabled even when the composer is empty — interrupting must not require the user to type something first.

### D3 — Route `⌘⏎` through the existing `onSubmit` callback

`RichAttachmentEditor` already calls `props.onSubmit?.()` when the user presses `Enter` with `metaKey || ctrlKey`. We change `submitComposer` (the function passed as `onSubmit`) to branch on `conversation?.isStreaming`:

```ts
const submitComposer = useCallback(() => {
  if (conversation?.isStreaming) {
    if (conversation) void chat.abortStream(conversation.id)
    return
  }
  const text = composerRef.current?.getPlainText().trim() ?? ''
  if (text) void sendComposer(text)
}, [conversation, chat, sendComposer])
```

This keeps the keybind contract inside `RichAttachmentEditor` unchanged (still "Cmd+Enter triggers the host's onSubmit"); only the host's interpretation depends on streaming state.

_Alternative considered:_ adding a separate `onAbort` prop to `RichAttachmentEditor` and binding `⌘⏎` to it when streaming. Rejected — the editor would need to know about Explore's streaming state, which is leaky.

### D4 — Visual: copy sidebar's red Stop button verbatim

Use a `Button` with `variant="ghost"` and `text-destructive` classes (same Tailwind tokens as `ChatInput.tsx` lines 100–109). Keep the `⌘⏎` hint span; just change the label.

```
┌──────────────────────────────────────────────────────────────┐
│ [ RichAttachmentEditor / textarea ]                          │
│                                                              │
│                              ┌────────────────────────────┐  │
│              while streaming │  Stop          ⌘⏎          │  │
│                              └────────────────────────────┘  │
│                              ┌────────────────────────────┐  │
│              while idle      │  Send          ⌘⏎          │  │
│                              └────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

The Stop button keeps the same DOM slot as Send so the composer geometry does not jump on state change.

### D5 — Hide Stop during the bootstrap turn

Explore Spec auto-fires a wrapped slash-command turn on mount (`/specrails:explore-spec\n\n<idea>`). Cancelling that priming turn would leave the conversation half-initialised — the user would see an explore shell with no assistant context, and the next `--resume` would replay a half-killed turn. We gate Stop on `conversation.messages.length > 1` so the Stop affordance only appears for second-and-later streaming turns. During the bootstrap (length ≤ 1), the Send button stays rendered but disabled (existing behaviour). The `⌘⏎` keybind is also a no-op while bootstrapping.

### D6 — Do not gate Stop on `pendingTurn`

The composer's Send is currently disabled while `pendingTurn` is true (optimistic skeleton at T+0, before the server has flipped `isStreaming`). Stop must NOT inherit that gate — if the user wants to interrupt during the optimistic skeleton, `abortStream` is still safe (server returns 404/204 if no child; the optimistic state clears via the next WS update). However, the swap only happens once `isStreaming === true` flips, which is when there is actually a process to kill. If `isStreaming` is false but `pendingTurn` is true, the Send button stays visible but disabled (existing behaviour, unchanged).

## Risks / Trade-offs

- **Race: user hits Stop before the server has registered the child process.** → The server's abort handler already short-circuits gracefully (`DELETE` returns 200 even if there's nothing to kill). No new risk.
- **Race: streaming flips false between render and click.** → `chat.abortStream` is idempotent; the worst case is a no-op `DELETE`. Acceptable.
- **Discoverability: users may not realise `⌘⏎` also stops.** → The `⌘⏎` hint span is reused (visually identical to the Send state), so muscle memory transfers. The button text ("Stop") plus the keybind hint is the same affordance pattern the sidebar already uses; no new docs needed.
- **Partial output confusion: a half-finished assistant bubble remains visible.** → This matches the sidebar's behaviour. Users understand "I stopped it mid-sentence." No spec change.

## Migration Plan

No data migration. Pure additive client change.

Rollback: revert the `ExploreSpecShell.tsx` diff. No server changes, no schema changes, no WS protocol changes.

## Open Questions

_None._
