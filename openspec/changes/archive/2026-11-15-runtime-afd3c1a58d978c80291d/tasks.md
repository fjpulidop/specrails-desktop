# Tasks

## 1. Admission store and PR resolution

- [x] 1.1 Append a migration in `server/db/migrations.ts` creating `pr_ci_admissions` with the unique project/repository/PR index; verify with a case in `server/db.test.ts` (fresh and upgraded DB) and `npx vitest run server/db.test.ts`.
- [x] 1.2 Add an admission store and a PR-URL resolver (project repository match by origin remote, explicit-target validation ladder, distinct codes for outside-project, closed/merged, fork, incompatible refs, and GitHub auth/connection failure) under `server/modules/delivery/runtime/pr-ci/`; verify with unit tests using stubbed `gh` output including a secondary repository with a colliding PR number, a fork PR and an auth failure.

## 2. Offer, target and start

- [x] 2.1 Extend `pr-ci-offer.ts` with mission-origin preparation, the project+repository+PR dedupe key and row shape (delivery-backed rows unchanged); verify with `pr-ci-offer.test.ts` cases for idempotent repeat prepare and a delivery-backed regression.
- [x] 2.2 Extend `pr-ci-target.ts` so `resolvePrCiTargets` resolves targets from persisted admissions; verify tests prove workflow input cannot override `repositoryId`, branch or PR.
- [x] 2.3 Add the admission start and dismiss routes in `rails-router.ts` (flag, capability, atomic claim, cross-path active-run exclusion, PR re-validation, isolated worktree on the PR head, canonical `factory:pr-ci` recipe launch, claim release on failure); verify with route tests: no job/worktree on prepare, single run on concurrent double start, refusal when a delivery-backed run is active, refusal when head/base changed, nothing pushed to another branch.
- [x] 2.4 Add settlement and restart replay for admissions (green, no checks, needs-attention with reason, pushes, rounds; re-upsert offer row); verify with `pr-ci-settlement.test.ts` cases and a reload/replay test that returns the same state; confirm no merge or spec/ticket status change.

## 3. Mission entry point

- [x] 3.1 Add the mission MCP action that prepares an offer from a PR URL in `server/mcp/tools/rails.ts` and update `agent-operator-prompt.ts`; verify with MCP tool tests: pinned project only, card posted, no agent started.

## 4. Client

- [x] 4.1 Extend `delivery/lib/pr-ci.ts` with admission start/dismiss transport; verify with a client unit test of request shape and failure mapping.
- [x] 4.2 Extend `AgentPrCiOfferCard.tsx` parsing and rendering for mission-origin rows (repository + PR identity, state, reason, run log, double-click guard) and add strings to all locales; verify with `npm run test --prefix client -- AgentPrCiOfferCard` covering offered, started, green, no-ci, needs-attention, and delivery-backed regression.

## 5. Integration and docs

- [x] 5.1 Add an integration test with controlled GitHub and runtime responses covering prepare from a mission, secondary repository, start without prior delivery, persisted result after reload, duplicate prevention, validation errors and the delivery-backed regression; verify with `npx vitest run server/modules/delivery`.
- [x] 5.2 Update `server/modules/delivery/README.md`, `docs/internals/mission-rail-cards.md`, `docs/internals/api-reference.md` (new routes, error codes, fork limitation), boundary manifests if touched, and run `npm run docs:source-map`; verify `npm run audit:architecture` passes.
- [x] 5.3 Run the full gate for the touched trees; verify `npm run typecheck`, `npx vitest run server/modules`, and `npm run test --prefix client -- src/features/missions src/features/delivery` pass.
