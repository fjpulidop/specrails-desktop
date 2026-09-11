## Why

Sending the first message of a new mission leaves that exact message sitting in the composer. The user sees their prompt in the transcript AND still in the input box, and it never goes away on its own — they have to select it and delete it, or switch missions and come back. It reads as "the send didn't work", so people re-send.

The clear is written as post-acceptance cleanup inside `submit()` (`AgentComposer.tsx:533-542`), but materializing a draft mission swaps the mounted composer underneath it: `AgentModeSurface` renders two mutually exclusive branches around `active === null` (`:80`, `:105`) and `AgentConversationView` keys its content by `active?.id` (`:81`). The instance that owns the awaited response is unmounted by the time the response lands, while the freshly mounted instance has already re-seeded itself from the draft store that `migrateNewMissionComposerDrafts` just re-populated under the new conversation id (`AgentChatContext.tsx:1158`). Clearing therefore writes into a dead component, and the guard `attachmentDraftKeyRef.current === targetKey` (`:540`) skips even that. Nothing is left to reconcile the visible instance, because `input` only falls back to the store when the draft key differs (`:123`).

The same post-await placement also means that on every send — remount or not — the typed text stays visible for the whole request round trip while the user bubble is already in the transcript. On a new mission that window spans two chained POSTs.

## What Changes

- The composer draft store becomes the single source of truth for what the composer shows: clearing a draft converges on **every** mounted composer instance, so a component swap between submit and response can no longer strand text on screen.
- An accepted send clears the composer **immediately on submit**, not after the server responds, so the box empties the moment the user bubble appears.
- A rejected send (network failure, mission frozen in another window, empty payload) restores the exact submitted payload — text, inline references, attachments, and the stable retry identity used for idempotent re-send — so nothing is lost and a retry is still deduplicated server-side.
- Clearing and restoring stay payload-exact: if the user typed a new draft or switched missions while the send was in flight, that newer draft is never overwritten.
- Regression coverage exercises the real mission tree (empty compose screen → materialization → docked composer), not a standalone composer mount, which is why the existing assertion at `agent-chat.test.tsx:1172` passes against broken behaviour.

## Capabilities

### New Capabilities
- `mission-composer-drafts`: the lifecycle of an unsent mission composer draft — where it lives, how it survives unmounting and mission materialization, when it is cleared, and what happens to it when a send is rejected.

### Modified Capabilities

<!-- None. The EMPTY/ACTIVE surface split (`agent-mode-shell`) and the hero-to-docked
     morph stay exactly as specified; this change removes the composer's dependency
     on staying mounted, rather than removing the remount. -->

## Impact

- `client/src/lib/agent-composer-drafts.ts` — the session draft store gains change notification so mounted composers converge on it.
- `client/src/components/agent-chat/AgentComposer.tsx` — `submit()` clears before the await and restores on rejection; the visible value stops depending on this instance having survived.
- `client/src/context/AgentChatContext.tsx` — `send()` keeps its accept/reject contract; `materializeDraftConversation`'s draft migration is unchanged.
- `client/src/components/agent-chat/__tests__/` — new coverage over the real Agent-Mode and floating-panel trees.
- No server, REST, WebSocket, or persistence change. No i18n change.
