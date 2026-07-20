# Design — deliver rail into an existing PR (explicit target)

## Context

The active-PR continuation engine (`server/active-pr-continuation.ts`) already resolves an external open GitHub PR into an `ActivePrContinuationTarget` (`source: 'github-open-pr'`), verifies it through the authoritative `observePrLifecycle` view (which already returns `isCrossRepository`), materializes the head branch locally (`materializeTarget`), and hands it to `launchIsolatedRail`, which collapses multi-ticket launches onto one checkout, records the delivery row with `isContinuation`, uses the PR's `baseRefName` as `base_branch`, and settles by pushing to the borrowed branch under `branchOwnership: 'borrowed-pr'`. Both decision surfaces already render attached-PR states, and cleanup ownership rules already protect borrowed PRs.

What is missing is purely the **front door**: automatic discovery is (by spec) inference-only and hard-gated — `canProbeGithubForContinuation` requires ticket status `on_review` (or `in_progress` + Jira link), and matching requires a PR-number mention in the spec text or a Jira key. A `todo` ticket launched from the board never probes GitHub, so "extend PR #151" written in a spec produces a fresh branch off the integration branch and a duplicate PR.

## Goals / Non-Goals

**Goals:**

- Let the user explicitly designate one existing open PR as the delivery destination at launch time (`targetPrNumber`), from both the dashboard launch flow and the MCP `specrails_rails(launch)` tool.
- Fail closed at launch with a precise, user/LLM-readable reason when the designated PR is not usable (not found / not open / fork / invalid refs) — never silently fall back to a fresh branch.
- Reuse the existing continuation machinery end-to-end (lifecycle observation, materialization, single-checkout batching, `borrowed-pr` ownership, attached-PR decision card, discard-preserves-PR).
- Offer candidate PRs in the launch UI as suggestions (display-only reuse of the existing matchers, no status gate for suggestions).

**Non-Goals:**

- Pushing to fork-based PRs (rejected at launch; requires push rights on the fork remote — out of scope).
- More than one target PR per launch (the delivery row models one PR URL; the existing single-target collapse stays).
- Relaxing the automatic-inference gates (`canProbeGithubForContinuation` and `PR_MATCH_RANK` are untouched for the automatic path).
- A background PR watcher; poll-merge stays click-driven.

## Decisions

### D1 — Explicit target rides the existing continuation pipeline, not a new path

`launchIsolatedRail` gains an `explicitPrTarget?: { prNumber: number }` input (threaded from the router). When present, a new resolver `resolveExplicitPrTarget(exec, git, db, repoDir, prNumber, integrationBranch, fetchOk)` in `active-pr-continuation.ts` produces one `ActivePrContinuationTarget` (new `source: 'explicit-target'`) that is applied to **every** ticket in the launch, replacing the `resolveActivePrContinuationTargets` call entirely for that launch. Everything downstream (unique-key check, single-checkout collapse, `createPrDeliveryGeneration` with `isContinuation: true`, verify/settle/push, ownership) is reused byte-identically.

*Alternative considered*: relaxing `canProbeGithubForContinuation` when a launch flag is set — rejected because inference matching (spec text mentions) is the wrong authority when the user has already named the PR; explicit designation must not depend on the spec text containing `#151`.

### D2 — Validation ladder is authoritative-view-only, fail-closed

The resolver runs `observePrLifecycle` (`gh pr view <n> --json …` — the existing field set already includes `state`, `isDraft`, `headRefName`, `baseRefName`, `headRefOid`, `isCrossRepository`) and rejects with distinct machine-readable codes surfaced as launch 4xx errors:

| Check | Failure code |
| --- | --- |
| PR not found / gh error | `target_pr_not_found` |
| `state !== 'OPEN'` | `target_pr_not_open` (includes actual state) |
| `isCrossRepository === true` (or null — cannot prove same-repo) | `target_pr_fork` |
| invalid head/base branch names, missing `headRefOid` | `target_pr_invalid` |
| `materializeTarget` cannot fetch/pin the head branch locally | `target_pr_unfetchable` |

The PR's `baseRefName` wins over the configured integration branch (same rule as automatic continuations). No delivery row is inserted and no worktree is allocated on rejection.

*Alternative considered*: warning + fallback to a fresh branch — rejected; a silent fallback recreates the duplicate-PR problem the change exists to fix.

### D3 — Router contract and relaunch guard

`POST /rails/:i/launch` accepts optional `targetPrNumber` (positive integer ≤ 10^9; anything else → 400 `invalid_target_pr`). It composes with the existing guards unchanged (`pr_decision_pending`, `tickets_in_flight`). `targetPrNumber` is only honored when the launch takes the isolated PR path (prMode + isolation); otherwise 400 `target_pr_requires_pr_mode`. The MCP `specrails_rails(launch)` schema gains the same optional field (tier unchanged — ai-spawn), and the operator prompt teaches: "when the user names an existing PR, pass targetPrNumber; never create a duplicate PR".

### D4 — Candidate suggestions are display-only and gate-free

A new read endpoint `GET /rails/:i/pr-candidates` returns open PRs matched to the rail's tickets by the existing matchers (`mentionedPrNumbers` + Jira-key match) **without** the status gate, plus the PRs' identity (`number`, `title`, `headRefName`, `isCrossRepository`, `isDraft`). The client launch flow (rail header) shows them in a small picker ("Deliver into existing PR…"); picking one sets `targetPrNumber` on the launch body. Suggestions never auto-select — explicit click only. Fork candidates render disabled with the fork reason. i18n ×8.

*Alternative considered*: free-form PR-number input only — kept as well (the picker includes a manual number field), but suggestions remove the lookup friction that caused today's duplicate.

### D5 — Delivery row is born attached

`createPrDeliveryGeneration` already receives the continuation target; for explicit targets the row records `pr_url`/`pr_number` at insert (as automatic continuations already do), `isContinuation: true`, and unit `branchOwnership: 'borrowed-pr'`. Settle pushes to the PR head branch; the card renders the existing attached-PR states ("Pushed to PR #N", poll-merge, Verify PR) with zero new client state — `RailPrDecisionStrip` and `AgentPrDecisionCard` are unchanged except i18n for the new launch-time error codes.

### D6 — Spec-level authority split

`implementation-delivery-lifecycle`'s "no fuzzy external-PR inference" rule is re-scoped: it governs *automatic discovery*; **explicit user designation** is a first-class continuation source ranked above inference and history (it is the user's answer, not a guess). Ledger conflicts still win safety-wise: if an ACTIVE delivery row already touches a requested ticket, the launch keeps failing `pr_decision_pending` before target resolution runs.

## Risks / Trade-offs

- [PR head moves between validation and settle] → already handled: `verifyContinuationWorktree` + the settle-time push verify the frozen `headRefOid`; a moved head fails the push with the existing "Retry push" reconciliation path rather than force-pushing.
- [User designates a PR unrelated to the tickets] → allowed by design (user authority), but the candidates endpoint surfaces matched PRs first and the confirm dialog names the PR title + head branch so a mis-pick is visible before launch.
- [`isCrossRepository: null` rejects legitimate same-repo PRs on flaky gh output] → conservative by intent; the error message says why and retrying is cheap.
- [Batch launches (scope=all) onto one PR head] → reuses the existing single-checkout collapse; the whole batch lands on the one PR, which is exactly the user's ask ("extend PR #151").

## Migration Plan

No DB migration (`rail_pr_deliveries` already models attached PRs and ownership). No feature flag: absent `targetPrNumber` is byte-identical legacy. Rollback = revert; rows created with explicit targets are ordinary continuation rows.

## Open Questions

- None blocking. (Deferred: fork push support; multi-PR batches; project-level "always suggest candidates" toggle.)
