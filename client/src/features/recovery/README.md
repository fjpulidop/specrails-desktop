# recovery

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/FailureAnalysisPanel.tsx](components/FailureAnalysisPanel.tsx)
- [components/FailureDiagnosisCard.tsx](components/FailureDiagnosisCard.tsx)
- [components/RunLineage.tsx](components/RunLineage.tsx)
- [components/StoppedRunCard.tsx](components/StoppedRunCard.tsx)
- [hooks/useAttemptChain.ts](hooks/useAttemptChain.ts)
- [hooks/useContinueRemedies.ts](hooks/useContinueRemedies.ts)
- [hooks/useFailureAnalysis.ts](hooks/useFailureAnalysis.ts)
- [hooks/useRunDiagnosis.ts](hooks/useRunDiagnosis.ts)
- [lib/failure-diagnosis.ts](lib/failure-diagnosis.ts)

## Feature dependencies

- [provider-quota](../provider-quota/README.md)

Dependencies record existing collaboration; they do not claim every feature is
independent or that this is a hexagonal frontend. Pure models should not gain
React, network or native-shell dependencies. Bind effects in hooks and adapters.
<!-- audit-client-features:end -->

Failure recovery cockpit: the **diagnosis card** at the top of a failed or blocked run.

## Failure diagnosis card

A run that failed, stalled or was blocked is explained by ONE typed record, the
*diagnosis*, produced by the server ([recovery module](../../../../server/modules/recovery/README.md)):
`kind` (`tests_failed`, `provider_limit`, `environment`, `port_in_use`, `blocked`, `timeout`, `tool_inactivity`,
`crash`, `incomplete_tasks` with its `incompleteTasks` list, `spec_invalid`, `workflow_protocol` with the `role`, `model` and an optional `strongerModel` to suggest, `unknown`), `confidence`, the failing `phase`, correction `rounds`, the provider's own
`resetAt`, a one-sentence `detail`, the `resumablePhase`, an optional host `blocker`, the contested
`port` (`port_in_use`, when the output named it; amber like the other causes the host can unblock),
and the server-ranked `remedies`.

- **Where it appears.** Job Detail (page and modal, through the shared `JobRunHeader`), the mission
  run card (`AgentPrDecisionCard`, which the run strip opens as its panel) and, as a plain
  sentence, the inbox row. The card is presentational: each surface hands it the handlers it can
  really run.
- **Remedies map to existing actions only.** *Continue* (the one primary: `useContinueRemedies`,
  `POST /loop-runs/:id/remedy`, keeps the work and goes on from the step that failed or stopped with
  the cause's guidance; a surface without a definition run passes its in-place resume),
  *Continue to review* (unfinished tasks that only a person can check), *Edit spec and relaunch*
  (opens the spec, whose addenda iterate on it), *Fix the environment* (shows the blocker's required
  action and a copyable command; it runs nothing) and *Open logs at the failure*. Each button has its
  one-line consequence under it (`consequenceKey`). *Start over* (the surface's run-again / relaunch)
  is never a button: it waits in the card's menu with its warning (this attempt's work is not carried
  over and stays in the old worktree). A remedy without a handler is not offered; at most three show,
  in the server's ranking. Older wire ids (`resume`, `retry-with-browser`) read as `continue`.
- **A stopped run.** `StoppedRunCard` (Job Detail's *Continue* tab) says the person stopped it and
  offers the same Continue, never a relaunch from the base.
- **Attempt chains.** `useAttemptChain` (`GET /loop-runs/:id/attempts`) gives the chain and whether
  Continue applies; `RunLineage` is the run window's line ("Attempt 3 of 4 · continued from the
  Developer step of attempt 2") and its popover of every attempt and what changed.
- **No invented diagnosis.** A low-confidence or unrecognised record is read as `unknown`
  (`readFailureDiagnosis`): the card says "Unknown cause", shows the raw tail of the log and offers
  only logs and a retry.
- **The runtime's own record first.** An `unknown` record whose log tail holds the runtime's
  `step_failed: <step> — <reason>` line names that step in the headline and shows the reason
  (`recordedStepError`); the words are the runtime's, not a guess.
- **AI analysis.** `FailureAnalysisPanel` (under the card for a failed job) shows the AI reading
  of the log: headline, cause, category (quota limits are flagged), the cited log lines, next
  steps and the provider/model that wrote it. `useFailureAnalysis` reads the saved one and, when
  none exists, asks for it once; it is not automatic for `provider_limit`, whose call would hit
  the same limit. See the [API reference](../../../../docs/internals/api-reference.md#failure-analysis).
- **Runs without a card.** Delivery cards read the diagnosis of their last run
  (`useRunDiagnosis` → `GET /loop-runs/:id`); the old failure block stays under *Technical details*.
- **Accessibility and design.** The card is a labelled `region` whose headline is a `status`;
  remedies are a labelled group; type uses role classes only; tones follow the lamp canon
  (tomato for failures, amber for causes the host can unblock, neutral when unknown).

Run the adjacent tests with `npm run test --prefix client -- src/features/recovery`.
Validate navigation with `node scripts/audit-client-features.mjs --check`.

`EnvironmentPlanOffer` (inside the card for `environment` and `tests_failed`) asks the
server for an environment plan (`GET /agent-runtime/environment-plan`): a repository that
pins a Python version gets a venv built from it for setup and checks. **Use a Python X.Y
venv for checks** saves it to the project settings (`POST …/apply`, read-modify-write with
the ordinary validation); nothing is offered once the settings carry it.

## Unfinished tasks and unknown causes

- `incomplete_tasks` lists the unticked tasks and leads with **Continue** (the developer finishes
  them with the browser and install guidance); **Continue to review** follows when they are a
  person's checks. [useContinueRemedies](hooks/useContinueRemedies.ts) runs both; Job Detail, the
  mission run card and the rail strip wire it.
- An AI next step that names a remedy this surface has becomes its button (`FailureAnalysisPanel`
  `actions`); anything else stays advice.
- When the app's own records name no cause, the card takes the surface's AI reading (`ai` prop,
  one [useFailureAnalysis](hooks/useFailureAnalysis.ts) shared with the panel below it): a ready
  reading leads the card, labelled *From AI analysis*; while it runs the card says so; with none,
  the card explains how to find the cause and **Analyze with AI** is its primary action.
