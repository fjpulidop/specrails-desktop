## Context

`factory:revision` currently reuses `fixLoopGraph()`: `revise → verify → decider`, with `decider → fix → verify` on failure. The `revise` command both mutates the candidate and asks `sr-reviewer` to re-grade it, while the fixed `verify` node then asks another agent to detect tooling, fix failures, and rerun the full project gate. Current Codex runs can therefore execute the reviewer gate and a broad `health-check` back-to-back.

The topology, node id `verify`, `VERIFICATION: PASS|FAIL` sentinel, and fix loop are already coupled to delivery evidence harvesting and completion decisions. The optimization must preserve those integration points, the full-scope final gate, reviewer confidence, and revision lineage.

Reviewer versions differ: current 4.12 Codex `sr-reviewer` runs the full project suite/build itself, while later scoped-first reviewers may run only focused checks and rely on a pass of record. The dedicated gate must inspect what its reviewer actually ran and complete any missing full-scope commands exactly once.

Current Codex reviewer artifacts also differ from Desktop's original expectation: the skill writes `.specrails/agent-memory/explanations/*confidence-score.json` with `overall_score`, while Desktop only searches `openspec/changes/*/confidence-score.json` and parses `overall`.

## Goals / Non-Goals

**Goals:**

- Give revision mutation and final verification one owner each.
- Execute one full project gate for each immutable revision candidate, reusing the reviewer run when it already supplied that gate.
- Keep the final gate independent and read-only, routing defects through the existing `fix` node.
- Preserve the `verify` node id, sentinel, confidence score, reviewer-unavailable fallback, and delivery lineage.
- Deterministically reject a revision confidence artifact produced before the latest review pass.

**Non-Goals:**

- Narrow final verification to targeted tests.
- Change Implement, Batch, Freestyle, SDD Quick, delivery state, worktree, PR, or rollback behavior.
- Introduce a database migration or a breaking wire change. One additive internal loop-event timestamp is in scope for freshness proof.
- Guarantee command de-duplication outside the factory Revision prompts.

## Decisions

### Decision 1: A dedicated Revision verification command owns review and the full gate

`revise` will apply only the requested delta and may run focused checks while editing. It will not invoke `sr-reviewer`, a full repository gate, or `health-check`.

The existing graph's `verify` node will instead expand a new `{{cmd:revision-verify}}` command. That AI node explicitly drops the mutator's provider session before execution and receives the complete durable `REVISION_REQUEST` briefing (including the user request and frozen launch-time spec). Independence therefore does not depend on provider resume support or on the mutator's prose summary. It follows the installed `sr-reviewer` role, writes a new confidence artifact when the role is applicable, audits the requested delta, and guarantees that the candidate receives one full project test/typecheck/lint/build gate:

- when the reviewer already ran the full gate, that execution is the pass of record and is not repeated;
- when the reviewer ran only scoped checks, the step runs the missing full-scope commands once;
- when the reviewer is unavailable or inapplicable, the step runs the full gate itself and reports the reviewer score as unavailable.

The step is read-only for source, tests, and OpenSpec artifacts. It may write only reviewer/evidence artifacts. It ends with `VERIFICATION: PASS` only when the review and required gate are clean; otherwise it emits `VERIFICATION: FAIL — …` without fixing.

The installed reviewer role's own two-line `Score`/`Verdict` finish contract is treated as the end of the internal review phase, not the outer verification step. The outer prompt preserves the review procedure and artifact rules, then continues from that intermediate verdict to complete missing project gates and emit the sentinel consumed by the Decider.

Alternatives considered:

- Remove the second AI step and trust the mutating agent's self-review. Rejected because it removes independence and the observed second read found a real defect.
- Keep reviewer inside `revise` and make `verify` consume its prose. Rejected because reviewer execution is prompt-only inside the mutating session and freshness after a later fix becomes ambiguous.
- Keep generic `{{cmd:verify}}` and merely ask it to be faster. Rejected because it still owns mutation and can select the broad `health-check` skill.

### Decision 2: Reuse the fix-loop topology with a configurable verification prompt

`fixLoopGraph()` will accept an optional verification prompt that defaults to `{{cmd:verify}}` and an opt-in isolated verification cycle. All existing callers retain their current graphs and session continuity. `factory:revision` supplies `{{cmd:revision-verify}}`; its reviewer and fix nodes each start fresh, bounded sessions while receiving prior findings through durable loop history. This prevents the mutating fix from inheriting the reviewer's read-only instruction set.

The node remains id `verify`; `decider → fix → verify` remains unchanged. Therefore every fix creates a new candidate and automatically runs a new independent review before the Decider can stop. The revision mutation step still runs once.

A dedicated duplicate graph was rejected because it would make topology, timeout, and convergence fixes drift between otherwise identical loops.

### Decision 3: The latest verify-step boundary is the revision evidence epoch

For Revision runs, the last persisted `loop_step` event whose node id is `verify` defines the earliest acceptable modification time for its confidence artifact. The engine writes its millisecond-precision `startedAtMs` into that event from the same clock instant used to open the step. Settle-time harvesting will:

1. Search both the existing OpenSpec location and `.specrails/agent-memory/explanations/`.
2. Match agent-memory files to the unit's ticket id.
3. Accept only a candidate whose filesystem modification time is at or after that high-resolution verify-step start.
4. Prefer the newest eligible candidate deterministically.

Because the verification step is read-only, an artifact produced within that epoch describes the same candidate evaluated by the sentinel. A fix creates a later verify epoch, so the previous score becomes ineligible automatically. Legacy events expose only SQLite's timezone-less, second-precision timestamp; they cannot prove within-second ordering and therefore make reviewer confidence unavailable rather than guessing. Agent-memory discovery also requires the reviewer's exact dated ticket filename, not a suffix lookalike.

Non-Revision harvesting keeps its existing compatibility behavior.

### Decision 4: Normalize both documented reviewer schemas

`parseConfidenceScore()` will accept `overall` or `overall_score`. Existing `aspects`/`scores` parsing remains unchanged. When the current Codex schema provides `issues` rather than `flags`, bounded issue notes become flags; numeric aspect values are never invented from booleans.

The raw size cap and tolerant failure behavior remain unchanged.

### Decision 5: Reconcile the active delivery-revisions contract

The still-active `nontech-review-experience` requirement and D11 design text currently mandate reviewer orchestration inside `revise` followed by standard verify. They will be updated to the single-owner flow so the repository does not carry two contradictory SHALL-level descriptions.

## Risks / Trade-offs

- **[Risk] Prompt discipline cannot prove which subprocess commands the reviewer ran.** → The dedicated step must state the exact ownership rule, report the commands used, and fail rather than claim PASS when it cannot establish a full gate.
- **[Risk] Legacy event and filesystem timestamps may not prove ordering.** → Compare file mtime against the new millisecond engine boundary; a legacy/missing boundary or unreadable metadata degrades to unavailable, never to a stale score.
- **[Risk] A provider lacks the reviewer skill.** → Run the normal full-scope gate once, emit an honest sentinel, and leave reviewer confidence unavailable.
- **[Risk] The installed reviewer role ends after its own two-line verdict.** → Reconcile that terminal format explicitly as an intermediate phase result; the outer gate must continue and emit the standard sentinel.
- **[Risk] Reviewer agent-memory files could be staged into a delivery.** → Add `.specrails/agent-memory` to the same symlink-safe never-stage roots and index audit already protecting other providers' private memory.
- **[Risk] Current and future reviewer schemas continue to diverge.** → Preserve the bounded raw payload and parse additively rather than replacing the existing schema.
- **[Trade-off] Revision still performs full verification.** → This deliberately optimizes duplicated orchestration and broad audits, not the safety contract.

## Migration Plan

1. Ship the new command and configurable verification prompt behind the existing factory Revision definition.
2. Update evidence parsing and freshness tests before relying on agent-memory scores.
3. Reconcile the active delivery-revisions artifacts.
4. Roll back by restoring Revision's default `{{cmd:verify}}` prompt; no persisted data migration is required.

## Open Questions

None.
