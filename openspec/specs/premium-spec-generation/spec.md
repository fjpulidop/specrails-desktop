# premium-spec-generation Specification

## Purpose
TBD - created by archiving change premium-milestone-progress. Update Purpose after archive.

## Requirements

### Requirement: One premium spec contract shared by every spec author
The app SHALL keep a single premium spec contract (`server/spec-contract-prompt.ts`) and every AI author of detailed specs — the day-0 Project Builder, M2+ milestone generation, and the agent's super-spec mode — SHALL derive its spec-content instructions from it. The contract SHALL require: a `Problem Statement` of 3–5 sentences naming the persona, the trigger, the pain today, why the work belongs in its milestone and what a good outcome looks like; a `Proposed Solution` that opens with a numbered user journey and carries `###` sub-blocks for user experience (including empty, loading, error and success states), data model (entities, fields, types, constraints), interfaces & contracts (request/response or command shapes), planned modules (one responsibility each) and key decisions (with the rejected alternative); an `Out of Scope` of at least 3 bullets each stating what is deferred, why, and where it lands; `Technical Considerations` of at least 5 labelled bullets drawn from architecture, data & contracts, failure handling & edge cases, security & privacy, performance & limits, observability, testing strategy with named scenarios, dependencies by spec title, and risks & mitigations; an `Estimated Complexity` with level, reasoning and the main uncertainty; and 6–10 acceptance criteria written as observable Given/When/Then-style outcomes covering the happy path, at least one failure or edge case and at least one automated verification (plus an empty-state or accessibility criterion for user-facing specs). Grounding rules SHALL remain per author: day-0 specs label every module, path or contract as planned and never claim an existing file; M2+ and agent specs name only verified paths.

#### Scenario: Day-0 spec follows the premium contract
- **WHEN** the Builder generates a Milestone-1 spec for a project with no repository
- **THEN** its Proposed Solution carries the user-journey and the `###` sub-blocks with planned modules explicitly marked as planned, and its criteria include a failure case and an automated verification

#### Scenario: The three authors agree
- **WHEN** the day-0 prompt, the milestone prompt and the agent super-spec prompt are rendered
- **THEN** each contains the same section targets, bullet minima and 6–10 criteria rule from the shared contract

### Requirement: App-driven batched generation
After the user approves the blueprint, the Builder SHALL first emit an outline snapshot — every M1 spec with `kind`, `title`, `shortSummary`, `priority`, `labels` and any `dependsOnIndex` filled, an empty `description` and an empty `acceptanceCriteria`, `specsComplete: false`. The Builder chat manager SHALL recognise the outline and, on a resumable session, drive continuation turns itself: each turn asks for the full premium detail of the next two outline specs and expects one fenced `spec-detail` block per spec (`{ "index", "spec" }` — a small patch the app merges into the snapshot by index, never a re-emitted full snapshot); a turn that leaves its target specs unfilled gets exactly one re-ask; after the last detail turn one audit turn asks for a `spec-audit` verdict (`{ specsComplete, issues[], fixes[] }`) whose fixes merge the same way and whose verdict applies even with zero fixes; a verdict of `false` with issues gets one corrections turn (`spec-detail` blocks for the affected specs only); the existing quality repair turn still runs when the deterministic gate disagrees and may itself answer with `spec-detail` patches. The drive SHALL be bounded (at most 8 generation turns) and SHALL halt, leaving the partial snapshot persisted and uncommittable and flagging `generationHalted` on the final frame, when a detail turn still fails to fill its target specs after the re-ask or its spawn fails. A halted drive SHALL be resumable: the manual snapshot-repair route, when no rejection is pending and the persisted snapshot still has unfilled specs, SHALL continue from the next unfilled range on the same session (`kind: 'resume'`) and the readiness panel SHALL offer it as "Continue generating" with the written/total count. Every turn SHALL persist its snapshot and broadcast `blueprint.done` with `continuing: true` and a `generation` descriptor (phase, spec range, total, turn, total turns) so the panel fills progressively, and `blueprint.generating` SHALL announce each phase. Providers without native resume SHALL be told to use the single-response protocol and SHALL keep today's behaviour.

#### Scenario: Eight specs arrive in batches
- **WHEN** the Builder outlines 8 M1 specs on a claude session
- **THEN** the manager runs four detail turns (specs 1–2, 3–4, 5–6, 7–8) and one audit turn, broadcasting a continuing done after each, and the final done carries a complete snapshot that passes the gate

#### Scenario: A stalled detail turn stops the drive honestly
- **WHEN** a detail turn and its one re-ask both leave the target specs empty
- **THEN** no further continuation runs, the snapshot stays `specsComplete: false` with `generationHalted`, and the panel offers **Continue generating** instead of claiming completion

#### Scenario: Continue generating resumes from the next unfilled spec
- **WHEN** the user activates Continue generating on a conversation whose persisted snapshot has 4 of 8 specs written
- **THEN** the manager resumes on the same session with a detail turn for specs 5–6 (turn ordinal derived from what is written), then 7–8, then the audit, and the final frame passes the gate

#### Scenario: Audit verdict without fixes still completes the batch
- **WHEN** the audit turn answers `{ "specsComplete": true, "issues": [], "fixes": [] }`
- **THEN** the snapshot is marked complete and the deterministic gate judges it — no further model turn runs

#### Scenario: Audit issues get one corrections turn
- **WHEN** the audit turn answers `specsComplete: false` with a listed problem
- **THEN** the manager sends the problems back once, merges the returned `spec-detail` patches, marks the batch complete and lets the deterministic gate judge

#### Scenario: No-resume provider keeps the single response
- **WHEN** the conversation's provider cannot resume sessions
- **THEN** the per-turn prompt says to generate in a single response and no continuation turn is attempted

### Requirement: Raised deterministic quality floors
The shared quality gate (server authority + client mirror) SHALL reject a detailed spec whose Problem Statement is shorter than 200 characters, whose Proposed Solution is shorter than 500 characters, whose Out of Scope has fewer than 3 bullets, whose Technical Considerations has fewer than 5 bullets, whose acceptance criteria number fewer than 6 or more than 10, or any criterion shorter than 20 characters, with localizable issue codes (`section_depth` carrying the heading and minimum, `section_bullets` carrying the minimum, `criteria_count` carrying the bounds). Legacy snapshots that fail the raised floors SHALL be healed through the existing quality repair turn rather than committed thin.

#### Scenario: Thin spec is rejected with a precise reason
- **WHEN** a snapshot claims completion with a two-bullet Technical Considerations section
- **THEN** the gate reports `section_bullets` for that spec with `min: 5` and the repair turn asks for the missing depth

#### Scenario: Premium spec passes
- **WHEN** a spec meets every floor
- **THEN** the gate reports no issues and the batch is committable
