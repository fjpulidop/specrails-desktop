## ADDED Requirements

### Requirement: Run-Scoped Captured Variables

The loop runner SHALL support capturing a value from an ai-step's output during a run and exposing it to subsequent token resolution as a `{{run.<name>}}` token. The first capture defined by this change is `{{run.changeId}}`: after the first `opsx:ff` step, the runner SHALL extract the OpenSpec change id by matching `openspec/changes/<id>` in the step output (the same detection pattern used by `SpecLauncherManager`) and store it on run state. The token SHALL be resolvable in later ai-step prompts AND in `shell` node commands. Before any value is captured, `{{run.<name>}}` SHALL resolve to an empty string rather than remaining as a literal token. Run-token resolution SHALL be applied within the existing prompt/shell substitution pipeline (after `{{cmd:*}}` and `{{spec.*}}`).

#### Scenario: Change id captured from ff output
- **WHEN** the first `opsx:ff` step emits output containing `openspec/changes/my-change`
- **THEN** the runner stores `my-change` as the run's `changeId`

#### Scenario: Captured token resolves in a later step
- **WHEN** a later ai-step prompt or shell command contains `{{run.changeId}}` after capture
- **THEN** the token resolves to the captured change id

#### Scenario: Uncaptured token resolves to empty
- **WHEN** `{{run.changeId}}` is resolved before any change id has been captured
- **THEN** the token resolves to an empty string

#### Scenario: First match wins on multiple ids
- **WHEN** the ff output mentions more than one `openspec/changes/<id>` path
- **THEN** the runner captures the first matched id
