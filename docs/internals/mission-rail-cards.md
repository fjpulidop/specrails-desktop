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

- **Proposal** — an assistant message with one or more fenced `rail-launch` blocks. Each block is one `AgentRailLaunchCard`; undecided proposals are pinned in the dock above the composer.
- **Launched** — Play succeeded (202). The proposal freezes into a "Launched → Rail N" stub (persisted on the message row), and the run card takes over.
- **Running / settled / delivery** — the SAME envelope (`PrDecisionCardEnvelope`) carries `phase`, `runtime` and `hasDelivery`. With git, the delivery phase is the pre-existing PR-decision card. Without git, the card is run-only and ends at `completed` / `implementation_failed` / `discarded`.

## Protocol contract

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
- unknown keys dropped; `ticketIds` accepts `12`, `"12"`, `"#12"` (also under `specs` / `tickets`); `mode` accepts `batch` for `batch-implement`, `newRail: true` for an unnamed rail; `railIndex` is ignored when `newRail` is set;
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
- `client/src/features/rails/lib/rail-launch-intents.ts` — session overlay (`recordLocalIntent`, `intentFor`); `useRailLaunchProposals.ts` — undecided proposals for the dock; `AgentPrPinnedDock.tsx` — proposals pinned above PR cards.
- `AgentPrDecisionCard.tsx` — run phase header (`deriveMissionRunStatus`, live `useRuntimeRuns` first), run-only rendering for `hasDelivery === false`, `RunFailureBlock`, Resume / Approve / Recover / Relaunch, focus-bus scroll + flash.
- `agent-pr-pinning.ts` `isPrEnvelopePinned`; `agent-run-failure.ts` (`parseRunFailureRow`, `systemBriefingRunId`, `FOCUS_PR_CARD_EVENT`, `MISSION_OPEN_RUN_EVENT`, `requestMissionOpenRun`); `AgentRunFailureMarker.tsx`.
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
| Run card phases / failure block / pinning / marker | `mission-run-card.test.tsx`, `mission-run-pinning.test.ts`, `agent-run-failure.test.ts`, `agent-run-failure-marker.test.tsx` |
| Palette rails, Mission-mode notifications | `client/src/lib/__tests__/agent-context-palette-rails.test.ts`, `client/src/hooks/__tests__/useOsNotifications.mission-mode.test.ts` |
