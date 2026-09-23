## Why

While an Explore Spec turn is streaming, the user has no way to interrupt the model — they must wait for the full response (potentially minutes for deep reasoning) even after realizing the answer is off-track. The server already supports cancellation via `DELETE /api/projects/:projectId/chat/conversations/:id/messages/stream` (used by the sidebar chat), but `ExploreSpecShell` exposes no UI affordance for it.

## What Changes

- Add a red **Stop** button to the Explore Spec composer that replaces the Send button while `conversation.isStreaming === true`, mirroring the sidebar chat pattern (`ChatInput.tsx`).
- Wire `Cmd+Enter` (Mac) / `Ctrl+Enter` (others) to trigger Stop while streaming, mirroring the same keybind that submits when idle.
- Stop calls the existing `DELETE /chat/conversations/:id/messages/stream` endpoint via the existing `useChat.abort()` (or equivalent) — no new server endpoint, no new WS messages.
- Partial assistant output already on screen is preserved; the next user turn proceeds normally with `--resume` against the same `session_id`.

Out of scope (deferred): AI Edit refine (`AiEditShell`) and Quick spec generation. Quick gen has no server-side child tracking and would require a larger server change.

## Capabilities

### New Capabilities

_(none)_

### Modified Capabilities

- `explore-spec`: Add a requirement for an in-shell Stop affordance while a turn is streaming, plus the matching `Cmd/Ctrl+Enter` keybind behaviour.

## Impact

- **Client**: `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx` (composer area + keydown handler), plus its test file.
- **Server**: none. The cancel endpoint, `ChatManager.abort()`, and `treeKill` path already exist and are used by the sidebar chat.
- **WS protocol**: none.
- **Specs**: delta on `explore-spec`.
