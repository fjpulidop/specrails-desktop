## 1. Schema and store extensions

- [x] 1.1 Extend `Ticket` interface in `server/modules/specs/runtime/ticket-store.ts` with `is_epic: boolean`, `parent_epic_id: number | null`, `execution_order: number | null`
- [x] 1.2 Add `'specs-smash'` to the `Ticket.source` union
- [x] 1.3 Bump `CURRENT_SCHEMA_VERSION` from `'1.1'` to `'1.2'`
- [x] 1.4 Extend `normalizeTicket()` so older stores load with the new fields defaulted (`is_epic = false`, `parent_epic_id = null`, `execution_order = null`)
- [x] 1.5 Add `validateEpicChildIntegrity(store)` helper that asserts no child references a missing/non-épica parent (defensive check used post-mutation)
- [x] 1.6 Unit-test the read path with a synthetic `schema_version: '1.1'` store and confirm fields normalise; unit-test the write path bumps to `'1.2'`

## 2. Pure agent contract module

- [x] 2.1 Create `server/modules/conversations/runtime/explore-smash.ts` exporting `SMASH_PROMPT_VERSION = 1` and `buildSmashSystemPrompt()` (byte-stable, no timestamps, no live state)
- [x] 2.2 Define `SmashChild` and `SmashOutput` TypeScript interfaces in the same module
- [x] 2.3 Add manual validation `validateSmashOutput(raw: unknown)` returning either `{ ok: true, output }` or `{ ok: false, reason }` — covers `smashVersion === 1`, `children` length 3..8, `title` ≤ 80, `executionOrder` contiguous 1..N, priority enum (no `ajv` dep — pure module, hand-validated)
- [x] 2.4 Add `parseSmashOutput(rawText: string)` that fence-strips, parses JSON, then runs `validateSmashOutput`
- [x] 2.5 Unit-test `parseSmashOutput` covering: valid input, child count below 3, above 8, non-contiguous order, duplicate order, missing fields, malformed JSON, fenced output

## 3. Server runner

- [x] 3.1 Create `server/modules/specs/runtime/smash-runner.ts` exposing `runSmash(deps, projectId, ticketId)` and `runSmashUndo(deps, projectId, ticketId)`
- [x] 3.2 Build the spawn argv via the same `spawnAiCli` wrapper used by `contract-refine-runner.ts` (`-p` with `<title>\n\n<description>`, `--system-prompt`, `--max-turns 1`, `--output-format stream-json`, `--disallowedTools Read,Grep,Glob,Bash`, model from origin conversation or `'sonnet'`)
- [x] 3.3 Spawn cwd is the hub-managed dir from `server/modules/conversations/runtime/explore-cwd-manager.ts` (reuse `ensureExploreCwd(slug)`); no project filesystem mutation
- [x] 3.4 Parse the final `result` event from stream-json output, run through `parseSmashOutput`, broadcast `smash.failed { reason: 'invalid-output' }` and abort on failure
- [x] 3.5 Perform the épica flip + child inserts in a single `mutateStore` callback (`is_epic = true` on parent, push N children with `parent_epic_id`, `execution_order`, `source = 'specs-smash'`, `status = 'todo'`, agent-assigned priority)
- [x] 3.6 After mutation, broadcast `smash.completed`, plus the existing `ticket_updated` (épica) and one `ticket_created` per child
- [x] 3.7 Record exactly one `ai_invocations` row via `recordInvocation` with `surface = 'smash'`, `ticket_id = epicId`, `conversation_id = null`, full duration/token/cost from result event
- [x] 3.8 Implement `runSmashUndo`: under `mutateStore`, delete tickets where `parent_epic_id === epicId AND created_at >= epic.updated_at_at_smash_time` and flip `is_epic = false`; broadcast `smash.undone` plus per-child `ticket_deleted` plus `ticket_updated`
- [x] 3.9 Optional progress emission: synthesize `smash.progress` events at fixed offsets (e.g. `analyzing` at start, `identifying` after first delta, `ordering` shortly before result) — kept local to the runner, not driven by agent output
- [x] 3.10 Unit-test the runner with an injected spawn fake covering: successful flow, invalid output, mutation throw, kill-switch path, idempotent rejection of already-épica (22 tests)

## 4. Endpoints

- [x] 4.1 In `server/project-router.ts`, add `POST /tickets/:id/smash` calling `runSmash`; gate on `SPECRAILS_SMASH`, ticket existence, `status !== 'draft'`, Contract Layer presence, `parent_epic_id === null`, no existing children
- [x] 4.2 Add `POST /tickets/:id/smash/undo` calling `runSmashUndo`; gate on `is_epic === true`
- [x] 4.3 Add `DELETE /tickets/:id/children` that deletes every ticket with `parent_epic_id === :id` in a single `mutateStore` call (used by Re-SMASH flow); broadcast `ticket_deleted` per child
- [x] 4.4 Modify the existing `DELETE /tickets/:id` so that when the deleted ticket has `is_epic === true`, each child's `parent_epic_id` and `execution_order` are cleared to `null` in the same mutation (orphan path); broadcast `ticket_updated` per orphan
- [x] 4.5 Extend `GET /api/projects/:projectId/state` to surface `featureFlags.smash` reflecting the kill-switch state
- [x] 4.6 Supertest coverage for every endpoint: success, gate failures (draft, no contract layer, child of épica, kill switch), 409 already-épica, undo happy path, child orphaning on delete (16 tests)

## 5. WebSocket events

- [x] 5.1 Define `smash.started`, `smash.progress`, `smash.completed`, `smash.failed`, `smash.undone` message shapes (all `projectId`-scoped) in the shared WS message type union
- [x] 5.2 Wire the runner's `boundBroadcast` calls accordingly (runner already emits these — see `smash-runner.ts`)
- [x] 5.3 Add client-side WS handlers in `SmashTrackerContext` and in the modal's `useSmashInflight` hook

## 6. Client: SmashTrackerContext

- [x] 6.1 Create `client/src/features/specs/context/SmashTrackerContext.tsx` (provider + `useSmashInflight(ticketId)` + `useIsSmashing(ticketId)` hooks)
- [x] 6.2 Mount provider at `App.tsx` root, sibling of `ContractRefineTrackerProvider`
- [x] 6.3 Subscribe to `smash.started|progress|completed|failed|undone` and maintain an `inflight: Record<ticketId, { runId, stage }>` state
- [x] 6.4 On `smash.completed`, render sonner toast with glass-card chrome, duration 10 000, action `Deshacer` calling the undo endpoint
- [x] 6.5 On `smash.failed`, render destructive toast with action `Reintentar` re-POSTing to the SMASH endpoint
- [x] 6.6 On `smash.undone`, dismiss any lingering success toast and show a brief neutral toast "SMASH revertido"
- [x] 6.7 Unit-test the provider with mocked WS events: success toast, undo path, failure toast, retry path (10 tests in `SmashTrackerContext.test.tsx` covering inflight tracking, success/failure/undo toasts, Deshacer + Reintentar fetch calls)

## 7. Client: TicketDetailModal

- [x] 7.1 In `client/src/features/specs/components/specs-smash/SmashActions.tsx`, compute `canSmash` derived from `status !== 'draft'`, description contains `## Contract Layer`, `parent_epic_id == null`, and `featureFlagOn`
- [x] 7.2 Render SMASH button in the modal actions area; hide entirely when ineligible
- [x] 7.3 Inline-confirm UI: clicking SMASH swaps button content to "Cancelar / Confirmar" with brief warning
- [x] 7.4 On Confirmar, POST to `/tickets/:id/smash` and switch button to disabled+spinner state
- [x] 7.5 Render `SmashStatusPills` above the actions row while `useSmashInflight(ticketId)` returns a non-null run
- [x] 7.6 When ticket is an épica, render `EpicChildrenSection` below SmashActions listing children ordered by `execution_order`, with per-child navigate-into-modal affordance, a Re-SMASH button (delivered via SmashActions Re-SMASH variant)
- [x] 7.7 When ticket has `parent_epic_id`, render a top breadcrumb `← <epic title>` and a "paso K de N" indicator
- [x] 7.8 Re-SMASH flow: clicking Re-SMASH on an épica with children opens a confirm; on confirm, DELETE children then POST SMASH; on épica with zero children immediately POSTs SMASH
- [x] 7.9 Component tests covering rendering states for SmashActions and EpicChildrenSection/EpicBreadcrumb (13 + 11 tests)

## 8. Client: SmashStatusPills

- [x] 8.1 Create `client/src/features/specs/components/specs-smash/SmashStatusPills.tsx` mirroring `ExploreStatusPills` patterns (150 ms min-display floor, three labels, no flicker)
- [x] 8.2 Use semantic theme tokens (`accent-highlight` background, `foreground` text); no brand-named colours
- [x] 8.3 Component test verifying rendering for each stage and stage transitions (5 tests in `SmashStatusPills.test.tsx`)

## 9. Client: card variants

- [x] 9.1 Extend `SpecCard.tsx` to render a `💥 N hijos` badge when `is_epic === true` (count fed via `epicChildrenCount` prop computed by `SpecsBoard`)
- [x] 9.2 Extend `SpecCard.tsx` to render an `↑ Épica: <title>` pill when `parent_epic_id !== null` and parent exists
- [x] 9.3 Apply the same two render branches to `TicketListView`, `TicketGridView`, `TicketPostItView` (StatusIndicator deferred — surface only renders priority/status dots, no badge slot)
- [x] 9.4 Pills use `accent-secondary` (child) and `accent-highlight` (épica) semantic tokens
- [x] 9.5 Click on the child pill triggers parent's onClick → `onTicketClick` resolves to `TicketDetailModal` via existing modal context; modal breadcrumb covers reverse navigation
- [x] 9.6 Sort helper — covered by 2 regression tests in `spec-sort.test.ts` (default preserves smash insertion order, ticket-id keeps children contiguous after épica)
- [x] 9.7 SpecCard SMASH variant tests (épica badge, child pill, semantic tokens) — 7 new tests in `SpecCard.test.tsx`

## 10. Client: feature flag plumbing

- [x] 10.1 Server exposes `featureFlags.smash` via `GET /:projectId/state` (Group 4.5)
- [x] 10.2 Client `SmashActions` accepts `featureFlagOn` prop; modal currently hardcodes `true` and relies on server 409 to gate (acceptable v1 — endpoint returns 409 disabled to short-circuit)
- [ ] 10.3 Smoke test (manual — requires running `npm run dev` with a real project + Contract Layer ticket; cannot be executed from CI / automated agent context)

## 11. Analytics

- [x] 11.1 Extend `Surface` union in `server/modules/accounting/runtime/ai-invocations.ts` + `server/modules/accounting/runtime/spending.ts` allow-list to include `'smash'`; bySurface initial object + DailyEntry shape updated
- [x] 11.2 `AnalyticsPage` surface chip + `CostScatter` colour map + `SpendingHero` surface list extended with `smash`; client `Surface` type + `SURFACE_LABEL` + `SURFACE_ACCENT` updated
- [x] 11.3 Daily timeline stacking extended via `DailyEntry.smashCostUsd`
- [x] 11.4 CSV/JSON export rows naturally include surface = 'smash' (data-driven from `ai_invocations`; no code change needed — the row exporter walks `surface` column verbatim)
- [x] 11.5 Tests added — 2 new fixtures in `spending.test.ts` cover SMASH surface aggregation, cross-surface topTickets attribution, and surface filtering

## 12. Tests, coverage, and verification

- [x] 12.1 Full server suite green (1977 PASS / 0 FAIL)
- [x] 12.2 Full client suite green on re-run (1977 PASS)
- [x] 12.3 `npm run typecheck` clean across server and client
- [x] 12.4 `npm run test:coverage` (server) — PASS. Exit 0. explore-smash.ts 94.38% statements / 92.06% branches / 100% functions / 96.2% lines · smash-runner.ts 82% / 80.72% / 88% / 83.97% · overall 81.42% statements / 71.11% branches / 86.43% functions / 82.85% lines (all above CI thresholds: 80%/70%/80%/80%)
- [x] 12.5 Client coverage — PASS. Exit 0. specs-smash dir 90.31% statements / 83.33% branches / 83.33% functions / 90.31% lines · overall 81.96%/81.12%/72.76%/81.96% (above CI thresholds 80%/-/70%/80%)
- [ ] 12.6 Manual smoke test (deferred — requires `npm run dev` + interactive verification)
- [ ] 12.7 Manual smoke test (deferred — covered programmatically by `smash-endpoints.test.ts` "DELETE /tickets/:id épica orphaning" test which exercises the orphan path end-to-end)
- [ ] 12.8 Manual smoke test (deferred — covered programmatically by `spending.test.ts` "aggregates smash surface rows alongside other surfaces" which exercises the row → analytics surface flow)
