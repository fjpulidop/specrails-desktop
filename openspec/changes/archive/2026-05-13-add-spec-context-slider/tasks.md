## 1. Server: ContextScope extension

- [x] 1.1 Extend `ContextScope` in `server/modules/conversations/runtime/context-scope.ts` with `contractRefine: boolean`
- [x] 1.2 Update `normalizeContextScope` to default missing `contractRefine` to `false`
- [x] 1.3 Update `defaultBootScope` signature to accept the project's `contractRefineEnabled` boolean and seed the field
- [x] 1.4 Update all internal call-sites of `defaultBootScope` (chat-manager, project-router conversation creation) to pass the new arg
- [x] 1.5 Unit tests in `server/modules/conversations/runtime/context-scope.test.ts` for the new field: defaults, round-trip, normalisation of legacy missing field
- [x] 1.6 Update `buildScopedSystemPromptPrefix` (no behavioural change needed, but ensure passes typecheck and ignores `contractRefine` for prompt content)

## 2. Server: from-draft hook reads from scope

- [x] 2.1 In `server/modules/specs/runtime/contract-refine-runner.ts` introduce a `scope-disabled` early-return reason
- [x] 2.2 Switch the gate inside `runContractRefine` so it consults `conversation.context_scope.contractRefine` first; only fall back to `getExploreContractRefineEnabled` for rows whose `context_scope` is null entirely
- [x] 2.3 Update `server/modules/specs/runtime/contract-refine-runner.test.ts` with cases for: scope `false` skips (logs `scope-disabled`); scope `true` runs even when project setting is `false`; legacy null scope falls back to project setting
- [x] 2.4 Keep the retry endpoint (`POST /tickets/:id/contract-refine`) gated on the project setting + kill switch (no change); add a regression test in `server/project-router.test.ts` confirming retry still succeeds for a ticket whose origin scope had `contractRefine=false`

## 3. Server: Quick mode refine path

- [x] 3.1 Extend `POST /tickets/generate-spec` request body validation to accept `contractRefine?: boolean`
- [x] 3.2 After the ticket is persisted, when `contractRefine && projectSetting && !killSwitch`, schedule a Quick variant of `runContractRefine`
- [x] 3.3 Add a `runContractRefineForQuick(deps, ticketId, generatedTitle, generatedDescription)` helper in `server/modules/specs/runtime/contract-refine-runner.ts` that spawns claude WITHOUT `--resume`, with a one-shot system prompt augmented with the spec body, and records `ai_invocations` as `surface='quick-spec'`, `conversation_id=null`, `ticket_id=<new>`
- [x] 3.4 Reuse the same parser, renderer, PATCH path, and WS events as the Explore-path refine
- [x] 3.5 Tests in `server/modules/specs/runtime/contract-refine-runner.test.ts` for the Quick path: success, failure modes, kill-switch and project-setting gating, `ai_invocations` `surface='quick-spec'` recorded
- [x] 3.6 Update `server/project-router.test.ts` so the `generate-spec` test covers the `contractRefine: true` request-body field firing a refine
- [x] 3.7 Document the Quick refine path in `CLAUDE.md` (small addition under the existing Explore Contract Refine section)

## 4. Server: add_spec_context_scope_last + per-project Quick last value

- [x] 4.1 Document `contractRefine` as a recognised field of the `add_spec_context_scope_last` JSON (it is already free-form on the server; no code change needed)
- [x] 4.2 Add a per-project last value for the Quick toggle: new key `config.add_spec_quick_contract_refine_last` in `queue_state` (boolean). Add `getQuickContractRefineLast` / `setQuickContractRefineLast` helpers in `server/db.ts`
- [x] 4.3 REST: `GET /api/projects/:projectId/add-spec-quick-contract-refine-last` and `PATCH ...` mirroring the existing `explore-mcp-enabled` shape
- [x] 4.4 Tests for the new endpoints (default false, round-trip, 400 on non-boolean)

## 5. Client: ContextScopeSlider component

- [x] 5.1 New file `client/src/features/chat/components/ContextScopeSlider.tsx` with: 6-stop rail, drag thumb, snap on release, keyboard `←/→/Home/End`, ARIA `role="slider"`, click-on-stop to jump
- [x] 5.2 Internal preset table mapping `(stopIndex 0..5) → { specrails, openspec, full, mcp, contractRefine, costSummary, label }`
- [x] 5.3 Props: `value: ContextScope`, `onChange: (next: ContextScope) => void`. Derive thumb position from `value`; emit a new `ContextScope` on snap.
- [x] 5.4 Render the `Custom` pill when `value` matches no preset (compare booleans exactly)
- [x] 5.5 Render the active cost-summary line under the rail
- [x] 5.6 Reset-to-default button `↺` (UX call during implementation; optional but recommended) — when present, restores `defaultBootScope` from a `projectDefaults` prop
- [x] 5.7 Vitest + jsdom tests for the slider: keyboard nav, click-on-stop, drag-and-release (pointer events), Custom indicator on off-preset combo, preset → boolean derivation table

## 6. Client: ProposeSpecModal integration

- [x] 6.1 In Explore mode, replace the existing context-scope checkbox row with `<ContextScopeSlider>` bound to the same `contextScope` state
- [x] 6.2 Add the `▾ Fine-tune` disclosure below the slider that renders the same five flags as toggles (specrails, openspec, full, mcp, contractRefine), styled identically to Settings toggles (`shrink-0`, `h-5 w-9`, theme tokens)
- [x] 6.3 Persist `contractRefine` in the `add_spec_context_scope_last` payload (extend the existing PATCH body)
- [x] 6.4 On modal open, boot order: per-project `add_spec_context_scope_last` if present → `defaultBootScope` derived from the two project toggles (`explore_mcp_enabled` + `explore_contract_refine_enabled`)
- [x] 6.5 Component tests for the modal: slider visible in Explore only, Fine-tune toggles round-trip, last value rehydrates, boot defaults from project settings

## 7. Client: Quick mode Contract Refine toggle

- [x] 7.1 In Quick mode, render a single toggle "Enrich with Contract Layer" below the model picker
- [x] 7.2 New `useQuickContractRefineLast(projectId)` hook that calls the new GET/PATCH endpoints
- [x] 7.3 Boot order: last value if present → project setting `explore_contract_refine_enabled`
- [x] 7.4 Include `contractRefine` in the `POST /tickets/generate-spec` request body
- [x] 7.5 Component tests: visible only in Quick mode, persists last value, submits in request body

## 8. Client: Settings card label change

- [x] 8.1 In `SettingsPage`, change the Contract Refine toggle label to "Default for new Explore specs"
- [x] 8.2 Update the helper copy to explain the value seeds the modal + gates retries
- [x] 8.3 Update the existing `SettingsPageExtended.test.tsx` if the copy is asserted

## 9. Polish, gates, docs

- [x] 9.1 Update `CLAUDE.md` `### Explore Contract Refine` subsection with the per-conversation gating, the slider, and the Quick path
- [x] 9.2 Run `npm run typecheck`, `npm test`, `npm run test:coverage` (server) and `cd client && npm run test:coverage` (client) until all green; iterate on tests if coverage drops below 80%/70%
- [ ] 9.3 Manual smoke test in `npm run dev`:
   - Open Add Spec → Explore → drag slider end-to-end, verify Fine-tune mirrors, verify `Custom` pill appears when toggling individual flags
   - Commit at `Max`, verify Contract Layer appears in modal disclosure after toast
   - Commit at `Standard`, verify NO Contract Layer (per-conversation `contractRefine=false`)
   - Switch to Quick, toggle ON, submit a Quick spec, verify Contract Layer added
   - Verify Settings page copy reads correctly
