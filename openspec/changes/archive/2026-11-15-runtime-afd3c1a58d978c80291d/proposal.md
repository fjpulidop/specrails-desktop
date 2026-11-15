# Proposal

## Why

The mission "Fix PR CI" card only exists for PRs that Specrails delivered: `pr-ci-offer.ts` offers it from `pr_draft`/`pr_ready` deliveries, `AgentPrCiOfferCard` requires `prDeliveryId` + `railIndex`, and `POST /rails/:railIndex/pr-ci` and `resolvePrCiTargets` read delivery rows and frozen settlement snapshots. A user who asks a mission to repair the CI of an existing PR in one of the project's repositories (for example PR #474) therefore gets diagnosis but no repair flow.

## What Changes

- Add a host-owned **external PR CI admission**: a persisted record keyed by project, `repositoryId` and PR number, created when a mission agent asks to prepare a repair offer from a PR URL. The URL is resolved only against the repositories registered in the mission's pinned project; the PR is validated (open, same-repository, usable head/base) with the existing explicit-target ladder (`resolveExplicitPrTarget` / `observePrLifecycle`) before any offer exists.
- Add a mission-agent MCP action that prepares the offer. Preparing posts the existing `pr-ci-offer` system row with a mission-origin identity (admission id + repository + PR) and starts nothing.
- Extend `pr-ci-offer.ts` with a mission-origin projection and dedupe key (project + repositoryId + PR number), keeping delivery-backed offers unchanged. Offers carry repository and PR identity and never synthesize `prDeliveryId`/`railIndex`.
- Add a start route for admitted external PRs. It re-validates the PR, refuses a second active run for the same project/repository/PR across both entry paths, honours the existing flag/capability/permission checks, and launches the canonical `factory:pr-ci` recipe (`loop-pr-ci-recipe.ts`) in an isolated worktree on the PR head branch. It is not a saved library loop.
- Extend `pr-ci-target.ts` so `resolvePrCiTargets` resolves targets from persisted external admissions (host authority), alongside delivery settlement snapshots.
- Extend `AgentPrCiOfferCard` and `client/src/features/delivery/lib/pr-ci.ts` to parse, start, dismiss and follow mission-origin offers; the card itself shows state, reason and run log (no delivery card exists to delegate to). Start stays an explicit click; acceptance of the start is shown as "started", not as repaired.
- Persist settlement (green, no checks, needs-attention with reason) on the admission and project it into the same offer row so it survives conversation reload.
- Fork PRs: both `resolveExplicitPrTarget` (`target_pr_fork`) and the pr-ci handlers (`observe`, `checkOne`) refuse cross-repository heads, and pushes use origin rights. They are rejected at prepare and start with the concrete limitation; no permissions are widened.
- Distinguish errors: closed/merged, outside-project, inaccessible, incompatible, fork, and authentication/connection failures (never reported as "PR not found").
- Never merge the PR and never mark a spec accepted/done because checks are green.

## Capabilities

### New Capabilities
- `mission-pr-ci-repair`: Preparing, admitting, starting, deduplicating and reporting CI repair for an existing project PR from a mission, without a prior Specrails delivery.

### Modified Capabilities
<!-- None: delivery-backed behaviour is preserved; explicit-pr-target is consulted, not changed. -->

## Impact

- Server: `server/modules/delivery/runtime/pr-ci/{pr-ci-offer,pr-ci-target,pr-ci-projection,pr-ci-settlement}.ts`, `rails-router.ts` (new start route), `server/mcp/tools/rails.ts` or a new mission tool, `agent-operator-prompt.ts`, append-only migration in `server/db/migrations.ts`, `loop-pr-ci-recipe.ts` (reused, algorithm unchanged).
- Client: `AgentPrCiOfferCard.tsx`, `delivery/lib/pr-ci.ts`, locales (`agent.json`), `AgentChatContext` row parsing if needed.
- Docs: delivery README, `docs/internals/mission-rail-cards.md`, `api-reference.md`, source map.
- Out of scope: repairing #474 itself, auto-merge/accept, repositories outside the project, changes to repair algorithm or limits.
