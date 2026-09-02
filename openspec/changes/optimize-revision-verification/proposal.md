## Why

The factory `Revision` loop is intended to make a narrow follow-up cheaper than rerunning the full implementation pipeline, but its revision step currently invokes `sr-reviewer` and then a generic verification step repeats broad repository checks. In practice that overlap can trigger a full `health-check`, duplicate test and OpenSpec validation runs, and erase most of the latency and cost advantage of skipping Architect.

## What Changes

- Split revision mutation from independent review: the revision step applies only the requested delta and runs focused checks, while a dedicated revision-review step owns re-grading and the full validation gate.
- Start that reviewer in a new provider session and inject the complete durable revision briefing, so correctness never depends on the mutator's conversation being resumable.
- Make the dedicated review step emit the existing `VERIFICATION: PASS|FAIL` sentinel, so the existing Decider and fix loop continue to work without a second generic verification pass.
- Prevent the normal revision path from invoking a repository-wide `health-check` or rerunning a full gate after `sr-reviewer` has already completed it.
- Preserve full-scope verification, fresh `confidence-score.json` evidence when available, fix → re-review behavior, and honest degradation when reviewer evidence cannot be produced.
- Harvest the reviewer schema and path written by current Codex `sr-reviewer` installs, rejecting revision scores created before the final review pass using a millisecond-precision step boundary.
- Add regression tests for the factory graph, prompt responsibilities, command expansion, evidence freshness, and fallback behavior.

## Capabilities

### New Capabilities

- `revision-verification`: Defines single-owner, independent verification for delivery revisions, including focused mutation checks, one full review gate per candidate, failure fallback, and re-review after fixes.

### Modified Capabilities

None.

## Impact

- `server/loop-factory.ts` and `server/loop-templates.ts`: Revision uses a dedicated review/verification node while other factory loops retain the generic verify node.
- `server/loop-command-catalog.ts`: revision mutation and review prompts receive explicit, non-overlapping responsibilities.
- `server/loop-run-manager.ts`: review nodes can request a fresh provider session and loop-step events carry an additive high-resolution boundary for honest evidence matching.
- `server/delivery-evidence.ts`: current reviewer artifact paths/schemas are normalized and revision evidence is tied to the latest verification epoch.
- The still-active `nontech-review-experience` delivery-revision artifacts are reconciled with the new single-owner gate so they do not retain a contradictory workflow.
- Factory-loop, command-catalog, template, and revision regression tests.
- No API, database-schema, delivery-lineage, or provider protocol changes. The persisted internal `loop_step` payload gains one additive timestamp field.
