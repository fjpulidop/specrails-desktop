# Deliver rail into an existing PR (explicit target)

## Why

When a ticket's work belongs to an already-open PR (e.g. a spec that says "extend PR #151"), an isolated rail launched from the board still branches off the integration branch and produces a **duplicate PR**. The platform already has an active-PR continuation engine (`server/active-pr-continuation.ts`) that can borrow an external open PR (`source: 'github-open-pr'`), but it is deliberately inference-only and hard-gated: it probes GitHub **only** when the ticket is already `on_review` (or `in_progress` + Jira-linked), and matches only by PR-number mention in the spec text or Jira key. A `todo` ticket — the normal launch state — never reaches it. There is no way for the user to simply *say* "deliver this into PR #151" at launch time.

## What Changes

- **Explicit launch-time PR target.** `POST /rails/:i/launch` accepts an optional validated `targetPrNumber`. When present, the launch resolves that exact open PR as the continuation target for the whole launch — bypassing the status/inference gates that guard automatic discovery (explicit user designation replaces inference as the authority; the "no fuzzy external-PR inference" rule stays intact for the automatic path).
- **Launch-time validation, fail-closed.** The designated PR must be verifiably OPEN via the authoritative lifecycle observation, head-pushable (same-repo head; **fork-based PRs are rejected** with a distinct error), and structurally sound (valid head/base branch names, exact `headRefOid`). Validation failures reject the launch with an LLM/user-readable reason before any worktree is allocated — never a silent fallback to a fresh branch.
- **Worktree from the PR head.** The rail's worktree materializes the PR's fetched head branch as its own branch (reusing `materializeTarget` + `verifyContinuationWorktree`), with the PR's `baseRefName` as the recorded base (it wins over the configured integration branch, as it already does for automatic continuations).
- **Settle pushes to the PR.** The delivery row is born with `pr_url`/`pr_number` populated and `branchOwnership: 'borrowed-pr'`; the decision surface shows "Pushed to PR #N" with poll-merge against that PR. Discard keeps the borrowed PR and its head branch intact (existing ownership rules — no new destructive semantics).
- **Candidate-PR affordance in the launch UI.** The rail launch surface (dashboard rail header flow) shows candidate open PRs linked to the rail's tickets (reusing the existing discovery matchers as *display-only* suggestions, without the status gate) and lets the user pick one — selection simply fills `targetPrNumber`.
- **MCP surface.** `specrails_rails(launch)` accepts the same optional `targetPrNumber`, so agent-chat launches can honor "extend PR #151" instructions.

## Capabilities

### New Capabilities

- `explicit-pr-target`: launch-time designation of an existing open PR as the delivery destination — the launch-body contract, validation ladder (open/fork/base checks), candidate-PR suggestion affordance, and MCP parameter.

### Modified Capabilities

- `rail-parallel-isolation`: isolated launch admission gains the explicit-target resolution step — a designated PR is verified and materialized before allocation, and validation failure rejects the launch (new admission requirement; the existing generation-safety and allocation requirements are unchanged).
- `implementation-delivery-lifecycle`: explicit user designation becomes a sanctioned continuation source alongside ledger history and gated inference — the "no fuzzy external-PR inference" rule is scoped to the *automatic* path, and borrowed-PR ownership/cleanup rules explicitly cover explicitly-designated targets.

## Impact

- **Server**: `server/rails-router.ts` (launch body validation), `server/rail-isolated-launch.ts` (explicit-target resolution before allocation), `server/active-pr-continuation.ts` (an explicit-target resolver entry point reusing `materializeTarget`/lifecycle observation), `server/rail-pr-store.ts` (row born attached — likely no schema change; `pr_url`/`pr_number`/ownership already exist), `server/mcp/tools/rails.ts` (new param), i18n error strings ×8.
- **Client**: rail launch flow in `DashboardPage`/`RailsBoard` (target-PR picker), `RailPrDecisionContext`/`RailPrDecisionStrip` (already render attached-PR states), `agent` chat card (already renders attached-PR states).
- **No DB migration expected**: `rail_pr_deliveries` already carries `pr_url`, `pr_number`, `branches[].branchOwnership: 'borrowed-pr'`.
- **Out of scope**: pushing to fork-based PRs; multi-PR targeting in one launch (one target per launch); automatic *un*-gated inference (explicit selection only).
