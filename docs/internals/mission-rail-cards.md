# Mission rail cards — as-built record

> OpenSpec change `mission-rail-cards` (2026-09-18), branch `feat/mission-rail-cards`. Companion to the CLAUDE.md section of the same name. Everything below is what the code on disk does; "deferred" means it does not.

## The problem

Mission mode (Agent Mode) replaces the routed dashboard, so `RailsBoard`, `SpecsBoard`, `RailRow` (with `RailPrDecisionStrip` and `AgentRuntimeRuns`) are never mounted there. The only object a mission had for an implementation run was the PR-decision card. On 2026-09-18 three gaps were verified:

1. **No git ⇒ no object.** The shared-cwd launch path in `server/modules/delivery/runtime/rails-router.ts` (`isolationUnavailable = 'no-git' | 'no-commits'`) never received `originConversationId`; no `rail_pr_deliveries` row, no card, only a `202 { isolationUnavailable }` the agent rarely mentioned.
2. **Failure was mute.** `discarded` swallowed `statusDetail` (gated on `deliveryBlocked`); `implementation_failed` offered Discard only; no WS event wrote into the conversation or started a turn; `/agent-runtime/runs` (resume / approve / recover) was absent from MCP.
3. **Assignment was prose.** Rails were not a palette entity; assigning specs meant dictating rail / engine / profile / loop in sentences, so users went to Board mode.

## The card lifecycle

```
  agent turn                  user                      run                      settle
┌──────────────┐   Play    ┌──────────────┐        ┌──────────────┐        ┌──────────────────────┐
│ rail-launch  │ ────────▶ │ launched     │ ─────▶ │ running      │ ─────▶ │ settled              │
│ (editable)   │  POST     │ stub in msg  │  card  │ status pill  │        │ ok → completed /     │
│ Dismiss ─┐   │  /launch  │ + run card   │        │ elapsed      │        │      delivery phase  │
└──────────┼───┘           └──────────────┘        │ log · Stop   │        │ fail → failure block │
           ▼                                       └──────────────┘        │   Resume/Recover/    │
     dismissed stub                                       │                │   Approve/Relaunch/  │
                                                          │ failure        │   Discard/Dismiss    │
                                                          ▼                └──────────────────────┘
                                          notifyMissionRunFailure
                                          card update + run-failure row
                                          + ONE automatic briefing turn
```

- **Proposal** — an assistant message with one or more fenced `rail-launch` blocks. Each block is one `AgentRailLaunchCard`; undecided proposals are live runs of the mission's run strip (above the composer; Launch performs the card's Play) and leave a one-line "Launch proposed" event in their history slot.
- **Launched** — Play succeeded (202). The proposal freezes into a "Launched → Rail N" stub (persisted on the message row), and the run takes over the run strip (a launching skeleton until its first step shows).
- **Running / settled / delivery** — the SAME envelope (`PrDecisionCardEnvelope`) carries `phase`, `runtime` and `hasDelivery`. With git, the delivery phase is the pre-existing PR-decision card. Without git, the card is run-only and ends at `completed` / `implementation_failed` / `discarded`.

## Protocol contract

Relaunch identifies the card's delivery or shared run with
`POST /rails/:railIndex/relaunch { sourceId, originConversationId?, originSurface? }`.
It uses the source's saved specs and launch options, even after terminal cleanup
emptied the rail. New attempts freeze these options in migration 71; historical
ones reconstruct only recorded loop/runtime/manifest fields. A missing workflow
requires a configured fresh launch. A rail reused for different specs is left
untouched; stale cards and delivered work that needs recovery are rejected.
Independent per-ticket siblings do not invalidate each other; newer overlapping
spec ownership does. A successful unit reporting no changes is not delivered work.
Undelivered failed generations are atomically superseded in fresh worktrees,
with allocation rollback and the original failed checkout retained. A synchronous
click guard prevents duplicate submissions; accepted relaunches stay disabled
until the new card appears, and rejected admission details remain inline.

Workspace narrowing is optional: when a delivery manifest has no explicit
workspace selections, Relaunch omits `workspaceSelection` and uses registered
defaults for its recorded repositories. Partial selections remain partial and
saved explicit selections take precedence; invalid selections still fail normal
admission. Removing the last repository with a workspace override from a launch
card also omits the property, instead of sending an invalid empty map.

```rail-launch
{
  "version": 1,
  "railIndex": 1,
  "newRail": null,
  "ticketIds": [12, 14],
  "mode": "implement",
  "loopId": "factory:implement",
  "aiEngine": "claude",
  "model": "opus",
  "reasoningEffort": "high",
  "profileName": "fast",
  "targetPrNumber": null,
  "baseBranch": null,
  "railName": "Auth",
  "rationale": "Both specs touch the auth flow; one rail keeps the diff coherent."
}
```

Parser pair `server/modules/delivery/runtime/rail-launch-parser.ts` ⇄ `client/src/features/rails/lib/rail-launch-draft.ts` (byte-identical except the mirror note; `server/modules/delivery/runtime/rail-launch-parser.test.ts` enforces parity). `extractRailLaunchProposals(content, streaming)` returns `{ body, proposals, rejected, pending, truncated, repaired }`:

- tolerant JSON repair (`json-tolerant`) before rejecting; `repaired` flags it;
- unknown keys dropped; `ticketIds` accepts `12`, `"12"`, `"#12"` (also under `specs` / `tickets`); `mode` folds the removed `batch` / `batch-implement` into `implement`, `newRail: true` for an unnamed rail; `railIndex` is ignored when `newRail` is set;
- rejection reasons: `invalid_json | not_object | unsupported_version | no_tickets | invalid_mode`, each with a ≤160-char excerpt — never silent;
- while streaming an open fence is cut from the body (`pending`); once settled an unreadable open fence is cut and reported `truncated`;
- every valid block is kept in order: a batch proposal is N blocks, N cards.

`agent-fence-promotion.ts` (server and client copies) re-tags a generic ```` ```json ```` fence whose body is a launch shape (ticket list plus a rail/launch key), checked after the spec-draft shape so a draft never becomes a launch.

## Server chokepoints and surfaces

| Piece | Where | Notes |
|---|---|---|
| Operator prompt | `server/modules/missions/runtime/agent-operator-prompt.ts` `RAIL_LAUNCH_CARD_SECTION`, `RAIL_LAUNCH_CARD_SYSTEM_CLAUSE`, `buildOperatorSystemPrompt()` | Propose = block; launch directly only on an explicit "now"; failure briefing reply ≤ 6 lines + one action, no mutation. Gated on `isMissionRailCardsEnabled()`. |
| Message intent | desktop-db migration 29 (`agent_messages.intent`, column-guarded); `agent-store.ts` `setAgentMessageIntent`; `PATCH /api/agent/conversations/:id/messages/:mid/intent` | JSON ARRAY of decisions keyed by `proposalIndex`; append-only; 409 `already_decided`; 403 when the feature is off. Rows expose `intents[]`. |
| Envelope | `server/types.ts` `PrDecisionCardEnvelope` (+ `MissionRunPhase`, `MissionRunRuntime`, `MissionRunFailure`) | `hasDelivery`, `phase`, `railName`, `runtime` — all optional; `decision` vocabulary unchanged. |
| Run-only cards | `server/modules/missions/runtime/mission-run-notify.ts` `runCardId` / `isRunCardId` / `buildRunCardEnvelope` / `postRunCard` / `settleRunCard` / `failureForLoopOutcome` / `runtimeFromSummary` | Synthetic `prDeliveryId = 'run:<runId>'`, `hasDelivery:false`. Wired in the shared-cwd branch of `rails-router.ts` (origin stored on `railLoopRuns` meta; 202 returns `runIds`). |
| Run-only dismiss | `POST /rails/pr-decision { prDeliveryId:'run:…', action:'dismiss', expectedDecision, conversationId }` → `AgentChatManager.dismissRunCard` | Other actions ⇒ 400 `run_card_dismiss_only`; unknown card ⇒ 404 `run_card_not_found`. |
| Failure trigger | `notifyMissionRunFailure` (`mission-run-notify.ts`) | Envelope update with `runtime.failure` → `AgentChatManager.postRunFailureRow` (one `system` row per run, WS `agent_run_failure`) → `AgentChatManager.startSystemTurn` (queueId `mission-failure:<runId>`, gated `isMissionFailureTurnEnabled()`). Callers: shared-cwd run promise, isolated settle (`implementation_failed`), `closeFailedGeneration` (`launch_failed`). Cancel updates the card, no turn. No origin ⇒ no-op. |
| Briefing | `server/modules/missions/runtime/agent-failure-briefing.ts` `buildFailureBriefing`, `failureBriefingRef`, `FAILURE_CODE_LABELS`, `FAILURE_BRIEFING_MAX_TAIL` | Fixed text: rail, specs, failure code + detail, bounded verify tail, recovery options, "do not relaunch by yourself". Persisted as a `user` row whose `context_refs[0].kind === 'system-briefing'`. |
| Settle snapshots | `rail-isolated-launch.ts` settle, `rail-pr-store.ts` `toPrDecisionCardEnvelope`, `agent-runtime-controls-router.ts` `runtimeRunSummary()` | `phase` + `runtime` on `implementation_failed` and launch-failed `discarded`; `statusDetail` as text. |
| Rails availability | `GET /:projectId/rails` | `availability: 'free' \| 'busy' \| 'pending_decision' \| 'on_review'` per rail. |
| MCP | `server/mcp/tools/jobs.ts` `runtime_runs`, `runtime_evidence` (read) · `runtime_resume`, `runtime_recover` (ai-spawn) · `runtime_approve`, `runtime_settle`, `runtime_dismiss` (write) · `runtime_cancel` (destructive); `mcp/guide.ts` recovery section | Over the existing `/agent-runtime/runs` routes; approve/recover are `resume` bodies. |
| Palette | `server/modules/missions/runtime/agent-chat-router.ts` `CONTEXT_KINDS` += `rail`; `server/modules/missions/runtime/agent-context-resolver.ts` `formatRail` | `@rail-N` reference serialization. |

WS messages: `agent_pr_decision` (existing, now carries the new fields), `agent_run_failure` (new, app-global, `AgentRunFailureMessage`).

## Client components

- `client/src/features/missions/components/AgentMessage.tsx` — extraction step after spec-draft (flag `FEATURE_MISSION_RAIL_CARDS`); renders `AgentRailLaunchCard` per proposal, `AgentRailLaunchPending`, `AgentRailLaunchUnreadable`.
- `AgentRailLaunchCard.tsx` — live reconciliation (`/rails` availability, `/tickets`, `/profiles`, `useProviderDetection`, model/effort catalogs, loops), New rail, Play flow (`POST /rails` → `PUT /tickets` → `POST /launch` with `originConversationId` + `originSurface:'agent-chat'` → `notifyGitChanged` → intent PATCH), inline 400/409, launched/dismissed stubs, `FOCUS_PR_CARD_EVENT`.
- Repository context (`/repositories`) is required before Play. The card shows launch targets and each spec's saved scope, including primary-only historical specs. **Edit → Save repositories** persists only `repositoryIds` through the pinned project's existing ticket PATCH; Cancel leaves it untouched. Saved scope and spec-list changes reconcile required targets while retaining extra launch targets and dropping workspace entries for removed repositories. Optional launch targets do not edit specs. Omitted required targets and missing/offline/context-only implementation targets block Play visibly. **Refresh** reloads assignments; failed loads expose **Retry loading**. The resolved launch scope and filtered workspace selection are frozen in the launched intent, and server admission remains authoritative.
- `client/src/features/rails/lib/rail-launch-intents.ts` — session overlay (`recordLocalIntent`, `intentFor`); `useRailLaunchProposals.ts` — undecided proposals for the run strip.
- `AgentPrDecisionCard.tsx` — run phase header (`deriveMissionRunStatus`, live `useRuntimeRuns` first), run-only rendering for `hasDelivery === false`, `RunFailureBlock`, Resume / Approve / Recover / Relaunch, focus-bus scroll + flash.
- `agent-pr-pinning.ts` `isPrEnvelopePinned` (a live delivery: the strip shows it); `agent-run-failure.ts` (`parseRunFailureRow`, `systemBriefingRunId`, `FOCUS_PR_CARD_EVENT`, `OPEN_RUN_STRIP_EVENT`, `MISSION_OPEN_RUN_EVENT`, `requestMissionOpenRun`); `AgentRunFailureMarker.tsx` (the failure as one history line in plain words).
- **Run strip** (`AgentRunStrip.tsx`, model `mission-run-strip.ts`): the ONE live representation of a mission's runs, above the composer in the floating panel and the Agent-Mode inline view alike. It shows one run — the most urgent (waiting for you › failed › running › paused; ties: the newest) unless the person holds another — a switcher pick (session-only), the open panel, or focus inside the strip; a held strip is never swapped, a run that newly waits or fails gets a "needs you" dot and words in the switcher (or on "+N") and a polite "Rail N needs you"; only an idle strip follows urgency (`heldStripKey`); more than three runs ⇒ the shown one, the two most urgent and "+N" — as a status mark with a shape per state (spinner launching, pulsing dot running, bell waiting, triangle failed, pause, info circle for settled information — "Finished without changes" and "PR closed without merging" are `info`, not decisions: no bell, no sidebar attention dot, lowest urgency, no strip primary; their cards keep their actions) plus a screen-reader state word, the step in plain words (extension `describeRun`, else the humanized step id), progress (finished/total runs, only for several), elapsed time and billed cost (`—` until billed, `*` when some runs are unpriced). Red is only the failed mark and headline. A primary action shows only when the run needs the person and while its panel is closed. The card DECLARES it (`run-primary.tsx`: `RunPrimaryButton` / `useRunPrimary` register `{ id, label, kind, rank, disabled, run, focus }` in a registry the strip scopes per run; the lowest rank wins — Approve › paused Resume › Create PR / Publish / Reopen / retry › Resume › Recover › Relaunch). `local` actions (Resume, Back to Flow, Mark as done, Verify PR) run in one click without opening the panel or moving focus; `outward` ones (Create PR, Publish, Reopen, Approve, Recover and retry, Launch / Play, and Recover and Relaunch, which spend money on a new run) never fire from the strip: it opens the panel and moves focus to the card's own control, which the person confirms. A run that needs the person without a declared action gets a specific way in ("See what failed", "See why it paused", "Open the decision"). Clicking the strip opens the run's full card as a panel anchored above the strip over the conversation (capped to the space above, so never clipped; not a modal: Esc or a click in the conversation closes it and focus returns to the strip). Every live card stays mounted (hidden) and reports its step and run vitals to the strip. Changes are announced politely ("Rail 1: Waiting for you: Ready for your review", "Rail 1 finished"). Motion only conveys state (strip morph and panel, 180–200 ms, none under reduced motion). Keyboard (`run-strip-keys.ts`, one app-wide `keydown` listener and a registry of mounted strips) is conversation-scoped: a shortcut acts on the strip of the mission containing the focused element, else the most recently focused mission (split views), else the most recently mounted. **⌥R** jumps to the strip (from the composer too; by physical key, so the Option character is not typed) and, pressed again inside it, shows or hides the details; **Esc** with nothing open returns focus to where ⌥R came from; **⌥[ / ⌥]** switch the shown run (announced "Showing Rail 1: …") only outside text fields, because Option+[ types a bracket on several layouts; **← / →** move along the switcher. A row control may claim one letter while the strip (not its panel) has focus with `data-strip-key` (Flow: P, H): never a global or destructive shortcut. ⌘/Ctrl combinations and keys inside other dialogs are left to the app; the floating mission panel counts as the mission's own surface. The toggle's tooltip and `aria-keyshortcuts` name ⌥R, switch tooltips name ⌥[ ⌥], and the app cheatsheet (`?`) lists them under Missions.
- **History** never repeats the live run: a live delivery's slot is `AgentRunLaunchedLine` ("Launched on Rail 1 · #4 #7 · loop"), the failure row is "Rail 1 failed: <plain words>", an undecided proposal is "Launch proposed — waiting for you"; each opens the run. A settled Implement delivery keeps its full card in the history; a settled Flow → Spec run is `AgentSettledRunLine` ("Delivered: PR #812", "… went back to Flow") that expands its card in place (the Flow's closing summary is the full card of that story).
- Focus bus: the history lines dispatch `FOCUS_PR_CARD_EVENT` scoped by `conversationId` (proposals use `OPEN_RUN_STRIP_EVENT`). The strip opens the matching live run's panel and re-dispatches once (`expanded: true`); a hidden card ignores the first dispatch; the visible card scrolls (`block: 'nearest'`, instant under reduced motion), takes focus as a labelled `region` (`tabIndex=-1`) and pulses (`motion-safe`). A settled Flow → Spec line expands its card the same way. An unknown run is a no-op.
- Mission list: `AgentChatContext.attentionConversationIds` (from `agent_pr_decision` envelopes and the open conversation's rows, `deliveryNeedsPerson`) marks missions waiting for the person with a dot and its words ("Waiting for your decision"). Extension runs feed the same dot with the strip's rule (`decision` or `failed` tone): an extension with an app-wide source (`MissionExtensions.useRunAttention`, Flow's per-project watch) reports every listed mission live, open or not, and the strip then leaves those runs to it; any other extension is reported by its mounted strip (`reportRunAttention`).
- `client/src/features/missions/context/AgentChatContext.tsx` — appends the `run-failure` row live on `agent_run_failure`; `AgentWorkspaceContext.tsx` / `AgentModeJobsPane.tsx` — `specrails:mission-open-run` opens the Jobs pane + `JobDetailModal`; `hooks/useOsNotifications.ts` — stays in Mission mode.
- Palette: `client/src/features/missions/lib/agent-context-palette.ts` (`rail` kind, `railsFromResponse`, `railChip`), `AgentComposer.tsx`, `AgentComposerEditor.tsx`, `AgentContextPalette.tsx`.

## Honesty rules

- Play is a user action: it never rides the agent tier ladder, and the server re-validates every launch (409s render inline; the card never pretends success).
- The card shows only real state: live runtime data wins over the settle snapshot; a run-only card says plainly that no PR phase exists; failure detail is text, never hover-only; nothing is estimated.
- The automatic failure turn is bounded: one per run (durable queueId), queued behind a live turn, accounted like any turn, forbidden from mutating in that turn, switchable off independently.
- A decision is final per proposal index; reload renders the frozen stub, never a second Play.

## Flags and rollback

| Flag | Default | Off means |
|---|---|---|
| `SPECRAILS_MISSION_RAIL_CARDS` | on | legacy prompt verbs, intent route 403, no run-only cards, no failure trigger |
| `VITE_FEATURE_MISSION_RAIL_CARDS` | on | `rail-launch` fences ignored, PR card renders exactly as before |
| `SPECRAILS_MISSION_FAILURE_TURN` | on | card + `run-failure` row still update, no automatic turn |

Migration 29 and the envelope fields are additive; persisted intents are inert when the feature is off.

## Deferred

- `job.stuck` → failure trigger: the stuck detector has no origin link (needs the rails meta map).
- QueueManager `/spawn` jobs: no origin, no card (unchanged).
- Per-step envelope updates while running: only launch → running and settle are emitted; the client reads live runtime meanwhile.
- One grouped card for `launch_all`: v1 emits N blocks.
- Translated `rationale` — the agent writes it in the conversation language.

## Test map

| Area | Tests |
|---|---|
| Parser + promotion + mirror parity | `server/modules/delivery/runtime/rail-launch-parser.test.ts` |
| Intent store/route, `dismissRunCard` | `server/agent-message-intent.test.ts` |
| Run-only cards, availability, run-card dismiss route | `server/modules/delivery/runtime/rails-router.test.ts`, `server/mcp/tools/rails-origin.test.ts` |
| Failure trigger / briefing / system turn | `server/modules/missions/runtime/mission-run-notify.test.ts`, `server/modules/missions/runtime/agent-failure-briefing.test.ts`, `server/agent-chat-mission-turn.test.ts`, `server/modules/delivery/runtime/rail-isolated-launch.test.ts` |
| MCP runtime actions | `server/mcp/tools/jobs-runtime.test.ts` |
| Launch card, proposals hook, stubs | `client/src/features/missions/components/__tests__/agent-rail-launch-card.test.tsx` |
| Run card phases / failure block / pinning / marker | `mission-run-card.test.tsx`, `mission-run-pinning.test.ts`, `agent-run-failure.test.ts`, `agent-run-failure-marker.test.tsx`, `agent-run-strip.test.tsx` (strip states, switcher, panel, primary action, history focus, inline surface), `mission-run-strip.test.ts` (tone/urgency/totals model) |
| Palette rails, Mission-mode notifications | `client/src/lib/__tests__/agent-context-palette-rails.test.ts`, `client/src/hooks/__tests__/useOsNotifications.mission-mode.test.ts` |
