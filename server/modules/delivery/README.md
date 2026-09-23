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

Delivery change requests and same-spec addenda continue through Quick SDD using
the existing supersession/rollback contract. `revisionOfDeliveryId` remains the
wire field for identifying the generation; it no longer selects a Revision loop.
See [spec addenda](../../../docs/internals/spec-addenda.md).
