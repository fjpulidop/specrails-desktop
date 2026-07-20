# blueprint-protocol Specification

## Purpose
TBD - created by archiving change add-project-builder. Update Purpose after archive.
## Requirements
### Requirement: blueprint-draft fenced-JSON contract
Assistant messages SHALL communicate blueprint state exclusively through fenced ```` ```blueprint-draft ```` JSON blocks. Each block SHALL be a FULL snapshot of the blueprint (never a delta). When a message contains multiple blocks, the LAST syntactically valid block wins. During streaming, an unterminated trailing block SHALL be ignored until its closing fence arrives. Parsing SHALL live in a pure server module (`blueprint-draft-parser`) with a client mirror, both adapting the `spec-draft-parser.ts` mechanics. A successful parse SHALL retain both a compatibility-normalized `Blueprint` for display/read and the exact parsed JSON payload before defaults/drop rules for readiness and commit validation.

#### Scenario: Last valid wins
- **WHEN** a message contains two `blueprint-draft` blocks and the second is valid
- **THEN** the second block's snapshot replaces the first entirely

#### Scenario: Malformed block ignored
- **WHEN** the only block in a message fails JSON parsing or schema validation
- **THEN** the previous snapshot is retained and no error surfaces to the user

#### Scenario: Streaming tail cut
- **WHEN** the stream has emitted an opening fence but not yet the closing fence
- **THEN** the parser does not attempt to parse the incomplete block

#### Scenario: Compatibility normalization cannot hide an invalid generated field
- **WHEN** a syntactically valid block contains an invalid priority, kind, dependency, or omitted required rich field that the read parser would default or drop
- **THEN** preview may use the normalized view, but readiness and commit validate the retained raw JSON and reject it

### Requirement: Blueprint schema
The blueprint snapshot SHALL carry: `blueprintVersion` (integer, 1), `product {name, pitch, audience}`, `coreFlow` (string), `platform` (string), `stack {language, framework, db, notes?}`, `assumptions[]` (strings), `milestones[]` (`{id, title, goal, status, plannedSpecs[]}` where `status ∈ planned|committed|done`), `specsComplete` (boolean), and `m1Specs[]` (`{kind, title, shortSummary, description, acceptanceCriteria[], priority, labels[], dependsOnIndex?}`). `kind` SHALL be `scaffold|feature|verification`; priority SHALL be `low|medium|high|critical`. Unknown keys SHALL be dropped on parse; a missing or non-integer `blueprintVersion` SHALL reject the block. M2+ milestones SHALL carry only `plannedSpecs` titles — never detailed descriptions — until that milestone is explicitly generated. For backward-compatible reads of version-1 blueprints, missing rich fields SHALL default to `specsComplete=false`, `kind='feature'`, an empty summary, an empty criteria array, and `priority='medium'`; these defaults SHALL NOT make a legacy snapshot committable under the strict quality gate.

#### Scenario: Unknown keys tolerated
- **WHEN** a block includes an unrecognized top-level key
- **THEN** parsing succeeds and the key is dropped

#### Scenario: Version gate
- **WHEN** a block omits `blueprintVersion`
- **THEN** the block is treated as invalid

#### Scenario: Legacy rich fields default on read
- **WHEN** an existing version-1 blueprint omits `specsComplete`, kind, summary, criteria, or priority
- **THEN** client preview and server `readBlueprint` retain the snapshot using the documented defaults rather than requiring a migration

### Requirement: Canonical rich detailed-spec contract
Every detailed Builder spec SHALL contain an English action-oriented unique title, a one-sentence `shortSummary` no longer than 240 characters, a valid kind and priority, non-empty domain labels, 4–10 separate non-empty independently testable `acceptanceCriteria`, and an optional `dependsOnIndex` that points strictly to an earlier spec. Its `description` SHALL contain exactly these non-empty `##` sections, once and in order: `Problem Statement`, `Proposed Solution`, `Out of Scope`, `Technical Considerations`, `Estimated Complexity`. `Out of Scope` and `Technical Considerations` SHALL each contain at least 2 bullets. The description SHALL NOT contain `## Acceptance Criteria`; ticket persistence SHALL fold the structured criteria into one such section through the normal helper.

#### Scenario: Rich spec matches normal Specrails shape
- **WHEN** a complete detailed spec is emitted
- **THEN** its five canonical description sections, separate criteria, summary, priority, kind, labels, and dependency are preserved in the full snapshot

#### Scenario: Acceptance criteria remain separate
- **WHEN** a generated description already contains an `## Acceptance Criteria` heading
- **THEN** the quality gate rejects it instead of allowing duplicated criteria in the eventual Board ticket

### Requirement: Single-response complete M1 generation
Interview and Surprise Me snapshots SHALL populate the five blueprint dimensions while keeping `m1Specs` empty and `specsComplete=false`. Only explicit user approval or a direct request to generate the backlog SHALL start detailed generation. The agent SHALL then emit the entire 5–10-spec M1 walking skeleton in ONE assistant response containing ONE full fenced snapshot. It SHALL NOT emit closed partial 2–3-spec snapshots or leave an incomplete subset as the latest commit-ready state. That complete snapshot SHALL set `specsComplete=true` only after self-validating every spec against the canonical contract. `m1Specs[0]` SHALL be explicitly `kind='scaffold'` and SHALL omit `dependsOnIndex`; every later dependency SHALL point strictly backward. Day-0 Technical Considerations SHALL reference the planned stack, components, contracts, risks, and inter-spec dependencies without inventing repository paths; the scaffold spec SHALL note the repo already contains a README and define run, test, and CI outcomes.

#### Scenario: Approval precedes spec generation
- **WHEN** the Builder proposes a complete blueprint through interview or Surprise Me but the user has not approved generation
- **THEN** the snapshot contains no `m1Specs`, keeps `specsComplete=false`, and invites approval

#### Scenario: Complete set arrives atomically
- **WHEN** generation begins on a blueprint targeting 7 M1 specs
- **THEN** the next assistant response contains one full snapshot with all 7 specs and `specsComplete=true`

#### Scenario: Scaffold first
- **WHEN** the complete generation response arrives
- **THEN** `m1Specs[0]` is `kind='scaffold'`, describes the chosen stack truthfully, and has no dependency

#### Scenario: Completion flag waits for the full quality bar
- **WHEN** generation cannot produce the entire intended set or any spec fails self-validation
- **THEN** it does not publish a completed generation snapshot and no partial subset becomes committable

### Requirement: Blueprint persistence pair
On day-0 commit, the system SHALL write `<workspace>/.specrails/blueprint.json` (source of truth for the full M1 snapshot including `specsComplete` and every M1 rich-spec field, plus the milestone roadmap/status machine and advisory per-milestone `ticketIds`) and `<workspace>/.specrails/blueprint.md` (deterministic render regenerated on every json write, never hand-edited). Neither file SHALL be written into the project repo. Milestone status transitions SHALL be `planned → committed → done`. The version-1 blueprint SHALL NOT invent a detailed-M2-per-milestone field: after M2+ commit it SHALL retain only that milestone's status and advisory ticket IDs, while the created tickets SHALL be authoritative for the detailed M2+ content.

#### Scenario: Repo stays pristine
- **WHEN** the orchestrated commit completes
- **THEN** the repo contains only `README.md` and git metadata; `blueprint.json`/`blueprint.md` live under the workspace `.specrails/`

#### Scenario: Deterministic render
- **WHEN** `blueprint.json` is written twice with identical content
- **THEN** the rendered `blueprint.md` bytes are identical

#### Scenario: Milestone commit transition
- **WHEN** M2 specs are committed to the board
- **THEN** milestone `m2.status` flips from `planned` to `committed`, its advisory ticket IDs are recorded, `blueprint.md` re-renders, and no detailed M2 array is added to the blueprint schema
