# Tasks — deliver rail into an existing PR (explicit target)

## 1. Server — explicit target resolver

- [x] 1.1 Add `resolveExplicitPrTarget(...)` to `server/active-pr-continuation.ts`: `gh`-backed `observePrLifecycle` on the designated PR number → validation ladder (`target_pr_not_found` / `target_pr_not_open` / `target_pr_fork` on `isCrossRepository !== false` / `target_pr_invalid` / `target_pr_unfetchable`) → `materializeTarget(...)` pinned to the observed `headRefOid` → one `ActivePrContinuationTarget` with new `source: 'explicit-target'`.
- [x] 1.2 Extend the `source` union and any exhaustive switches; keep automatic-path gates (`canProbeGithubForContinuation`, `PR_MATCH_RANK`) untouched.
- [x] 1.3 Unit tests: each ladder failure code, `baseRefName` wins over integration branch, fork-null rejected, success materializes pinned branch.

## 2. Server — launch integration

- [x] 2.1 `server/rail-isolated-launch.ts`: accept `explicitPrTarget?: { prNumber: number }`; when present, skip `resolveActivePrContinuationTargets` and apply the explicit target to every launch ticket (existing unique-key + single-checkout collapse reused); resolution failure throws before `createPrDeliveryGeneration` — no row, no worktree, no overlay.
- [x] 2.2 Confirm the generation is born attached (`pr_url`/`pr_number` at insert, `isContinuation: true`, unit `branchOwnership: 'borrowed-pr'`) — extend `createPrDeliveryGeneration` inputs only if a gap is found.
- [x] 2.3 Tests: explicit target from a `todo` ticket materializes PR head worktree; validation failure leaves zero branches/worktrees/rows; `pr_decision_pending` still wins before resolution; multi-ticket launch collapses onto one checkout.

## 3. Server — router + candidates endpoint

- [x] 3.1 `server/rails-router.ts` launch route: validate optional `targetPrNumber` (positive int ≤ 1e9 → else 400 `invalid_target_pr`); 400 `target_pr_requires_pr_mode` when the launch would not take the isolated PR path; thread into `launchIsolatedRail`.
- [x] 3.2 Add `GET /rails/:railIndex/pr-candidates`: reuse the existing matchers (PR-number mention + Jira key) WITHOUT the status gate, returning `{ number, title, headRefName, baseRefName, isDraft, isCrossRepository, url }[]`; display-only, no side effects.
- [x] 3.3 Route tests: validation codes, candidates shape, fork candidates flagged.

## 4. MCP + operator prompt

- [x] 4.1 `server/mcp/tools/rails.ts`: `launch` action accepts optional `targetPrNumber`, forwarded to the POST body; surface the new 4xx codes as LLM-readable refusals.
- [x] 4.2 Operator prompt (`server/agent-operator-prompt.ts`): teach "user names an existing PR → pass targetPrNumber; never create a duplicate PR".
- [x] 4.3 Tests for the tool schema + pass-through.

## 5. Client — launch affordance

- [x] 5.1 Rail launch flow (`DashboardPage`/`RailsBoard` header): "Deliver into existing PR…" affordance → picker fed by `GET /pr-candidates` (fork rows disabled with reason) + manual PR-number field; selection sets `targetPrNumber` on the launch call; never auto-selects.
- [x] 5.2 Confirm dialog names the PR number, title, and head branch before launching.
- [x] 5.3 Surface the new launch error codes as toasts; delivery card states need no changes (attached-PR presentation already exists).
- [x] 5.4 i18n: new keys (picker, confirm copy, 5 error codes) in ALL 8 locales; key-parity test green.
- [x] 5.5 Client tests: picker renders candidates, fork disabled, manual entry validation, launch body carries the field.

## 6. Verification

- [x] 6.1 `npm run typecheck` + full `npm test` green.
- [x] 6.2 Coverage thresholds hold (70% global / 80% server / 80% client) — add tests until they do.
- [x] 6.3 `openspec validate deliver-rail-into-existing-pr --strict` passes.
- [x] 6.4 Docs: extend `docs/internals/safe-pr-review-flow.md` with the explicit-target mode; CLAUDE.md safe-PR section bullet.
