## ADDED Requirements

### Requirement: The intent is a solution-free document with five sections

The system SHALL model an intent as a document with the sections `problem` (non-empty), `outcome` (non-empty), `successSignals` (list), `affects` (list), `constraints` (list) and `openQuestions` (list of `{ question, answer? }`). An optional `hypothesis` SHALL hold the form "We believe X will produce Y; we will know when Z". The intent SHALL have no solution section. The domain model SHALL be pure: parsing, validation, normalisation (trimmed, bounded lengths, de-duplicated list items) and rendering SHALL have no I/O.

#### Scenario: A valid intent

- **WHEN** an intent with a problem, an outcome and any number of list items is validated
- **THEN** it SHALL be accepted and normalised

#### Scenario: An intent without a problem

- **WHEN** an intent with an empty `problem` or `outcome` is validated
- **THEN** it SHALL be rejected with the name of the missing section

#### Scenario: Oversized input is bounded

- **WHEN** a section exceeds its limit
- **THEN** the system SHALL truncate it at the limit on a character boundary and SHALL NOT fail

### Requirement: The intent has one canonical Markdown form

The system SHALL render an intent as Markdown headed `# Intent: <spec title>`, with one `##` section per non-empty field in the fixed order Problem, Outcome, How we will know, Who and what it affects, Constraints, Open questions. An answered open question SHALL render its answer under the question. Parsing that Markdown SHALL return the same intent (round trip), and parsing SHALL tolerate missing optional sections and unknown sections, which it ignores.

#### Scenario: Round trip

- **WHEN** an intent is rendered to Markdown and parsed back
- **THEN** the parsed intent SHALL equal the normalised original

#### Scenario: Hand-edited intent.md

- **WHEN** an `intent.md` lacks optional sections or carries an extra section
- **THEN** parsing SHALL succeed with the known sections

### Requirement: A spec stores its intent

A spec (ticket) SHALL carry an optional `intent` field holding the normalised intent. The field SHALL be additive: specs without an intent SHALL behave exactly as before, and reading an older store SHALL NOT require a migration. Creating or updating a spec through the API or MCP SHALL accept an intent and validate it. The intent SHALL stay local like non-goals: Jira sync SHALL NOT write it into the issue description (a Jira pull would otherwise fold it into `description`), and reading an issue SHALL never clear it.

#### Scenario: A spec created with an intent

- **WHEN** a spec is created with a valid intent
- **THEN** the spec SHALL be persisted with its normalised intent and returned with it

#### Scenario: Specs without an intent

- **WHEN** a spec without an intent is read, launched or synced
- **THEN** the behaviour SHALL be unchanged

### Requirement: The spec detail shows and edits the intent

The spec detail SHALL show an Intent section above the description when the spec has an intent: the problem, outcome, success signals, affects, constraints, and open questions with their answers or an "unanswered" state. A spec without an intent SHALL offer "Add intent". The person SHALL be able to edit each section in place, with validation errors shown inline. Spec cards SHALL show a compact intent mark when the spec has open questions without answers.

#### Scenario: Editing the outcome

- **WHEN** the person edits the outcome and saves
- **THEN** the spec SHALL be updated with the new intent and the detail SHALL show it

#### Scenario: Unanswered questions are visible on the board

- **WHEN** a spec's intent has unanswered open questions
- **THEN** its card SHALL show the open-questions mark with the count

### Requirement: Agents receive the intent

Every agent that works on a spec with an intent SHALL receive it as Markdown context, explicitly marked as the source of truth for *why* and *what outcome* and never for *how*. This covers the mission operator reading a spec, the first Explore turn, the Flow → Spec deriver summary, and the Implement run briefing read by architect, developer and reviewer. The reviewer briefing SHALL ask for the work to be judged against the outcome and success signals in addition to the acceptance criteria.

#### Scenario: An Implement run on a spec with an intent

- **WHEN** a rail runs a spec that has an intent
- **THEN** the run briefing SHALL contain the rendered intent and the reviewer instruction about outcome and success signals

#### Scenario: An Explore derivation

- **WHEN** a Flow → Spec run derives the change of an Explore session whose spec has an intent
- **THEN** the derive summary file SHALL start with the rendered intent and stay within the summary byte limit

### Requirement: The delivered change carries intent.md

When a delivery commits the work of a spec that has an intent, Desktop SHALL write the rendered intent as `intent.md` into the run's OpenSpec change directory before the delivery commit. That directory is `openspec/changes/<change>/`, or `openspec/changes/archive/<date>-<change>/` when the run archived it. An existing `intent.md` with the same content SHALL be left untouched. A run without an OpenSpec change, or a project without OpenSpec, SHALL skip the step. A failure SHALL be recorded as a delivery warning and SHALL NOT fail the delivery. The file SHALL count as part of the run's own change for every delivery path guard.

#### Scenario: A run that archived its change

- **WHEN** an Implement run on a spec with an intent archives `openspec/changes/my-change`
- **THEN** the delivery commit SHALL contain `openspec/changes/archive/<date>-my-change/intent.md` with the rendered intent

#### Scenario: Intent materialisation fails

- **WHEN** writing `intent.md` fails
- **THEN** the delivery SHALL continue and record a warning naming the failure
