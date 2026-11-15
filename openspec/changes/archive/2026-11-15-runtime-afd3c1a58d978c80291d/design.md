# Design

## Context

See proposal.md. Observed current state:
- `pr-ci-offer.ts` projects a `pr-ci-offer` system row keyed `pr-ci-offer:<deliveryId>` from `pr_draft`/`pr_ready` deliveries with an origin conversation; the CI-loop generation updates the row of the generation it replaced.
- `POST /rails/:railIndex/pr-ci` (`startPrCi` in `rails-router.ts`) validates the delivery, observes each PR (`observePrLifecycle`: OPEN, not cross-repository), clears the PR worktree, then rewrites the request into a normal `factory:pr-ci` loop launch through `launchRail` (continuation admission, rail ownership, `prCiLaunches` guard that blocks the generic door).
- `resolvePrCiTargets` (`pr-ci-target.ts`) builds `PrCiTarget`s only from `definition_delivery_settlements` snapshots of a delivery whose `loop_id` is `factory:pr-ci`.
- The handlers (`pr-ci-handlers.ts`: `observe`, `checkOne`, `sync`) already fail closed on fork PRs and never force-push or merge.
- `resolveExplicitPrTarget` (`active-pr-continuation.ts`) already validates a PR number as open, same-repo, with usable head/base and materializes the head; it rejects forks with `target_pr_fork`. The `explicit-pr-target` spec confirms this is intentional, so it applies unchanged.
- `launchRail` is rail- and ticket-oriented; a mission PR has neither.

## Goals / Non-Goals

**Goals:** a host-authoritative admission for PRs without deliveries that feeds the same handlers and recipe; one card experience; dedupe and reload-safe results.

**Non-Goals:** changing the repair algorithm, budgets or handlers' safety rules; fork support; merging; creating deliveries or specs for external PRs.

## Decisions

1. **New append-only table `pr_ci_admissions`** (migration at the end of `MIGRATIONS`). Columns: id, project_id, repository_id, repository_path, pr_number, pr_url, head_branch, head_sha, base_branch, origin_conversation_id, state (`offered|started|dismissed|green|no-ci|needs-attention`), run_id, reason, pushes, rounds, worktree_path, created_at, updated_at. A UNIQUE index on (project_id, repository_id, pr_number) over non-terminal-dismissed active states gives idempotent prepare; re-offering after a terminal state refreshes the same row. *Alternative:* fake a delivery row. Rejected: it would attribute the PR to Specrails, violate "do not synthesize prDeliveryId/railIndex" and risk corrupting delivery state.
2. **Repository resolution in the host.** Parse `https://github.com/<owner>/<repo>/pull/<n>`; match owner/repo against each project repository's `origin` remote (via `getProjectRepositories`); no match → `pr_repository_not_in_project`; ambiguous match → explicit error. The repoDir passed to `gh`/git is that repository's path, so a same-numbered PR elsewhere is never read. Repository identity is carried to the admission, never accepted from card/workflow text.
3. **Validation reuses `resolveExplicitPrTarget`-style ladder**, factored into a shared helper that takes a PR URL (the existing function takes a number and runs `gh pr view <n>`). Errors map to distinct codes; `gh` stderr classification separates auth/connection (`pr_github_unavailable`) from not-found (`target_pr_not_found`). Fork → `pr_fork_unsupported` with detail that fork branches cannot be pushed with the repository's origin rights.
4. **Offer boundary.** `pr-ci-offer.ts` gains `prepareExternalPrCiOffer` and key `pr-ci-offer:ext:<projectId>:<repositoryId>:<prNumber>`; `PrCiOfferRow` gets optional `admissionId`, `repositoryId`, `repository`, and `origin: 'delivery'|'mission'` while `prDeliveryId`/`railIndex` become optional only for mission-origin rows. Delivery-backed rows are byte-identical. Idempotency: `upsertSystemRow` by dedupe key plus the unique admission row.
5. **Start route** `POST /api/projects/:id/pr-ci/admissions/:admissionId/start` (not rail-scoped). Order: flag → Loops → Core capability (`supportsPrCi`) → load admission (project-scoped) → active-run exclusion (admission state `started` **or** an active delivery-backed `factory:pr-ci` delivery for the same repository PR; SQLite transaction claims `started` atomically so double clicks race to one winner) → re-validate PR and compare head branch/base with the admission (changed → refuse) → allocate an isolated worktree on the PR head via the existing worktree manager and register a frozen admission record → launch the `factory:pr-ci` loop through the loop run manager with the recipe from `loop-pr-ci-recipe.ts`, independent of the loop library. The claim is released with the stated reason if allocation or launch fails.
6. **`resolvePrCiTargets`** additionally looks up `pr_ci_admissions` by `(project_id, run_id)` and returns a `PrCiTarget` (deliveryId is a synthetic admission reference field named `admissionId` added alongside; `deliveryId` stays for delivery targets). Workflow input is still never consulted.
7. **Settlement.** A settlement hook mirrors `pr-ci-settlement.ts` for admissions: on run terminal event, derive state via `prCiTerminalState` inputs (host-task outcomes `pr.checks`/`pr.sync`), persist on the admission, and re-upsert the offer row. A startup replay pass re-settles admissions left `started` whose run is terminal, so reload and restart are consistent.
8. **Mission entry.** A new MCP action (`specrails_rails` action `ci-fix` or equivalent in `server/mcp/tools/rails.ts`) takes `prUrl` and posts the card; `agent-operator-prompt.ts` instructs the agent to use it when the user asks to repair a PR's CI, and to pass the explicit PR instead of `targetPrNumber` launches.
9. **Client.** `parsePrCiOfferRow` accepts mission-origin rows (requires `admissionId` + `repositoryId` when `prDeliveryId` is absent). `postPrCiLaunch` gains a sibling `postPrCiAdmissionStart` / dismiss and the card chooses by row origin. Terminal rows show state, reason and the run log button (the existing `JobDetailModal`) themselves, since `focusPrCard` has no delivery card for mission-origin rows. The in-flight `useRef` guard stays for double clicks. New strings are added to all eight locales.

## Risks / Trade-offs

- [Worktree allocation for a non-rail run may not fit `launchRail`] → reuse the worktree manager and isolated-launch primitives; if rail coupling is unavoidable, allocate a dedicated non-rail slot, covered by lifecycle tests.
- [Repo match by remote URL may be ambiguous (mirrors, SSH aliases)] → normalize host/owner/repo; refuse ambiguity explicitly rather than guess.
- [Duplicate paths racing: delivery-backed and mission-origin start] → both check the same exclusion inside one transaction/lock (`withRepositoryLock`).
- [Restart between claim and launch] → startup recovery releases claims whose run never existed.
- [Forks remain unsupported] → explicit message; supporting them would need a different write mechanism and is out of scope.
