## 1. Domain and runtime

- [x] 1.1 `server/modules/specs/domain/triage.ts`: record types, canonical JSON, bounded ticket text, content signature, similar tickets, prompt, parse/repair, size fallback, rail recommendation, accuracy (+ tests)
- [x] 1.2 Architecture rule `specs/domain/triage.ts: []`, boundary manifest regenerated
- [x] 1.3 `runtime/triage-runner.ts`: one pure-output provider turn with timeout, abort, partial usage
- [x] 1.4 `runtime/triage.ts`: engine resolution (triage role → primary cheapest priced model), inputs (repo map, provenance, loops, Flow), sha256 hash, unavailable path, failed path, write-back without touching `updated_at`, `ai_invocations` surface `triage` (+ tests)
- [x] 1.5 `ticket-store.ts`: `metadata.triage` typed; schema stays 1.5 (bumped by Flow on this stack)

## 2. Triggers, route, accounting

- [x] 2.1 `SpecTriageService` broadcast tap: debounced scan, seeded signatures, draft/todo only, one at a time, kill switch `SPECRAILS_SPEC_TRIAGE` (+ tests)
- [x] 2.2 Composition in `project-registry.ts` and teardown on remove/shutdown
- [x] 2.3 `POST /:projectId/tickets/:id/triage` (+ route tests)
- [x] 2.4 `triage` accounting surface (server breakdowns, client label/accent/scatter/hero, 8 locales)
- [x] 2.5 `triage` role in `loop-role-engines.ts`

## 3. Delivery recording

- [x] 3.1 Migration 74: `rail_pr_deliveries.recommended_loop`, `chosen_loop`
- [x] 3.2 `loopChoice` threaded from the launch route through `launchIsolatedRail` / multi-repo into the delivery row (+ route test)
- [x] 3.3 `getTriageAccuracy(db, { since? })` (+ store test)

## 4. Client

- [x] 4.1 `lib/spec-triage.ts` types, tolerant readers, recommendation rule, Recalculate (+ tests)
- [x] 4.2 `SpecTriageChip` on `SpecCard` with tooltip, flags, likely files and Recalculate; ghost action for untriaged draft/todo specs (+ tests)
- [x] 4.3 `effectiveLoopId` recommendation fallback + `offeredRecommendation`; `RailRow` preselection, `RailLoopSelector` recommended marker, `DashboardPage` launch parity (+ tests)
- [x] 4.4 `AgentRailLaunchCard` structured triage instead of prose rationale (+ tests)
- [x] 4.5 i18n `specs` / `dashboard` / `agent` / `analytics` × 8

## 5. Docs

- [x] 5.1 `docs/internals/spec-triage.md`, internals index, `configuration.md` (roles + flag), `api-reference.md`
- [x] 5.2 Module READMEs and source map
