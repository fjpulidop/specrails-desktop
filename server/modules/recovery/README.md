# recovery

Failure diagnosis: why a run ended `failed`, `blocked` or `stalled`, and which remedies fit.
The client feature is [recovery](../../../client/src/features/recovery/README.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Diagnosis vocabulary, Core record validation, derivation from Desktop's own signals, remedy ranking | [domain.ts](domain.ts) (pure) |
| Reading a run's / job's diagnosis from one project's database | [adapters/sqlite.ts](adapters/sqlite.ts) |
| Public imports | [index.ts](index.ts) |

Producers and consumers live with their streams: `LoopRunManager` computes and persists the record
when a run settles (`loop_runs.failure_diagnosis`, migration 84, written by `finishLoopRunAndJob` in
the outcome's commit); `GET /jobs/:id` and `GET /loop-runs/:id` serve it; the
[inbox](../inbox/README.md) projects it. See the [API reference](../../../docs/internals/api-reference.md#failure-diagnosis)
and [programmatic runtime](../../../docs/internals/programmatic-agent-runtime.md).

## Invariants

- No invented cause. Core's classification (contract 5.8) wins; otherwise only certain signals
  produce a kind: the loop's stall reason, the provider-limit classifier, Core's fixed
  "Baseline blocked" / "Verification cannot run in this environment" sentences and
  `completion.blocker`. Everything else is `unknown` with `confidence: 'low'`.
- A low-confidence record is always `unknown`, whatever kind it claimed, and its remedies are only
  `open-logs` and `retry`.
- Remedies are ids of actions the app already has; the client offers only those its surface can run.
- The record is written in the same transaction as the run outcome and cleared when the run
  later finishes without one (a resumed run that succeeds).
- Read-only after settlement; project isolation: every read is bound to one project's database.

Run `npx vitest run server/modules/recovery server/modules/inbox`.
