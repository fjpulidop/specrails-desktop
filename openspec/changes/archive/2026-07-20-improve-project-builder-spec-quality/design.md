## Context

The normal Explore/Operator spec contract stores five named markdown sections in `description` (`Problem Statement`, `Proposed Solution`, `Out of Scope`, `Technical Considerations`, `Estimated Complexity`) and keeps `acceptanceCriteria` as a separate array that is folded into the ticket body at persistence time. Project Builder currently asks for a different “five-section” shape: an unheaded narrative, embedded acceptance criteria, no out-of-scope section, and `Complexity` rather than `Estimated Complexity`. Its blueprint schema also drops priority and structured criteria, while both commit paths accept any non-empty title and prose. The result is valid tickets with weak implementation context.

Day-0 M1 generation has no repository to inspect, so it cannot truthfully name real file paths. M2+ generation does have a repository and SHALL be grounded in verified code. Both paths nevertheless need the same user-facing spec shape and persistence behavior.

## Goals / Non-Goals

**Goals:**

- Make detailed Builder specs match the canonical Specrails description and acceptance-criteria contract.
- Preserve structured criteria and priority from generation through preview, blueprint persistence, and Board tickets.
- Reject materially incomplete specs before any project/ticket mutation.
- Apply one quality bar to day-0 M1 and grounded M2+ generation, with grounding rules appropriate to each phase.
- Keep existing persisted version-1 blueprints readable without a migration.

**Non-Goals:**

- Do not generate detailed M2+ specs during day 0; `plannedSpecs` remain titles only.
- Do not fabricate file paths for a repository that does not yet exist.
- Do not rewrite already-created tickets or retroactively regenerate their content.
- Do not add another AI “refine” call during commit; commit remains deterministic and offline-capable.

## Decisions

### D1 — Extend the detailed-spec payload instead of encoding everything in prose

`BlueprintM1Spec` gains `kind: scaffold|feature|verification`, `shortSummary: string`, `acceptanceCriteria: string[]`, and `priority: low|medium|high|critical`; the blueprint gains `specsComplete: boolean`. `description` carries exactly the canonical five named sections and never embeds `## Acceptance Criteria`; ticket materialization uses the existing `formatDescriptionWithCriteria` helper to produce the final Board body. This mirrors Explore rather than maintaining a second Builder-only convention.

The blueprint remains version 1. Parsers default missing kind to `feature`, summary to empty, criteria to `[]`, priority to `medium`, and `specsComplete` to false, so old persisted blueprints and conversations remain readable. Each live parse retains both the compatibility-normalized `Blueprint` used for preview and its exact pre-coercion raw JSON. Readiness and commit inspect/send the raw representation; otherwise an invalid enum, dependency, or missing field could be defaulted or dropped into validity. Persisted legacy JSON intentionally crosses the read boundary through server-side `readBlueprint()` normalization. Strictness belongs at new commits, not at read time.

*Alternative — keep criteria inside description*: rejected because it duplicates the normal persistence contract, prevents structured validation, and makes editing/refinement inconsistent.

### D2 — Centralize deterministic quality validation

A pure server module owns the Builder spec contract and validates a batch before mutation. For each detailed spec it requires:

- a concise non-empty title and one-sentence short summary of at most 240 characters;
- all five canonical `##` headings once, in order, with non-empty bodies;
- at least 2 bullets in each of `Out of Scope` and `Technical Considerations`;
- 4–10 non-empty, independently reviewable acceptance criteria;
- a catalog-valid priority;
- `specsComplete=true`, 5–10 specs for M1, a first M1 item explicitly typed `scaffold`, and dependency indices that point strictly to an earlier spec (the scaffold omits the field).

The module returns stable field-oriented issues (`spec N: acceptanceCriteria requires 4-10 items`, etc.). The day-0 commit and M2+ milestone commit use the same validator against the exact raw generated batch before any filesystem or ticket-store mutation. The normalized render/read view is never integrity evidence.

*Alternative — rely only on the prompt*: rejected because model compliance varies by provider and a prompt cannot be the data-integrity boundary.

### D3 — Make prompt instructions concrete and provider-stable

The day-0 instructions and compact Claude system prompt name the exact schema, headings, criteria range, priority semantics, label expectations, completion flag, dependency rule, and atomic generation rule. They include a compact valid spec example. Interview and “surprise me” snapshots keep `m1Specs: []` and `specsComplete: false`; only explicit approval triggers one assistant response with one full snapshot containing the complete self-audited 5–10-spec M1 set. The agent never emits closed partial 2–3-spec snapshots. Day-0 technical considerations name planned components, contracts, risks, and spec dependencies but explicitly avoid file paths.

The milestone prompt uses the same shape and one-response/one-complete-snapshot rule for every detailed spec in the target milestone, but requires code inspection before naming exact existing paths/identifiers and requires acceptance criteria that cover behavior, failure/edge cases, and tests. It explicitly forbids repository/workspace/ticket/config/git mutation, write-capable commands/tools, and builds/tests. For relocated projects it points tools to the absolute real repo and `./project` mount (and warns against literal shell-variable paths), not the artifact workspace. For providers without a system-prompt argument, the dynamic milestone contract is folded into the user turn so Claude, Codex, and Gemini receive equivalent instructions. Both prompts require English spec content while conversation prose follows the user.

The invocation also sets `toolPolicy='read-only'`: Claude gets plan/safe mode with only Read/Grep/Glob, Codex gets its native read-only filesystem sandbox (including the resume override), and Gemini gets `--approval-mode plan` without `--yolo`. Gemini CLI exposes no selectable filesystem sandbox comparable to Codex, so this is a native approval/policy-layer boundary reinforced by the prompt, not an OS/filesystem sandbox. An incompatible plan/safety flag fails the turn; there is no retry under yolo or another mutating policy.

### D4 — Persist the exact reviewed representation

M1 and M2+ ticket creation fold `acceptanceCriteria` into the description via the shared helper, persist generated priority and short summary, preserve domain labels plus the milestone label, and keep prerequisite mapping unchanged. There is no post-generation AI rewrite, so the modal preview and resulting Board ticket are equivalent apart from the deterministic acceptance-criteria fold.

Persistence authority is intentionally asymmetric. The day-0 `blueprint.json` retains the rich `m1Specs` collection. Version 1 has no detailed-M2-per-milestone collection, so after M2+ commit the tickets are authoritative for the reviewed detailed content and the blueprint records only the target milestone's `status='committed'` plus advisory `ticketIds`. This avoids documenting or synthesizing a schema that the implementation does not have.

### D5 — Preview the complete final contract

The Builder modal renders the short summary, five-section description, a separate acceptance-criteria section, and priority. Cards expose the short summary and criteria count so shallow output is visible before commit. The complete card set appears together only after the single full snapshot closes; commit remains unavailable unless raw-payload analysis proves `specsComplete=true` and the complete set is valid. The server remains the authoritative quality gate and returns a specific error detail for stale/invalid drafts.

The M2+ preview is transient. On successful commit, `MilestoneGenerateShell` invokes the parent invalidation callback and closes; `BuilderSidebarEntry` refetches `blueprint.json`, observes the committed milestone, and advances to the first later milestone still `planned`. The detailed reviewed representation remains available through the created Board tickets.

## Risks / Trade-offs

- **[Longer single full-snapshot payload]** → Criteria and richer prose increase one response's tokens; the existing 5–10 M1 cap and the target milestone's planned set bound the cost. The larger atomic payload is accepted so review and commit never observe partial waves.
- **[Provider heading drift]** → Exact prompt examples plus deterministic commit validation prevent drift from reaching the Board.
- **[Old in-progress drafts fail a new commit]** → They remain readable; the validation detail tells the user which spec must be regenerated/refined rather than silently persisting poor content.
- **[Overly rigid wording checks]** → Validation checks structure and non-empty evidence, not prose style or arbitrary word counts.
- **[M2 fabricated grounding]** → The prompt requires real reads and the quality contract forbids unverified paths; tests pin the instruction, while human review remains necessary for semantic truth.
- **[Gemini read-only strength differs]** → Gemini has plan mode but no selectable filesystem sandbox. The UI/docs do not claim sandbox parity; the prompt forbids mutations, `--yolo` is absent, and incompatible plan flags fail closed rather than downgrading safety.

## Migration Plan

Ship parser defaults first, then prompts, validators, persistence, and preview together. Existing blueprint JSON requires no rewrite. Rollback is safe because the added fields are ignored by older readers as unknown keys; tickets already materialized contain ordinary markdown and priority values.

## Open Questions

None. The canonical Explore spec shape is the source of truth for this change.
