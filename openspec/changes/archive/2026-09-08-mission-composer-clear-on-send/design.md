## Context

The mission composer keeps its unsent work in a module-level session store (`client/src/lib/agent-composer-drafts.ts`): three `Map`s keyed by conversation id, plus the sentinel `__new-mission__` slot for the empty compose screen, mirrored into `sessionStorage` for crash recovery. The store exists because the composer legitimately unmounts — Mission⇄Board switching, panel close, detached mission windows — and a typed prompt must survive that.

`AgentComposer` reads that store **once per draft key**, into local state:

```
  inputState = useState(() => ({ draftKey, value: composerDrafts.get(draftKey) ?? '' }))
  input      = inputState.draftKey === draftKey ? inputState.value
                                                : composerDrafts.get(draftKey) ?? ''      // :123
```

So the store is an initializer and an unmount backup, never a live subscription. Once `inputState.draftKey === draftKey`, the component ignores the store entirely. That is fine while one instance owns a draft key for its whole lifetime — and it is exactly what breaks when ownership transfers mid-flight.

Ownership transfers on mission materialization. `send()` on the empty compose screen calls `materializeDraftConversation()`, which POSTs a conversation, calls `migrateNewMissionComposerDrafts(created.id)` — re-writing the typed text under the **new** key — and then `setActive(created)`. That flip swaps the composer instance in both surfaces:

```
  Mission mode   AgentModeSurface.tsx:80,105
                 active === null ? <AgentComposer/> : <AgentConversationView/>
                 └─ two JSX branches ⇒ unmount + mount

  Board mode     AgentConversationView.tsx:81
                 <AgentConversationContent key={active?.id ?? '__new-mission__'}/>
                 └─ key changes ⇒ remount
```

Meanwhile `submit()` is still awaiting the message POST inside the **old** instance's closure, and does its clearing afterwards (`AgentComposer.tsx:533-542`). By then the old instance is gone: `composerDrafts.delete(targetKey)` still runs (the store is module-level), but `updateInputState(…, '')` targets dead state, and the instance guard `attachmentDraftKeyRef.current === targetKey` (`:540`) is false anyway because the dead instance's ref froze at `__new-mission__`. The live instance already seeded itself with the migrated text and has no reason to look at the store again.

Two independent defects fall out of one placement decision:

```
  ┌───────────────────────────────────────────────────────────────┐
  │ D1 · ORPHANED TEXT   (new mission, both modes, deterministic) │
  │      clear lands in an unmounted instance ⇒ never clears      │
  ├───────────────────────────────────────────────────────────────┤
  │ D2 · LINGERING TEXT  (every send)                             │
  │      clear waits for the POST ⇒ text visible for the whole    │
  │      round trip while the user bubble is already rendered     │
  │      (new mission = two chained POSTs = double the window)    │
  └───────────────────────────────────────────────────────────────┘
```

`agent-chat.test.tsx:1172` already asserts the box empties after send and passes, because `open()` calls `ensureActive()` and leaves a conversation active before the user ever types — the assertion never reaches the `active === null` path where the instance swap happens.

## Goals / Non-Goals

**Goals:**
- The composer that is on screen reflects the draft store, whatever instance it happens to be — clearing can never be stranded in a dead component.
- An accepted send empties the box at submit time, in the same frame the user bubble appears.
- A rejected send loses nothing: text, inline references, attachments and the stable retry identity all come back exactly as submitted.
- Concurrent typing and mission switching during an in-flight send keep their existing anti-clobber protection: a newer draft is never overwritten by an older send's bookkeeping.
- Regression coverage runs against the real mission tree, so a future remount cannot silently reintroduce this.

**Non-Goals:**
- Removing the remount. The EMPTY→ACTIVE branch split (`agent-mode-shell`) and the shared `layoutId` hero-to-docked morph are deliberate design and stay untouched.
- Changing the send contract, delivery receipts, queueing, or steering semantics (`agent-live-steering`).
- Changing the draft store's persistence format, its `sessionStorage` recovery, or the detached-mission handoff (`detachable-mission-windows`).
- Any server, REST, WebSocket, database or i18n change.

## Decisions

### D1 — Make the draft store observable; stop treating mount identity as ownership

The composer subscribes to the draft store instead of snapshotting it once. Any mutation — clear, migrate, restore — notifies subscribers, and every mounted composer for that key re-reads.

The codebase already has this exact pattern for module-level session state: `client/src/lib/mission-view-state.ts`, `client/src/context/MissionWindowsContext.tsx` and `client/src/lib/effects-prefs.ts` all pair a module store with `useSyncExternalStore`. Reusing it keeps the store the single source of truth it was always documented to be.

*Alternatives considered.* **(a) Reconcile after the fact** — have the new instance re-check the store on mount, or version the store and re-read on change only. That closes today's window but leaves the invariant "the visible value may diverge from the store" intact, so the next remount finds a new way in. **(b) Keep the composer mounted across materialization** — a stable key plus a single branch in `AgentModeSurface`. This removes the trigger rather than the fragility, and it fights the deliberate morph animation; a detached mission window or a future surface would still be able to swap instances. Subscription is the only option that makes instance identity irrelevant, which is the actual invariant we want.

### D2 — Clear on submit, restore on rejection

`submit()` clears the draft (text, references, attachments) **before** awaiting, having captured the exact payload. If `send()` returns `accepted: false` or throws, the captured payload is restored under the key that is current at that moment.

This inverts today's "clear on success" into "clear optimistically, undo on failure", which is what makes D2 (lingering) disappear as well as D1. It matches what the transcript already does: `send()` renders the optimistic user bubble before the POST (`AgentChatContext.tsx:1212`) and removes it on failure. The composer becomes consistent with the bubble instead of lagging it.

The restore must carry the submission identity (`composerSubmissionIds`), which is the stable `queueId` that makes a retry idempotent server-side. Restoring text without it would turn a user's retry into a second delivery.

*Alternatives considered.* Clearing only after acceptance and accepting the round-trip lag — rejected: it is the visible half of the complaint, and on a new mission the lag spans two chained POSTs. Clearing optimistically with no restore — rejected: a failed send would silently destroy typed work.

### D3 — Clear and restore stay payload-exact

The existing guard compares the live draft against the submitted payload before clearing (`AgentComposer.tsx:533-537`). That check is preserved and applied to both directions: the clear only removes a draft that still equals what was submitted, and the restore only writes back into a slot that is still empty or still holds that same payload. A user who types the next prompt during an in-flight send, or switches missions, keeps what they typed.

*Alternative considered.* Unconditional clear/restore — simpler, but it silently eats a draft typed during the send, which is a worse failure than the one being fixed.

### D4 — Cover the real tree, not a standalone composer

New regression tests drive the actual Agent-Mode surface and the floating panel from the empty compose screen through materialization to the docked composer, asserting the box is empty. The existing suite mounts `<AgentComposer/>` directly (`agent-chat.test.tsx:612,631,656,1342`) or reaches it through a provider whose `open()` already materialized a conversation, which is precisely why a deterministic bug shipped under a green assertion.

## Risks / Trade-offs

- **A subscription re-renders the composer on every keystroke** (each keystroke writes the store) → the snapshot is a plain string/array read per key, and the composer already re-renders per keystroke from its own state; the subscription must return referentially stable values for unchanged keys so `useSyncExternalStore` does not loop. Attachment and reference arrays need stable identity, not fresh copies.
- **Optimistic clear during a slow or failing network** → the box blanks and then repopulates, which can surprise mid-typing. Mitigated because restore is payload-exact: if the user started typing again, their newer text stands and the failed payload is not forced back over it. The failure toast already surfaces the error.
- **Two mounted composers for the same key** (a surface and a detached mission window, or a transient double mount during the morph) now converge instead of diverging → this is the desired behaviour, but it makes concurrent editing in two places visible rather than isolated. The mission-transfer block (`blockMissionTransfer`, `AgentComposer.tsx:193`) already prevents an editable second surface for the same mission.
- **`sessionStorage` writes on every mutation** → unchanged from today; the store already persists per keystroke and swallows quota failures.
- **Behaviour change on rejected sends** → today the draft survives a rejection by never having been cleared; now it survives by being restored. A restore bug would look like data loss, so it needs direct coverage for every `accepted: false` path (network error, frozen mission in another window, empty payload).

## Migration Plan

Pure client-side behaviour change: no schema, no persisted format change, no API contract change. The store's `sessionStorage` payload shape is untouched, so a session that survives the update recovers its drafts exactly as before. Rollback is reverting the change; there is no state to unwind.
