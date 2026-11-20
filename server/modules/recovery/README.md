# recovery

Failure diagnosis: why a run ended `failed`, `blocked` or `stalled`, and which remedies fit.
The client feature is [recovery](../../../client/src/features/recovery/README.md).

## Where to change behavior

| Change | Owner |
| --- | --- |
| Diagnosis vocabulary, Core record validation, derivation from Desktop's own signals, remedy ranking | [domain.ts](domain.ts) (pure) |
| Continuing a run: the cause's guidance, person-only checks, a picked resolution's guidance, the same-cause-twice rule, the automatic-continuation guards | [continuation.ts](continuation.ts) (pure) |
| Failing and flaky tests from the recorded verification output of an attempt chain | [verification-tests.ts](verification-tests.ts) (pure) |
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
  `completion.blocker`, and a port collision (`EADDRINUSE`, "address already in use",
  "Port N is in use") printed by the run in the very step that failed. That collision
  is `port_in_use` (with `port` when named) and replaces Core's `tests_failed`/`unknown`
  for the step: the checks did not fail on the change. Collisions inside the agent's own
  conversation never count. The Implement recipe's own end reasons (`completion.reasons`) are
  fixed templates too: unfinished tasks (`incomplete_tasks`, with `incompleteTasks`), a spec
  OpenSpec rejects (`spec_invalid`), host blockers (`environment`) and exhausted or unchanged
  corrections (`blocked`). A low-confidence Core record never hides them. Everything else is
  `unknown` with `confidence: 'low'`.
- `workflow_protocol` (Core 5.16, or Core's fixed "Required OpenSpec role workflow was not executed"
  sentence from an older Core) is continuable; reads present it with `strongerModel`, the provider's
  default model when the provider catalog marks the model that ran `small` (`strongerModelFor`,
  catalog injected by [adapters/sqlite.ts](adapters/sqlite.ts) so the domain stays pure).
- `continue` is the one primary remedy of a run that can go on: it keeps the work and goes on from
  the step that failed or stopped, with the cause's guidance (`continuationGuidance`). `retry` is
  "Start over" from the base. `continue-to-review` is ranked only when every unfinished task reads as
  a person's check (`remainingAreHumanChecks`). `resume` and `retry-with-browser` are older ids of
  `continue` (the route maps them). `POST /loop-runs/:id/remedy` applies them
  ([run-continuation.ts](../delivery/runtime/run-continuation.ts) plans how, never from an `end` node: a
  host blocker's end goes on from the step that reported it (`blockerFrom`), `continueDefinitionRun`
  in `server/project-router-loop-runs.ts` applies it).
- `copy-env-files` is ranked first for a high-confidence `environment` diagnosis that names a
  missing `.env` / `APP_KEY` (`needsEnvFiles`) while the project's `worktreeEnvFiles` setting is off
  (`presentFailureDiagnosis(…, { envFilesEnabled })`, read by [adapters/sqlite.ts](adapters/sqlite.ts)).
  The route turns the setting on, copies the files into the run's worktrees and continues; the
  guidance names the copies (`envFilesCopied`), never their values. `failureEvidence` takes a
  `redact` so the copied values never reach the analysis provider.
- Automatic continuation (`autoContinueVerdict`): once per attempt chain, only for a high-confidence
  cause more work can fix (unfinished tasks, a `toolchain`/`setup` host blocker, a crash, timeout or
  silence, a stall), never for a usage limit, `spec_invalid`, credential / secret / policy / budget
  wording, a person's stop, the loop's own caps, an unknown cause or a repeat of the attempt before.
  The coordinator is `server/project-context-auto-continue.ts`; the app setting is `autoContinueRuns`.
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
- A next step may name a remedy (`nextStepActions`: `continue`, `continue-to-review`, `edit-spec`,
  `change-model`); anything else, or an unknown kind, is plain advice.
- Prompt v4 adds `options`: 2-4 ways to resolve the failure, each `{ id, kind, label, does, consequence,
  risk?, recommended?, guidance }`. `kind` is an executable remedy (`RESOLUTION_KINDS`:
  `continue-with-guidance`, `continue-to-review`, `mark-human-check`, `edit-spec`, `change-model`,
  `start-over`), limited per run by `resolutionKindsFor(diagnosis)` (sent as `context.optionKinds`);
  other kinds, a fifth option, a second recommendation and unreadable options are dropped
  (`parseResolutionOptions`). Older cached analyses have no options and keep their plan.
- The evidence carries `context`: the failing / flaky tests and the chain's attempts (count, spend,
  `repeated`), so options cite the tests and do not recommend more of the same after a repeat.
- `POST /loop-runs/:id/remedy` takes `{ optionId }` (the option's kind and guidance are read from the
  stored analysis, never from the request) or `{ instruction }` (1-4000 chars). Continue kinds send
  `resolutionGuidance` with the cause's guidance; `mark-human-check` tells the agent to add `[human]`
  tasks (the human-check contract) and keep those tests out of host verification. `edit-spec`,
  `change-model` and `start-over` run on the client. With options present a plain Continue no longer
  carries the analysis' steps: it is "keep going".

## Flaky tests and repeated stops

- `readVerificationTests` (adapter) reads the `verification-output` events of the run and the attempts
  it continued, one round per verification visit, and classifies the latest round's failing tests:
  flaky when they passed and failed on the same candidate, the runner reported them flaky, their
  outcome flipped twice, or they passed in two earlier rounds and now fail on a timeout / closed
  process. Nothing is re-run. Presented diagnoses carry `failingTests` / `flakyTests`; Continue adds
  `flakyTestsGuidance` (make them deterministic, never lengthen timeouts).
- `repeatedStop`: two consecutive attempts with the same cause (same kind and step, and the same words
  or the same failing tests / review finding ids), or three budget stops (`blocked`) in a row at one
  step. `readChainResolution` serves it with the chain's spend on `GET /loop-runs/:id/attempts`
  (`resolution`); the card then leads with the options, and automatic continuation refuses it.
- It runs on the provider and model that ran the job, so the account can run it.

Run `npx vitest run server/modules/recovery server/modules/inbox server/project-router-failure-analysis.test.ts server/project-router-loop-runs-resolution.test.ts`.
