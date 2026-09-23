## 1. Composer Stop button

- [x] 1.1 In `client/src/features/specs/components/explore-spec/ExploreSpecShell.tsx`, render a Stop button in the same flex slot as the Send button when `conversation?.isStreaming === true`. Use `Button` with `variant="ghost"` + `text-destructive` classes (mirror the visual treatment in `client/src/features/chat/components/ChatInput.tsx` lines 100–109). Keep the `⌘⏎` keybind hint span visible in both states.
- [x] 1.2 The Stop button SHALL be enabled regardless of composer text content. The Send button retains its existing disabled rules (`!hasComposerText || (!conversation && !editTicket) || conversation?.isStreaming || pendingTurn`).
- [x] 1.3 Wire the Stop button's `onClick` to `chat.abortStream(conversation.id)` from `useChat()`. Guard against `conversation == null`.

## 2. Keybind (⌘⏎ / Ctrl+⏎) context routing

- [x] 2.1 Update `submitComposer` in `ExploreSpecShell.tsx` to branch on `conversation?.isStreaming`: if streaming and a conversation exists, call `chat.abortStream(conversation.id)` and return early; otherwise keep the existing send path. Do not clear the composer text on the abort branch.
- [x] 2.2 Verify `RichAttachmentEditor`'s `onSubmit` is the only path for the keybind so we do not need to touch the editor's keydown handler.

## 3. Tests

- [x] 3.1 Extend `client/src/features/specs/components/explore-spec/__tests__/ExploreSpecShell.test.tsx` with a test that renders the shell with `conversation.isStreaming === true`, asserts a "Stop" button is present, asserts Send is not, and clicking Stop calls the mocked `abortStream` with the conversation id.
- [x] 3.2 Add a test that asserts the Stop button is enabled even when the composer is empty.
- [x] 3.3 Add a test that simulates the `⌘⏎` keybind via `RichAttachmentEditor`'s `onSubmit` prop while `isStreaming` is true and asserts `abortStream` is called (and no `sendMessage` call is made).
- [x] 3.4 Add a test that asserts Send is restored (and Stop unmounts) when `isStreaming` flips back to false.
- [x] 3.5 Run `cd client && npm run test:coverage` and ensure the 80% lines/statements / 70% functions thresholds still pass.

## 4. Type check + manual verification

- [x] 4.1 Run `cd client && npx tsc --noEmit` and confirm no errors.
- [ ] 4.2 Start `npm run dev`, open an Explore Spec conversation, send a turn, click Stop mid-stream; verify the assistant bubble freezes mid-output and a follow-up turn resumes the conversation cleanly via `--resume`.
- [ ] 4.3 Repeat 4.2 with `⌘⏎` while streaming; verify it aborts (does not submit composer text) and the composer text is preserved.
