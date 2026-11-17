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

## AI failure analysis

[analysis.ts](analysis.ts) (pure) builds the evidence a model reads (log tail, job metadata, the
diagnosis), the prompt and the validated answer. [adapters/sqlite.ts](adapters/sqlite.ts) keeps one
analysis per job (`job_failure_analyses`). The HTTP route and the provider call live in
`server/project-router-jobs.ts` (see the [API reference](../../../docs/internals/api-reference.md#failure-analysis)).

- It is an AI reading shown beside the diagnosis, labelled as such; the diagnosis keeps its kind,
  confidence and remedies, so "no invented cause" still holds for the record.
- Quoted evidence survives only when it appears verbatim in the log.
- It runs on the provider and model that ran the job, so the account can run it.

Run `npx vitest run server/modules/recovery server/modules/inbox server/project-router-failure-analysis.test.ts`.
