## 1. Protocol + persistence

- [x] 1.1 Define the `rail-launch` block contract (`server/modules/delivery/runtime/rail-launch-parser.ts` ⇄ `client/src/features/rails/lib/rail-launch-draft.ts`): schema v1, tolerant JSON via `json-tolerant`, unknown keys dropped, `rejected[]`/`truncated`, fence promotion for local engines; unit tests both sides
- [x] 1.2 Desktop-db migration: nullable `agent_messages.intent` JSON; `agent-store.ts` read/write; `PATCH /api/agent/conversations/:id/messages/:mid/intent` (validated `rail-launch` intent shape) + tests
- [x] 1.3 Extend `PrDecisionCardEnvelope` with optional `runIds`, `railIndex`, `phase`, `runtime` (status, step, canResume, recoverableSteps, pendingApproval, failure{code,detail,stepId}); keep `decision` vocabulary; mobile translation ignores new fields; tests
- [x] 1.4 Feature flags `SPECRAILS_MISSION_RAIL_CARDS` / `VITE_FEATURE_MISSION_RAIL_CARDS` and `SPECRAILS_MISSION_FAILURE_TURN` (default on) in `feature-flags.ts` + server helpers

## 2. Server: launch origin, run card, failure trigger

- [x] 2.1 `rails-router.ts`: shared-cwd branch posts a run card (`postPrDecisionCard` with `prDeliveryId: null`, run ids) when `originConversationId` is present; 202 payload carries `runIds` + `railIndex`
- [x] 2.2 `rails-router.ts` / `rails-store.ts`: rails list returns `availability: free|busy|pending_decision|on_review`
- [x] 2.3 `server/modules/missions/runtime/mission-run-notify.ts` `notifyMissionRunFailure(ctx, …)`: envelope update + `system` row `{kind:'run-failure'}` + auto-turn enqueue (dedup per run id, queue while streaming, flag-gated); wired from `onLoopRunFinished`/`onJobFinished` (failed/stalled/provider_limit), the isolated settle path, and `stuck-run-detector`; tests
- [x] 2.4 `agent-failure-briefing.ts`: fixed briefing builder (run, rail, tickets, failure code+detail, verify tail if harvested, recovery options, "do not relaunch by yourself"); `AgentChatManager.startSystemTurn` accounted in `agent_invocations`; one-per-run guard; tests
- [x] 2.5 Running-phase updates: `updatePrDecisionCard` on run start/step change/settle so the card's snapshot reflects phase transitions (throttled); tests
  <!-- WIP: run start (phase running) + settle are wired (postRunCard/settleRunCard, isolated envelopes carry `phase`); per-STEP card updates are NOT emitted — the client prefers live useRuntimeRuns/WS data while running, so this is deliberately deferred. -->
- [x] 2.6 `rail-isolated-launch.ts` settle: `discarded`/`implementation_failed` envelopes carry `statusDetail` + unit failure codes in `runtime.failure`

## 3. MCP + operator prompt

- [x] 3.1 `server/mcp/tools/jobs.ts`: `runtime_runs`, `runtime_evidence` (read), `runtime_resume`, `runtime_recover` (ai-spawn), `runtime_approve`, `runtime_settle`, `runtime_dismiss` (write) over `agent-runtime-controls-router`; `specrails_describe` schemas; tests
- [x] 3.2 `server/mcp/tools/rails.ts`: `list` surfaces `availability`; guide text updated
- [x] 3.3 `agent-operator-prompt.ts`: propose = `rail-launch` block (contract + example), launch tool only on explicit "launch now", failure-turn conduct (explain ≤ 6 lines, act only on confirmation); prompt snapshot tests

## 4. Client: rail launch card

- [x] 4.1 `AgentMessage` extracts `rail-launch` blocks (last-valid-wins, streaming tail cut) and renders `AgentRailLaunchCard`; unreadable → muted note
- [x] 4.2 `AgentRailLaunchCard.tsx`: card chrome per mission conventions; live reconciliation (rails, tickets, `useProviderDetection`, models, profiles, loops); selectors reused (`RailEngineSelector`, `RailProfileSelector`, `RailTargetPrSelector`, loop picker, `AgentToolbarSelector`); "New rail" option; busy/stale/missing degradation pills
- [x] 4.3 Play flow: create rail (if new) → PUT tickets/engine/profile/name → POST launch with origin; in-flight disable; inline 400/409 rendering; on 202 patch message intent and hand off to the run card
- [x] 4.4 Frozen states: launched stub ("Launched → Rail N", link to run card) and dismissed stub, read from persisted intent
- [x] 4.5 Pinned dock: proposal cards pinned; unpin on launched/dismissed

## 5. Client: run card lifecycle

- [x] 5.1 `AgentPrDecisionCard` phase rendering: launched/running header (status pill, live elapsed via `job-run-model.ts`, phase·activity, log chips → `JobDetailModal`, Stop) before the existing delivery UI; shared-cwd "no PR phase" note
- [x] 5.2 Failure rendering: `statusDetail` + failure codes as text for `discarded`/`implementation_failed`/stalled/provider_limit; runtime actions (Resume, Recover & retry, Approve, Relaunch, Discard) via `useRuntimeRuns` + decision endpoint, reconciled to broadcast
- [x] 5.3 `agent-pr-pinning.ts`: pin on proposal/running/failed phases; unpin on terminal
- [x] 5.4 `AgentChatContext`: handle run-failure system rows and envelope phase updates; render compact failure marker in history
- [x] 5.5 Notification click targets (`useOsNotifications`, `useMilestoneNotifications`) stay in Mission mode when the run has an origin mission (open the mission + card instead of navigating to `/jobs/:id`)

## 6. Palette + i18n + docs

- [x] 6.1 `agent-context-palette.ts` / `AgentContextPalette`: `rail` kind, `@rail-N` rows from `GET /rails`, chip tone, serialization in `buildAgentContextBlock`; tests
- [x] 6.2 i18n `agent:railCard.*`, `agent:runFailure.*`, palette/rail strings ×8 locales; parity test green
- [x] 6.3 Docs: CLAUDE.md (mission rail cards section), `docs/internals/mission-rail-cards.md`, in-app guide `docs/guide/<lang>/integrations/6-agent-chat.md` ×8, `docs/mcp.md` new actions

## 7. Verification

- [x] 7.1 Server tests: parser, intent route, notify chokepoint (all outcome paths, dedup, flag off, untagged), MCP actions + tiers, rails availability, shared-cwd card posting
- [x] 7.2 Client tests: card render/edit/play/409/frozen, run-card phases + failure actions, pinning, palette rail chips
- [x] 7.3 `npm run typecheck`, `npm test`, `npm run test:coverage` (server ≥ 80%), `cd client && npm run test:coverage` (client ≥ 80%)
- [ ] 7.4 Manual smoke in Mission mode: propose → edit → Play (existing rail, new rail, no-git project) → running → forced failure → auto-turn → resume from card; check all 8 locales render
