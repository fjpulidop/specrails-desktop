# Existing-project anchoring (as-built)

Desktop surfaces for phase 3 of the feedback-2026-10 program (tasks 3.2, 3.3,
3.4) and the project rules inventory (task 4.4). Core owns the behaviour; Desktop
gates every surface on the capability the active Core announces in `runtime
api` (`server/modules/agent-runtime/runtime/core-capabilities.ts`,
`GET /api/projects/:id/core/phase3-capabilities`). Without the capability the
surface is absent or disabled and Desktop behaves exactly as before.

| Task | Core capability (contract) | Desktop surface |
| --- | --- | --- |
| 3.2 Non-goals | none (Desktop-only field) | Ticket `nonGoals`, "Out of scope" in the ticket modal and the Explore draft panel |
| 3.2 Clarifications on Jira | `architectClarifications: 1` (5.7) | Project setting `jiraPostClarifications`; Jira comment + reply import as a `clarification` addendum |
| 3.3 Requirement traceability | `specTrace: 1` (5.7) | Packet "Requirements demonstrated X/Y", loop economics column, CI snippet, "Drift sweep" loop template |
| 3.4 Baseline on touch | `baselineOnTouch: 1` (5.7) | Project setting `baselineOnTouch`, packet "Spec created where the work passed", baseline cost apart, blocker text |
| 4.4 Project rules | `rulesInventory: 1` (5.7) | Project settings "Project rules" panel, "Create spec" (source `rules`), packet "Needs human eyes", gates as default verification suggestions |

## Non-goals ("Out of scope")

- **Field.** `Ticket.nonGoals?: string[]` in `tickets.json`, additive at schema
  1.5 (Core ignores unknown ticket fields, so no schema bump). Absent on older
  tickets and never written as an empty list. Rules live in
  [`specs/domain/non-goals.ts`](../../server/modules/specs/domain/non-goals.ts):
  list markers stripped, blanks and duplicates dropped, at most 20 items of 300
  characters.
- **Generation.** Quick (`spec-generation.ts`) still asks for `## Out of Scope`,
  now as 1–5 non-goals; `parseGeneratedSpec` moves that section into `nonGoals`
  and out of the description. A rewrite without the section keeps the ticket's
  non-goals. Explore's `spec-draft` schema has a `nonGoals` array (the panel
  edits it); `from-draft` takes an explicit `nonGoals`, or moves a `## Out of
  Scope` section of the description.
- **Agents still see them.** Every loop prompt reads the spec through
  `getTicketSpec`, and Freestyle builds its prompt in `QueueManager`; both use
  `descriptionWithNonGoals`, which appends `## Out of Scope` to the description
  unless the description already has one. Legacy slash-command jobs read
  `local-tickets.json`, where the field is visible as is.
- **Contract Layer** is unchanged: it reads and appends to `description`.
- **Jira.** Non-goals are local: a PATCH never writes them back to the issue.

## Architect clarifications on Jira

With Core `architectClarifications: 1` the architect lists ambiguities before
planning and Core writes `clarifications.json` in the run's pipeline directory
(`<workspace>/.specrails/pipeline/<runId>/`, or the newest
`<runId[0..80]>-impl-*` directory of an engine-2 implementation piece) when it
pauses (`awaiting-answers`) and when it proceeds (`proceeded`, with the
Assumptions lines of `design.md`).

1. **Publish.** The composition (`project-registry.ts`) reads the record after
   every Core invocation ends (`LoopRunManager` option
   `onDefinitionInvocationEnd`, so a pause is seen while it waits) and again in
   `onLoopRunFinished`. When `jiraPostClarifications` is on and the connection
   is active, `JiraSyncManager.onRunClarifications` enqueues one outbox comment
   per linked ticket. Idempotency key
   `<runId>:<ticketId>:comment:clarifications:<digest>` (the digest covers the
   questions or assumptions, so a second, different pause posts again); the
   comment carries the marker `[specrails:clarifications=<runId>:ticket=<id>:<digest>]`.
2. **Thread.** Migration 77 adds `jira_clarification_threads` (one row per
   posted comment, `imported_comment_ids`, `state` open/answered/closed).
3. **Replies.** At the end of each poll, `importClarificationReplies` reads the
   comments of each open thread's issue, takes human comments after the marker
   comment (Specrails' own comments are skipped) and appends each once as a
   spec addendum of kind `clarification` (`created_by: 'jira'`). The next launch
   of the spec carries it like any addendum. Threads close after 14 days. A full
   addenda list or a validation error keeps the thread for a later poll.

The answer typed in the app (`resume --answer`) is unchanged; the Jira reply is
recorded for the next run, it does not resume a paused run by itself.

## Requirement traceability

Core `specTrace: 1` writes `spec-trace.json` after each passing verification
(see Core `docs/agent-runtime.md#requirement-traceability`).

- **Harvest.** At settle, `harvestDeliveryEvidence` reads it per unit into
  `settle_evidence.units[].specTrace` (`run-records.ts`: schema 1 only, lists
  capped at 200, unknown values never invented, a malformed file reads as
  absent). Recovered settlements read it through `recordsDir`.
- **Packet.** `packet.requirementsDemonstrated` (`buildRequirementsDemonstrated`)
  merges the units: X = demonstrated, Y = requirements in scope, plus the
  touched requirements of the change. See [review packet](review-packet.md).
- **Analytics.** Loop economics fills `requirementsDemonstrated
  { demonstrated, total, deliveries }` per loop from the settle evidence of
  delivered deliveries (`requirementsFromSettleEvidence`), `null` when none has
  a trace; `sources.requirementsDemonstrated` turns `measured`. The card shows
  `X/Y · NN%`.
- **CI.** The npm script template is in
  [OpenSpec workflow](openspec-workflow.md#requirement-traceability-in-ci).
- **Drift sweep.** With `specTrace: 1` (and workflow definitions), the loop
  library lists a read-only **Drift sweep** template (`drift-sweep`): one
  read-only prompt that compares every capability's spec with the code and
  reports contradictions with `file:line`; both verdicts end the run.

## Baseline on touch

- **Setting.** `baselineOnTouch` (project settings, default off) is forwarded to
  Core's runtime config by the bridge (`applyPhase3RuntimeSwitches`) only when
  Core announces `baselineOnTouch: 1`; otherwise the key is stripped, because an
  older Core rejects unknown keys. The same function strips
  `architect.clarifications` for a Core without `architectClarifications`. The
  vendored `server/schemas/agent-runtime.schema.json` matches Core 5.7 byte for byte.
- **Packet.** `baseline.json` is harvested into `settle_evidence.units[].baseline`
  with the as-built requirements per capability (from the unit's spec trace)
  and the run's baseline spend (`efficiencySummary.baseline`, read from the
  runtime history; `null` when not reported). `packet.baseline` lists units
  whose status is not `not-needed`.
- **Cost apart.** The packet header adds "baseline $X of it" next to the build
  cost; the baseline section states the spend and the number of turns.
  `readRuntimeEfficiencySummary` accepts the sixth invocation kind `baseline`
  (it used to require exactly five) and keeps `baseline` spend.
- **Blocker.** When characterization tests fail on the unchanged code, Core
  stops the run as `blocked` with error code `baseline_characterization_failed`;
  the bridge turns it into "Baseline blocked: the characterization tests do not
  pass on the unchanged code, so the run stopped before editing the module…",
  the text the run log and the run failure surfaces carry.

## Project rules inventory

Core `rulesInventory: 1` (contract 5.7) writes `<artifactRoot>/.specrails/rules.json`
(the directory that holds `.specrails/agent-runtime.json`; Desktop reads it from
the project's `.specrails` directory, then the repository's):
`{schemaVersion: 1, generatedAt, gates[{id, kind, command, source}],
rules[{id, text, source, status: enforcedBy | automatable | humanOnly | unclassified,
enforcedBy?, proposedCheck?}], classification {status, provider?, model?, reason?,
classifiedAt?}}`. Rule ids (`r-<12 hex>`) survive line moves.
The [project-rules module](../../server/modules/project-rules/README.md) owns it.

- **Panel.** Project settings → **Project rules**: gates, rules grouped by
  status (automatable, human only, enforced, unclassified), counts, generation
  time and a note when `classification.status` is not `classified`/`cached`.
  **Re-run inventory** runs `specrails-core rules inventory --root <repo>
  [--artifact-root <dir>]` (one at a time per project). Core's `init` runs the
  inventory **offline**, so rules stay `unclassified` until Desktop re-runs it
  with a configured provider (`agents.architect` of `agent-runtime.json`).
- **After setup.** When a project's setup succeeds (`setup_complete`, or a
  silent assemble with at least one provider assembled) Desktop runs the
  inventory once in the background (`rulesInventoryRuns.runAfterSetup`, in
  [rules-inventory-runs.ts](../../server/modules/project-rules/runtime/rules-inventory-runs.ts)):
  gated on `rulesInventory`, at most once per project per app run, never while
  another run is in flight, and skipped when the stored inventory is already
  `classified`, `cached` or `empty`. It never blocks setup. The panel follows a
  run it did not start (`running`, re-read every 3 s) and shows how the last
  run ended (`lastRun`): an automatic failure stays visible with Core's output
  and **Re-run inventory**.
- **Create spec.** An `automatable` rule (addressed by its id) becomes a ticket
  (source `rules`, labels `rules`, `automation`, non-goals set) in one click.
- **Needs human eyes.** `humanOnly` rules are frozen into
  `settle_evidence.humanRules` at settle and shown in the packet. Core also
  hands them to its reviewer, which copies the ones a change could break into
  `brief.humanChecks` ("What to look at").
- **Default verification plan.** Core only *offers* the gates to its architect.
  Desktop's `GET /agent-runtime/verification-suggestions` lists the inventory's
  plain gate commands first (shell syntax is skipped, because Core's
  verification runner uses no shell), de-duplicated against the detected
  commands; the agent runtime settings prefill them into the verification
  editor, and the user saves the plan explicitly.

## Known limitations

- Desktop does not run the inventory automatically after project setup; use
  **Re-run inventory** once a provider is configured. Without the capability
  the panel shows an existing file read-only.
- Baseline cost comes from the runtime history of engine-2 definition runs;
  other runs show "not reported".
- Settled deliveries are not re-harvested: a delivery settled before the
  capability existed has no phase-3 sections.
- Non-goal edits made in a minimized Explore session are not part of the parked
  draft overrides; the agent's latest `nonGoals` still arrive.
