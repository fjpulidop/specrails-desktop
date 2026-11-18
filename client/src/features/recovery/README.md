# recovery

<!-- audit-client-features:begin (generated: public subpaths and feature dependencies; edit outside this block) -->
## Public subpaths

These are the explicit entry points consumed by application composition or other
features. Keep imports focused on a subpath so importing a model does not eagerly
load every UI component. Changes to this surface require updating the boundary manifest.

- [components/FailureAnalysisPanel.tsx](components/FailureAnalysisPanel.tsx)
- [components/FailureDiagnosisCard.tsx](components/FailureDiagnosisCard.tsx)
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
`kind` (`tests_failed`, `provider_limit`, `environment`, `blocked`, `timeout`, `tool_inactivity`,
`crash`, `unknown`), `confidence`, the failing `phase`, correction `rounds`, the provider's own
`resetAt`, a one-sentence `detail`, the `resumablePhase`, an optional host `blocker`, and the
server-ranked `remedies`.

- **Where it appears.** Job Detail (page and modal, through the shared `JobRunHeader`), the mission
  run card (`AgentPrDecisionCard`, which the run strip opens as its panel) and, as a plain
  sentence, the inbox row. The card is presentational: each surface hands it the handlers it can
  really run.
- **Remedies map to existing actions only.** *Resume from X* (the runtime resume of the run),
  *Try again* (the surface's own run-again / relaunch), *Edit spec and relaunch* (opens the spec,
  whose addenda iterate on it), *Fix the environment* (shows the blocker's required action and a
  copyable command; it runs nothing) and *Open logs at the failure* (scrolls to the last failed
  step, else the log). A remedy without a handler is not offered; at most three show, in the
  server's ranking. There is no per-run engine switch in the app, so none is offered.
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
