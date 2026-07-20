## Why

Project Builder currently creates backlog tickets whose descriptions are too shallow to drive implementation reliably: they lack the structure, behavioral detail, constraints, and verification guidance expected from a normal Specrails spec. This is especially costly in a greenfield project, where those specs are the primary executable context for the first implementation rail.

## What Changes

- Define one canonical rich-description contract for every detailed Builder spec, covering goal, context, functional behavior, technical approach, acceptance criteria, and testing/edge cases.
- Make both day-0 M1 generation and grounded M2+ generation emit that same contract, while keeping M2+ milestone planning titles shallow until their milestone is explicitly generated.
- After approval, emit the complete detailed M1 set (5–10) or complete target M2+ milestone set in one assistant response and one full snapshot; never expose partial 2–3-spec waves as a committable draft.
- Carry a concise short summary, structured acceptance criteria, and priority through the blueprint protocol and ticket persistence instead of relying only on unconstrained prose.
- Add a dual parser result: deterministic compatibility normalization for preview/legacy reads plus the exact raw generated JSON for readiness and commit validation, so defaults or dropped invalid fields cannot silently make malformed specs committable. Persisted legacy files are normalized by `readBlueprint` server-side.
- Show enough structured detail in the Builder preview for the user to review spec quality before committing.
- Make M2+ grounding genuinely read-only with provider-native policy (Claude plan + Read/Grep/Glob, Codex read-only sandbox, Gemini plan without yolo), an explicit no-mutation/no-build prompt, and correct real-repo pointers for relocated projects. Gemini has no selectable filesystem sandbox, so its guarantee is policy-layer and incompatible safety flags fail closed.
- After M2+ commit, keep detailed reviewed content authoritative in tickets, store only milestone status/advisory ticket IDs in the existing blueprint schema, and refetch blueprint state so the UI advances to the next planned milestone.
- Add regression fixtures and prompt-contract tests that compare Builder output with the established normal-spec conventions.

## Capabilities

### New Capabilities

- `project-builder-spec-quality`: Rich generation, validation, preview, and persistence requirements for detailed M1 and M2+ specs created by Project Builder.

### Modified Capabilities

<!-- None. This strengthens the unarchived Project Builder capability without changing established main-spec behavior. -->

## Impact

- Server blueprint schema/parser, legacy blueprint reader, Builder and milestone system prompts/tool policy, commit validation, and ticket materialization.
- Client dual blueprint state, Builder spec-card preview, raw readiness/commit payloads, and milestone post-commit invalidation.
- Existing persisted blueprints remain readable through backward-compatible normalization; no ticket-store migration is required.
- A larger single post-approval payload, bounded by the existing 10-spec M1 cap and the target milestone's planned set, in exchange for one atomic review/commit snapshot.
