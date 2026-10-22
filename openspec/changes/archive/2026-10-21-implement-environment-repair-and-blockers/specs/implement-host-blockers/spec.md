## ADDED Requirements

### Requirement: The Implement recipe routes host blockers to a dedicated terminal state

When the installed Core advertises `hostBlockers`, the Implement recipe SHALL compile both `verify` nodes with `hostBlockers: true` and `setup: 'configured'`, map their `blocked` outcome to a `host-blocked` end node with `blockerFrom`, and render the blocker's kind, reason and required action in that node's reason.

#### Scenario: Missing browser offline

- **WHEN** host verification ends with a `network` blocker for `npx playwright install chromium`
- **THEN** the run finishes at `host-blocked` with a reason that names the kind, the reason and the required action, and no correction round is counted

#### Scenario: Older Core

- **WHEN** the installed Core does not advertise `hostBlockers`
- **THEN** the recipe compiles the `verify` nodes without `hostBlockers`, `setup` or `blocked` edges and the definition validates against that Core

### Requirement: A fixer-declared blocker ends the run before the progress check

The fixer structured output SHALL accept an optional `blocker` object. The recipe SHALL evaluate `correction-blocker` after the fixer turn and route a present blocker to a `fixer-blocked` end node whose reason renders the kind, required action and evidence; otherwise it SHALL continue to `correction-progress`.

#### Scenario: Fixer reports an environment blocker without edits

- **WHEN** the fixer returns `{ summary, incomplete, blocker: { kind: 'environment', … } }` and leaves the candidate unchanged
- **THEN** the run ends at `fixer-blocked`, not `correction-stalled`

#### Scenario: Fixer repairs the code

- **WHEN** the fixer returns no `blocker` and the candidate hash changed
- **THEN** the run continues to `tasks` exactly as before

### Requirement: The loop log renders a structured blocker

The completion summary SHALL show a host blocker as "Blocked by the host environment" with the localized kind, the failing command and cwd, the required action and a button that copies the suggested command. The narration SHALL describe such an end as blocked rather than failed, and `[environment]` repair lines SHALL use the verification styling.

#### Scenario: Blocked completion

- **WHEN** a run completion carries `blocker`
- **THEN** the summary shows the blocked block with the kind label and the copy button, and the acceptance line reads "blocked"

#### Scenario: Historical completion

- **WHEN** a completion has no `blocker`
- **THEN** the summary renders exactly as before this change

### Requirement: The piece catalogs expose the opt-in outcome

The server piece catalog and the client authoring catalog SHALL list `blocked` among `verify` outcomes only when the node sets `hostBlockers: true`.

#### Scenario: Builder validation

- **WHEN** a custom loop sets `hostBlockers: true` on a verify node and maps `blocked`
- **THEN** graph validation accepts the edge; without the flag the same edge is rejected as an unknown outcome
