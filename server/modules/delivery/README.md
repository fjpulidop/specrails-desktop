# Delivery decision core

The [public API](index.ts) exposes the existing lifecycle vocabulary and
[decision policy](domain/decision-policy.ts). Legality depends on a narrow set
of facts rather than a SQLite delivery row. Domain types live in [state](domain/state.ts);
[the store](runtime/rail-pr-store.ts) reexports them for existing consumers.

[PR decision entry](runtime/rail-pr-decision.ts) delegates to focused
[workflow adapters](adapters/decisions/): dispatch/admission, transitions,
publication, creation, discard, local merge, recovery, retry, ownership evidence
and chain settlement. These adapters preserve the existing Git/SQLite contracts,
leases, transaction ownership and durable ticket effects. The workflow import
graph is checked for cycles. The public policy remains independent of effects.

Run `npx vitest run server/modules/delivery server/modules/delivery/runtime/rail-pr-decision.test.ts server/multi-repo-delivery.test.ts`.
[Pure policy tests](__tests__/decision-policy.test.ts) protect remote PR authority,
degraded drafts and continuation recovery prerequisites.

## Reviewed public entry points

- [runtime/delivery-evidence.ts](runtime/delivery-evidence.ts)
- [runtime/isolated-settlement-reconstruction.ts](runtime/isolated-settlement-reconstruction.ts)
- [runtime/multi-repo-execution-store.ts](runtime/multi-repo-execution-store.ts)
- [runtime/multi-repo-execution.ts](runtime/multi-repo-execution.ts)
- [runtime/pr-publisher.ts](runtime/pr-publisher.ts)
- [runtime/rail-isolated-launch.ts](runtime/rail-isolated-launch.ts)
- [runtime/rail-isolation.ts](runtime/rail-isolation.ts)
- [runtime/rail-pr-store.ts](runtime/rail-pr-store.ts)
- [runtime/rail-pr-ticket-effects.ts](runtime/rail-pr-ticket-effects.ts)
- [runtime/rails-router.ts](runtime/rails-router.ts)
- [runtime/rails-store.ts](runtime/rails-store.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/delivery` and any affected consumers.

Delivery change requests and same-spec addenda default to Quick SDD, while
respecting an explicit loop or mode selection (including Implement), using
the existing supersession/rollback contract. `revisionOfDeliveryId` remains the
wire field for identifying the generation; it no longer selects a Revision loop.
See [spec addenda](../../../docs/internals/spec-addenda.md).

Fresh launches use run-specific mounts and new sibling branches; failed attempts
remain recoverable through their original ledger and frozen runtime. Only a
recorded delivery/PR continuation reuses its exact branch. Undelivered failed
generations with open addenda are atomically replaced by fresh launches, without
claiming prior delivery. Every frozen addendum must be claimed before any agent
starts; partial claims are reopened if admission fails.

Mission Relaunch posts the original delivery/run `sourceId` to
`POST /rails/:railIndex/relaunch`. `runtime/rail-relaunch.ts` resolves that
project's saved configuration and original spec set, then shares normal launch
admission checks. Migration 71 freezes admitted options on deliveries and loop
runs before execution. Empty assignments are restored after preflight; reused
or removed rails, newer generations and delivered work are rejected. An
identified undelivered failure uses the existing atomic `retryOfDelivery`
supersession/rollback, retaining its original checkout. Historical attempts use
recorded loop/runtime/manifest fields; absent workflow identity never silently
selects Implement. A retry cannot fall back to shared cwd from an isolated
delivery. See [mission rail cards](../../../docs/internals/mission-rail-cards.md).

Manifest reconstruction omits `workspaceSelection` when no repository records
workspace narrowing, preserving registered defaults. Explicit saved selections
and nonempty partial maps remain intact and pass through normal scope validation;
invalid entries are never discarded to broaden the launch.

Warm dependency reuse preserves the registered source's position in its Git
checkout. A registration at `apps/catalog` prepares its dependencies beneath
`apps/catalog/node_modules` in the full worktree, with local writable caches;
discovery stays scoped to the registered source. Cleanup reconstructs exact live
source proofs at those worktree-relative paths after restart and also recognizes
authenticated historical links without moving them. Replaced packages, foreign
links and paths beneath symlinked destination ancestors confer no new cleanup
authority. Registration identity and Core's execution scope remain unchanged.

Settlement blocks new active OpenSpec change directories against the frozen base
and deliverable external absolute symlinks with an actionable `commit_failed`
detail, retaining the checkout. Archives and base changes remain allowed.
Authenticated overlay exclusions survive supported provider switches; cleanup
authority still requires live fingerprints. See the [safe PR guide](../../../docs/internals/safe-pr-review-flow.md).

## Definition-engine evidence

Before isolated delivery releases worktrees, it obtains full status from each
retained Core CLI with bounded concurrency. The pure evidence projection uses
committed scope/attempt identities, host verification receipts and implementation
review outputs. Existing file confidence remains authoritative. Parallel reviewer
verdicts are retained in `scopedReviews`; their aggregate confidence stays absent.
An unavailable inspection is a failed/partial harvest, never a zero or a pass.
Legacy journal harvesting remains limited to legacy executions. Delivery admission
still requires the separate terminal completion/verification gate.

### Definition execution recovery

`runtime/isolated-settlement-store.ts` freezes isolated allocation and overlay
policy before Core starts. Migration 67 stores one immutable snapshot per
project delivery/run, the settlement result, and an atomic provenance receipt.
`reattachIsolatedSettlement` uses the same Git settlement coordinator as a fresh
launch. It checks the retained Core completion, frozen verification policy,
worktree ledger, actual branch and repository mount before effects. Execution
and delivery operation claims fence competing retries. A restart must preserve
the original terminal outbox and accounting; it must not manufacture a new run
or infer acceptance from exit code alone.

### Linked definition forks

`runtime/definition-fork.ts` is the fork admission coordinator exposed to HTTP.
Migration 68 records the request before Core publication, then adopts the child
and transfers ticket/worktree/delivery ownership in one project transaction.
Original run rows, events, accounting and frozen snapshots are preserved; the
active snapshot query excludes superseded allocations. Pending or adopted forks
fence source execution and late settlement. Frozen addendum claims transfer only
when the child applies its causally owned terminal effects. Core is responsible
for historical cuts and idempotent publication; Desktop never edits its SQLite.

Historical v2 runs without a complete allocation snapshot use
`ensureIsolatedSettlementSnapshot` only during explicit recovery. It requires
matching frozen context/manifest, delivery branch records (including initial
SHA and never-commit exclusions), worktree ledger and every repository leg.
All snapshots insert in one immediate transaction. Incomplete, conflicting,
closed, operated or borrowed-PR records stay blocked without guessed ownership.
The recovered checkout's Git common directory is checked before settlement.
Reconstruction grants no automatic worktree/overlay cleanup authority, captures
no new ignored-release baseline, and leaves missing provenance baselines null.
The original request, ticket destination and accounting remain unchanged.
