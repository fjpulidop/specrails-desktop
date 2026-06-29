# loop-merge-resolver Specification

## Purpose
TBD - created by archiving change parallel-implementation-worktrees. Update Purpose after archive.
## Requirements
### Requirement: MERGE_SAFE guardrail constant

The constants library SHALL expose a read-only built-in constant `MERGE_SAFE` carrying the canonical conflict-resolution guardrail: preserve BOTH sides for additive conflicts, never delete either branch's code to resolve, introduce no new behaviour, and escalate `RESOLVE: needs-review` when the correct resolution is not obvious. `MERGE_SAFE` SHALL be reserved (a custom constant SHALL NOT redefine it) and SHALL resolve wherever the `{{const:MERGE_SAFE}}` token appears.

#### Scenario: MERGE_SAFE resolves as a read-only built-in

- **WHEN** `{{const:MERGE_SAFE}}` appears in a prompt
- **THEN** it SHALL resolve to the canonical anti-destructive merge guardrail text

#### Scenario: MERGE_SAFE cannot be redefined

- **WHEN** a user attempts to create a custom constant named `MERGE_SAFE`
- **THEN** the operation SHALL be rejected because the name is a reserved built-in

### Requirement: Provider-aware resolve-merge command

The command catalog SHALL expose a `{{cmd:resolve-merge}}` magic command that resolves to each provider's native invocation (Claude, Codex, Gemini) with a self-contained prompt fallback for providers without one. It SHALL NOT be Claude-only. Its expansion SHALL embed `{{const:MERGE_SAFE}}` and instruct the agent to edit ONLY within the conflict markers.

#### Scenario: Expands per provider

- **WHEN** `{{cmd:resolve-merge}}` is expanded for a given provider
- **THEN** it SHALL produce that provider's native invocation, or the prompt fallback when the provider has none

#### Scenario: Carries the guardrail

- **WHEN** `{{cmd:resolve-merge}}` is expanded
- **THEN** the resulting text SHALL include the `MERGE_SAFE` guardrail and restrict edits to the conflicted hunks

#### Scenario: Available to non-Claude providers

- **WHEN** the resolver runs on a Codex or Gemini rail
- **THEN** `{{cmd:resolve-merge}}` SHALL expand successfully (it is not gated to Claude)

### Requirement: Bounded conflict-only resolution

The engine SHALL invoke the resolver with ONLY the conflicted files/hunks and a one-line description of the two branches — never the full spec nor unrestricted repository access. The resolver SHALL run as a single bounded turn and SHALL escalate rather than guess when no clean resolution exists. A non-clean or `needs-review` result SHALL be treated as `needs-review` by the merge-back; the resolver SHALL never directly accept a merge.

#### Scenario: Resolver sees only the conflict

- **WHEN** the engine invokes the resolver for a conflicted merge
- **THEN** the resolver's input SHALL be limited to the conflicted hunks plus a brief branch description

#### Scenario: Resolver escalates instead of guessing

- **WHEN** no clean resolution is obvious
- **THEN** the resolver SHALL return `needs-review` rather than fabricate a merge

#### Scenario: Resolver only proposes

- **WHEN** the resolver returns a resolution
- **THEN** the merge SHALL still be subject to integrated re-verification before the base is advanced

