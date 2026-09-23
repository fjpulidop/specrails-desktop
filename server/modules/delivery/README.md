# Delivery decision core

The [public API](index.ts) exposes the existing lifecycle vocabulary and
[decision policy](domain/decision-policy.ts). Legality depends on a narrow set
of facts rather than a SQLite delivery row. Domain types live in [state](domain/state.ts);
[the store](../../rail-pr-store.ts) reexports them for existing consumers.

[PR decision orchestration](../../rail-pr-decision.ts) and
[multi-repository delivery](../../multi-repo-delivery.ts) use this policy. Git,
leases, transactions, ticket effects and outbox replay remain in those existing
implementations. This is a policy extraction, not a completed migration of the
external delivery workflow.

Run `npx vitest run server/modules/delivery server/rail-pr-decision.test.ts server/multi-repo-delivery.test.ts`.
[Pure policy tests](__tests__/decision-policy.test.ts) protect remote PR authority,
degraded drafts and continuation recovery prerequisites.
