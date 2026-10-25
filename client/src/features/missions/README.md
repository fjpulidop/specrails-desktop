# missions

This capability owns its UI, state, feature utilities and adjacent tests.
Shared rendering primitives, API origin/auth and project cache remain outside features.

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/AgentActivityChip.tsx](components/AgentActivityChip.tsx)
- [components/AgentBrowserCaptureHost.tsx](components/AgentBrowserCaptureHost.tsx)
- [components/AgentMessage.tsx](components/AgentMessage.tsx)
- [components/AgentModeSurface.tsx](components/AgentModeSurface.tsx)
- [components/AgentModelSelector.tsx](components/AgentModelSelector.tsx)
- [components/AgentPrDecisionPill.tsx](components/AgentPrDecisionPill.tsx)
- [components/AgentRailLaunchCard.tsx](components/AgentRailLaunchCard.tsx)
- [components/AgentRunStrip.tsx](components/AgentRunStrip.tsx)
- [components/AgentToolbarSelector.tsx](components/AgentToolbarSelector.tsx)
- [components/AgentWorkspaceSidebar.tsx](components/AgentWorkspaceSidebar.tsx)
- [components/MissionConversationMenu.tsx](components/MissionConversationMenu.tsx)
- [components/MissionModeBadge.tsx](components/MissionModeBadge.tsx)
- [components/MissionWindowAction.tsx](components/MissionWindowAction.tsx)
- [components/MissionWindowBindings.tsx](components/MissionWindowBindings.tsx)
- [components/MissionWindowSurface.tsx](components/MissionWindowSurface.tsx)
- [components/agent-run-failure.ts](components/agent-run-failure.ts)
- [components/run-primary.tsx](components/run-primary.tsx)
- [context/AgentChatContext.tsx](context/AgentChatContext.tsx)
- [context/AgentWorkspaceContext.tsx](context/AgentWorkspaceContext.tsx)
- [context/MinimizedChatsContext.tsx](context/MinimizedChatsContext.tsx)
- [context/MissionExtensionsContext.tsx](context/MissionExtensionsContext.tsx)
- [context/MissionSessionsContext.tsx](context/MissionSessionsContext.tsx)
- [context/MissionSplitViewsContext.tsx](context/MissionSplitViewsContext.tsx)
- [context/MissionWindowsContext.tsx](context/MissionWindowsContext.tsx)
- [hooks/useAgentLive.ts](hooks/useAgentLive.ts)
- [hooks/useAgentRefActions.ts](hooks/useAgentRefActions.ts)
- [hooks/useMissionPlaceSync.ts](hooks/useMissionPlaceSync.ts)
- [lib/agent-api.ts](lib/agent-api.ts)
- [lib/agent-refs.ts](lib/agent-refs.ts)
- [lib/mission-search.ts](lib/mission-search.ts)
- [lib/mission-windows.ts](lib/mission-windows.ts)

## Feature dependencies

- [agents](../agents/README.md)
- [analytics](../analytics/README.md)
- [background](../background/README.md)
- [browser](../browser/README.md)
- [builder](../builder/README.md)
- [chat](../chat/README.md)
- [code](../code/README.md)
- [delivery](../delivery/README.md)
- [jobs](../jobs/README.md)
- [loops](../loops/README.md)
- [projects](../projects/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)
- [recovery](../recovery/README.md)
- [settings](../settings/README.md)
- [specs](../specs/README.md)
- [terminals](../terminals/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

## Runs in a mission: one strip, a history of events

A mission shows its live runs in ONE place: the run strip above the composer
([`AgentRunStrip`](components/AgentRunStrip.tsx), model in
[`mission-run-strip.ts`](components/mission-run-strip.ts)). It shows one run at
a time — the most urgent (waiting for you › failed › running › paused) unless
the person holds another (picked in the switcher, panel open, or focus inside
the strip) — as a status mark (a shape per state, never color alone), the
current step in plain words, progress (several runs), elapsed time and billed
cost (`—` until billed, `*` when partial). A held strip is never swapped: a
run that starts needing the person meanwhile gets a "needs you" mark in the
switcher and a polite announcement. A primary action appears only when the
run needs the person and is DECLARED by the run's card through
[`run-primary.tsx`](components/run-primary.tsx) (`RunPrimaryButton` /
`useRunPrimary`: id, label, kind, handler — no DOM reading). A `local` action
(Resume, Back to Flow, Mark done) runs in one click in place; an `outward` one
(Create PR, Publish, Reopen, Approve, Launch, retry delivery, and Relaunch and
Recover because they spend money on a new run) is never fired from the strip:
it opens the panel with focus on the card's own control. Clicking the strip opens that card as a panel
anchored above the strip (not a modal: Esc or a click in the conversation
closes it, focus returns to the strip). The cards stay mounted while hidden and
report the run's step and vitals to the strip. The strip owns the mission's
ONE polite live region (the extension's `ConversationDock` speaks through its
`announce`). Its "+N" menu has roving focus (arrows, Home/End, Esc back to the
button); switcher entries carry their full name and state as accessible name
and tooltip; a partial cost's `*` is also said in words. Extensions add their runs
through `useLiveRuns` (Flow) and name steps through `describeRun`; a live run
can hear its panel close (`onPanelClose(reason)`: `escape` for Esc,
`collapse` for a click outside, the toggle or another run — Flow's hand-off
treats only `escape` as "Not yet"), can keep its card's primary on the strip in
a calm tone (`wantsPrimary`), and a run with a `mode`
keeps the mode's icon as its mark in every state, badged with the state's
shape. The switcher marks each run with the same per-state shape (never color
alone), and a strip with one run still shows its name. An extension run in a
`decision` or `failed` tone feeds the mission list's attention dot like a
delivery; calm states never do. An extension that provides `useRunAttention`
(Flow) derives that attention app-wide for every listed mission, so the dot is
live and clears with the mission closed, and the strip leaves those runs to
it; otherwise the strip reports them while mounted (`reportRunAttention`). Every run primary (the
strip's, the hand-off Launch, the card primary, Flow's Start) shares ONE
recipe, `PRIMARY_ACTION_SHAPE` / `PRIMARY_ACTION` in `run-primary.tsx`.
Keyboard shortcuts are conversation-scoped (`run-strip-keys.ts`): ⌥R jumps to
the strip of the mission you are in (again: details), Esc returns, ⌥[ / ⌥]
switch runs outside text fields, ←/→ move along the switcher, and a row
control may claim a letter with `data-strip-key` that works only while the
strip has focus (Flow's P and H).

The history never repeats what is live: each milestone is one event line
([`AgentRunEventLine`](components/AgentRunEventLine.tsx)) in its chronological
slot — "Launched on Rail 1", "Rail 1 failed: …", "Back to Flow", "Entered /
Left Flow" — that opens the run. A settled Implement run keeps its card in the
history; a settled Flow → Spec run is an outcome line that expands its card
(the Flow's closing summary is the full card of that story). Extension modes
(Flow) are named on the composer (placeholder always; the chip on the empty
composer and in the floating panel — the inline dock leaves it to the mission
header) in the
mode's own color (`MissionModeBadge.accent`; Flow: `--color-accent-flow`),
on its agent turns (`useTurnMark`) and on the strip mark (`MissionLiveRun.mode`), next to the
mission title and on the mission list ([`MissionModeBadge`](components/MissionModeBadge.tsx)),
where a dot with words also marks missions waiting for a decision
(`attentionConversationIds`).

## Conversation and composer

The transcript is a `role="log"` (additions only, never `aria-live`, so streamed
frames stay silent); a separate polite status next to it says only the turn
boundaries ("Agent is working…" / "Agent replied"). Run announcements stay with
the strip. Messages are `article`s named by author. Scrolled up while something
arrives, the view offers a "New messages" pill that returns to the bottom; a
mission that opened at the bottom keeps landing there through late layout.

The composer editor has a stable accessible name (`composer.ariaLabel`; the
placeholder is visual only and follows the state: no provider › interrupt ›
queue › extension mode › reply in a mission › new-mission invitation). The
`@ # /` palette is the editor's listbox (`aria-controls`,
`aria-activedescendant`) and, like the `+` menu, flips below its anchor when
there is less than 240px above it (`useComposerPopoverPlacement`). The `+` menu
is a keyboard menu (arrows, Home/End, Esc back to the trigger); the git strip's
branch list walks with the arrows and Enter checks out the first match.
Entering Autonomous from the tier ladder never happens on ⇧⇥ alone:
[`useGuardedTierCycle`](hooks/useGuardedTierCycle.ts) asks with a toast, and a
second ⇧⇥ while it is pending skips back to Observe. Alt+1…9 picks the newest
message's suggested reply while the box is empty. On-accent glyphs use
`text-background` (`text-destructive-foreground` on Stop) so they read in every
theme.

## Live turn state and rendering performance

A streamed token must never re-render anything but the text it extends. The rules:

- **Live turn state is not in React state.** Streamed text, tool chips and queued
  inputs live per conversation in an external store
  ([`live-store.ts`](lib/live-store.ts), provided by `AgentChatProvider` through
  [`LiveStoreContext`](context/LiveStoreContext.ts)). `useAgentChat()` carries none
  of it (its legacy `isStreaming` / `streamingText` / `queuedMessages` /
  `streamingConversationIds` / `liveByConversation` fields exist only so isolated
  tests can mock the chat with a flat shape). Read it through
  [`hooks/useAgentLive.ts`](hooks/useAgentLive.ts): `useActiveLive()` (the streaming
  tail only), `useIsStreaming()`, `useActiveQueued()`, `useStreamingConversationIds()`,
  `useQueuedCounts()`, `useIsConversationStreaming(id)`. Aggregates keep their
  identity while their content is unchanged, so lists never re-render per token.
- **Frame batching.** `appendStream` buffers tokens: the open mission folds them in
  once per animation frame (a timer covers hidden windows), missions out of view every
  500 ms. The first token of a turn flips `isStreaming` at once (sidebar dot, composer).
  Any state transition (`patch`) folds the buffer in first, so order is never inverted
  and no token is lost or duplicated. Text-only changes notify only that conversation's
  subscribers; aggregates wake on structural changes (streaming flag, tools, queue).
- **The open mission renders in three layers**
  ([`AgentConversationView`](components/AgentConversationView.tsx)): settled rows
  (memoised, `content-visibility` for older ones), the `LiveTail` (the only part that
  re-renders per frame) and the composer/run strip. The transcript is a
  `useDeferredValue` of the committed messages and mounts windowed (newest 24 rows, the
  rest backfilled in a transition while keeping the distance to the bottom), so opening
  a long mission paints header, composer and the latest rows first. A mission saved
  mid-history renders everything straight away to restore its scroll. A long streamed
  answer renders as settled markdown chunks plus the live tail
  ([`stream-markdown-blocks.ts`](lib/stream-markdown-blocks.ts)); settled messages
  always render whole.
- **Revisits are instant.** `AgentChatProvider` keeps a stale-while-revalidate snapshot
  of the last 12 missions opened, shares one in-flight read per mission, and exposes
  `prefetchConversation(id)` (sidebar rows call it on hover/focus/press). WS rows that
  arrive while a mission is away are replayed over its snapshot. Opens that carry an
  `AbortSignal` (window transfer, restore) always read fresh.
- **Do not touch React state per token in a WS handler.** Even a `setState` that
  bails out is an urgent update: it restarts the interruptible render of the mission
  being opened and can starve it under a busy background stream. `markUnread` keeps a
  ref for "already unread"; `MissionSessionsContext` ignores user-turn tokens.
- **Place sync.** With the browser router the History API moves at once while the
  router's React state commits as a transition. `useMissionPlaceSync` acts on the real
  URL and never reads a trailing router state as Back/Forward, so a cached revisit is
  not pulled back to the mission just left.
- **Not adopted, on measurement:** a Web Worker for markdown (parse is ~20 % of a
  streaming frame after chunking; AST transfer would cost more than it saves) and list
  virtualisation of the transcript (rows are heterogeneous cards with sub-agent
  anchors; windowing + `content-visibility` covers the open cost) and keeping the
  mission surface mounted behind `<Activity>` while the Board shows (measured slower on
  both switches: the hidden tree still renders). Revisit if a profile shows parse or
  layout dominating again.
- **Measure** with `client/src/features/missions/components/__tests__/perf-streaming-concurrency.test.tsx`
  (jsdom: render counts, markdown parses, lag; `PERF_OUT=file.json` dumps the numbers).
  Its bounds are regression tests. Real-browser numbers come from a production build
  driven by Playwright against a mock API/WebSocket.

Run the adjacent tests with `npm run test --prefix client -- src/features/missions`.
For moves, update imports and mocks together, then run client coverage and typecheck.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
