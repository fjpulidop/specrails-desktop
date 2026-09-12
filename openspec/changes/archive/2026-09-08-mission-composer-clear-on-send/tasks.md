## 1. Make the draft store observable

- [x] 1.1 Add change notification to `client/src/lib/agent-composer-drafts.ts`: a subscribe/getSnapshot pair per draft key, following the existing module-store pattern in `client/src/lib/mission-view-state.ts`. Every mutation path (`setInput` writes, `restoreComposerDraft`, `migrateNewMissionComposerDrafts`, the clear/restore added in group 2, and the attachment writes) MUST notify.
- [x] 1.2 Return referentially stable snapshots for unchanged keys (text string, reference array, attachment array), so `useSyncExternalStore` cannot loop on identity churn.
- [x] 1.3 Extend `__clearComposerDrafts()` to reset subscribers, so tests stay isolated.
- [x] 1.4 Unit-test the store directly: notification on each mutation kind, snapshot stability when an unrelated key changes, and no notification when a write is a no-op.

## 2. Rework the composer's send path

- [x] 2.1 Replace the mount-time snapshot in `AgentComposer.tsx` (`inputState`/`referenceState` at `:119-124`) with a subscription to the store for the current `draftKey`, keeping the local-echo behaviour of `setInput` so typing stays responsive.
- [x] 2.2 In `submit()`, capture the submitted payload (text, inline references, attachment ids, submission identity) and clear the draft BEFORE awaiting `send()`.
- [x] 2.3 Restore the captured payload — including `composerSubmissionIds` — when `send()` returns `accepted: false` or throws.
- [x] 2.4 Apply the payload-exactness guard to both directions: clear only a slot that still equals the submitted payload, restore only into a slot that is still empty or still holds that payload.
- [x] 2.5 Delete the now-dead post-await cleanup and the instance guard `attachmentDraftKeyRef.current === targetKey` (`:533-542`), and confirm the `activeId` restore effect (`:260-273`) is still needed or remove it if the subscription subsumes it.
- [x] 2.6 Verify the queue-edit mode (`editingQueueId`, stash/restore at `:1443`+ in the test suite) still stashes and restores correctly against the subscribed value.

## 3. Regression coverage on the real surfaces

- [x] 3.1 Add a test that renders the Agent-Mode surface with no active mission, types into the hero composer, submits, and asserts the docked composer that appears after materialization is empty.
- [x] 3.2 Add the equivalent test for the floating panel, whose `AgentConversationContent` remounts on the `active?.id` key change.
- [x] 3.3 Add a test that a rejected send (transport failure) restores text, inline references and attachment chips, and that re-submitting reuses the original submission identity.
- [x] 3.4 Add a test that typing a new prompt during an in-flight send survives both the clear and the restore.
- [x] 3.5 Add a test that switching missions during an in-flight send leaves the target mission's draft untouched.
- [x] 3.6 Keep the existing draft-survival test (`agent-chat.test.tsx:1160`) passing, and assert the box is empty immediately after submit rather than after the send settles.

## 4. Verify

- [x] 4.1 `npm run typecheck`
- [x] 4.2 `npm test`
- [x] 4.3 `cd client && npm run test:coverage` — must pass 80% lines/statements, 70% functions
- [x] 4.4 Manually exercise both surfaces: new mission first message, follow-up message, send with attachments, send with `@`/`#` chips, and a send while the agent is streaming (queued).
