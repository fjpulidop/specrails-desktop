# project-rules

Project rules inventory (feedback-2026-10 task 4.4, annex D.5). Core's rules
step writes `.specrails/rules.json`: the gates the project already runs and every
written rule of CLAUDE.md / AGENTS.md / CONTRIBUTING classified as `enforcedBy`,
`automatable` (with a `proposedCheck`), `humanOnly` or `unclassified` (contract 5.7; `init` runs it offline). Desktop reads it; Core
owns the classification. Every write surface is gated on Core `rulesInventory: 1`.

| Change | Owner |
| --- | --- |
| Parsing, bounds, human-only list, gate → verification command, rule → spec draft | [domain.ts](domain.ts) (pure, zero imports, pinned by the architecture test) |
| Locating/reading the file (workspace first, then the repository) and running `specrails-core rules inventory --root <repo> [--artifact-root <dir>]` | [runtime/rules-store.ts](runtime/rules-store.ts) |
| One run per project at a time, the last run's outcome, the once-per-project run after setup (gated, idempotent, skipped when already classified) | [runtime/rules-inventory-runs.ts](runtime/rules-inventory-runs.ts) |
| `GET /:projectId/rules`, `POST /:projectId/rules/inventory`, `POST /:projectId/rules/specs` | [adapters/http.ts](adapters/http.ts) |
| Production wiring (capability probe, ticket creation, broadcast) | [project-router-rules.ts](../../project-router-rules.ts); the after-setup trigger is SetupManager's `onSetupSucceeded` in [project-registry.ts](../../project-registry.ts) |

Consumers: the review packet freezes human-only rules at settle
([delivery phase-3 harvest](../delivery/runtime/phase3-harvest.ts)), and the
agent-runtime verification suggestions offer plain gate commands first.

## Reviewed public entry points

- [adapters/http.ts](adapters/http.ts)
- [domain.ts](domain.ts)
- [runtime/rules-inventory-runs.ts](runtime/rules-inventory-runs.ts)
- [runtime/rules-store.ts](runtime/rules-store.ts)

The [boundary manifest](../boundaries.json) records every production file's
dependencies. Run `npx vitest run server/modules/project-rules server/project-router-rules.test.ts`.
See [existing-project anchoring](../../../docs/internals/existing-project-anchoring.md#project-rules-inventory).
