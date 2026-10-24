## ADDED Requirements

### Requirement: Specs carry an editable list of non-goals

A ticket SHALL accept an optional `nonGoals` list of strings, cleaned of list markers, blanks and duplicates and bounded to 20 items of 300 characters. Create, update and draft commit SHALL reject a value that is not an array of strings with HTTP 400. An empty list SHALL remove the field. Non-goals SHALL NOT be written back to Jira.

#### Scenario: Edit in the ticket modal
- **WHEN** the user edits **Out of scope** under the description and saves
- **THEN** `PATCH /tickets/:id` stores the cleaned list and the modal shows it one item per line

#### Scenario: Malformed value
- **WHEN** a client sends `nonGoals: "Mobile"`
- **THEN** the response is 400 `nonGoals must be an array of strings` and nothing is written

### Requirement: Spec generation fills the non-goals

Quick generation SHALL ask for 1 to 5 non-goals and SHALL move the generated `## Out of Scope` section into `nonGoals`, out of the description. A rewrite without the section SHALL keep the existing non-goals. Explore drafts SHALL carry `nonGoals` in the `spec-draft` block, and committing a draft SHALL use an explicit list or move a `## Out of Scope` section of the description.

#### Scenario: Quick spec
- **WHEN** the model answers with an Out of Scope section of two bullets
- **THEN** the new ticket has those two non-goals and its description has no Out of Scope section

### Requirement: Agents receive the non-goals

Every loop prompt and the Freestyle prompt SHALL receive the spec description with the non-goals appended as an `## Out of Scope` section, unless the description already contains one.

#### Scenario: Freestyle launch
- **WHEN** a spec with non-goals is launched in Freestyle
- **THEN** the prompt contains the description followed by `## Out of Scope` and the items
