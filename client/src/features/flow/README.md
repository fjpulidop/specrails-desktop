# flow

Client side of Flow mode: the user builds working code with an agent in an
isolated worktree, by conversation and without a spec, and then hands the
worktree to a rail that derives the spec. Server contract:
[Flow module](../../../../server/modules/flow/README.md); design:
[Flow mode](../../../../docs/internals/flow-mode.md).

## How Flow reaches the mission chat

Missions never import this feature. [FlowMissionsBridge](components/FlowMissionsBridge.tsx)
is mounted by `App.tsx` around `AgentChatProvider`; it provides
[FlowContext](context/FlowContext.tsx) and plugs `FLOW_MISSION_EXTENSIONS`
into the missions extension seam
([MissionExtensionsContext](../missions/context/MissionExtensionsContext.tsx)):

| Slot | Flow implementation |
| --- | --- |
| `fenceCards['flow-offer']` | [FlowOfferCard](components/FlowOfferCard.tsx): Flow or spec + Implement, with the recommendation, its reason and the other option one click away; Flow opens [FlowEntryCard](components/FlowEntryCard.tsx) |
| `useConversationMode` | `data-flow="active"` on the conversation surface ([flow.css](flow.css)), the worktree branch in the git strip, interrupting sends |
| `ConversationDock` | [FlowDock](components/FlowDock.tsx): [FlowBar](components/FlowBar.tsx) (active, paused, needs-review) or [FlowHandOffCard](components/FlowHandOffCard.tsx) |

A registry/slot seam was chosen over render props threaded through missions
because the Flow UI appears in three places (messages, surface, dock) of two
hosts (floating panel and Agent Mode, including split panes); one context value
reaches all of them and keeps the dependency one-way (`flow → missions`).

## Lifecycle in the UI

1. The operator emits a `flow-offer` block. Choosing Flow shows the entry card
   (isolated worktree, main branch untouched, idea, provider). Start calls
   `POST /flow`; the offer records `{ chosenMode: 'flow', recommendedMode, flowId }`
   on `agent_messages.intent` (`flow-offer`). Choosing Implement records
   `chosenMode: 'implement'` and replies to the agent, which continues with
   framing and the spec draft. When `GET /flow/availability` is unavailable,
   Start is disabled and the missing Core capabilities are listed in plain words.
2. While the Flow is `active`: surface treatment, Flow bar (branch, files and
   +/−, real cost, View changes, Pause, Discard with confirmation, **This is
   it**), worktree branch in the git strip, and busy sends use
   `deliveryMode: 'interrupt'` (Zap button). A 409 `interrupt_requires_flow`
   (the Flow ended meanwhile) is resent as a normal message.
   While an app the agent started for this Flow (a background process with
   `flowId`, read from the mission's `BackgroundProcessesContext`) announces
   `appUrls`, [FlowAppPreview](components/FlowAppPreview.tsx) adds **Preview**
   with a live dot (opens the local address in the system browser, like the
   app chips) and a menu with the network address and **Stop app**. Hidden
   when nothing runs. Specrails stops the app on pause, discard and hand-off.
3. `paused`: compact bar with **Resume Flow**, This is it and Discard.
   `needs-review`: the worktree is missing; the bar explains it and offers no
   destructive action.
4. **This is it** calls nothing on the server. The bar and surface animate out
   and the hand-off card appears: `AgentRailLaunchCard` in hand-off mode with
   the Flow's spec, the `factory:flow-spec` loop preselected and a free empty
   rail. Launch calls `POST /flow/:id/hand-off`; refusals (review WIP limit,
   budget, `rail_not_empty`…) render inline like any launch card. **Not yet**
   returns to the Flow. The launch is recorded as `flow-hand-off` on the offer
   message; reloads show the frozen record there.

Cost is the server's provider-billed sum (`GET /flow/:id/cost`): `—` until a
turn is priced, `*` with a tooltip when some turns were not priced. It is never
estimated. Diff and cost refresh on state changes, when a turn settles and every
8 s while the agent works.

## State and events

`FlowContext` caches the Flow per `(projectId, conversationId)` a mounted view
watches, availability per project, the wrapping-up set and recent hand-off
receipts. `flow.state` WebSocket events are applied only for watched projects
(a ref, never a stale closure); a reconnect refetches every watched Flow. Calls
name the conversation's pinned project explicitly (`flowBase(projectId)`, the
same base `getApiBase()` builds for the active project).

The board label lives in specs (`lib/spec-flow.ts`, `SpecCard`): it reads
`metadata.flow.state` (`active`/`paused`), links to the conversation and keeps
the placeholder spec off rails until the hand-off.

## Public subpaths

- [components/FlowMissionsBridge.tsx](components/FlowMissionsBridge.tsx)

## Feature dependencies

- [background](../background/README.md)
- [missions](../missions/README.md)
- [providers](../providers/README.md)
- [rails](../rails/README.md)

Run the adjacent tests with `npm run test --prefix client -- src/features/flow`.
Validate navigation with `node scripts/audit-client-features.mjs --check`.
