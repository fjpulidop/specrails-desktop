## MODIFIED Requirements

### Requirement: Loop Lifecycle States

Every loop definition SHALL carry a lifecycle state of exactly one of `Draft`, `Published`, or `Running`. ONLY loops in the `Published` state SHALL appear in the rail `mode=loop` picker. Publishing a loop SHALL run graph validation (delegated to the loop-builder-canvas capability) and MUST fail when validation fails, leaving the loop unpublished. Publishing SHALL record a snapshot of the published graph. Editing a `Published` loop SHALL return it to `Draft`. A user loop that is currently executing SHALL be `Running` and read-only, and the library MUST display which project and rail are using it. A built-in loop SHALL remain editable while it runs, because runs keep the graph they were launched with and rails keep launching the last published snapshot until the edit is published.

#### Scenario: Only Published loops appear in the rail picker

- **WHEN** the rail loop-mode picker is opened
- **THEN** only loops whose lifecycle state is `Published` SHALL be listed
- **AND** loops in `Draft` or `Running` state SHALL NOT be listed in that picker

#### Scenario: Publishing validates the graph

- **WHEN** the user attempts to publish a loop whose graph fails validation
- **THEN** the publish SHALL be rejected and the loop SHALL remain unpublished
- **WHEN** the user attempts to publish a loop whose graph passes validation
- **THEN** the loop's lifecycle state SHALL transition to `Published`
- **AND** the published graph SHALL be recorded as the loop's published snapshot

#### Scenario: Editing a Published loop returns it to Draft

- **WHEN** the user edits a loop whose lifecycle state is `Published`
- **THEN** the loop's lifecycle state SHALL transition to `Draft`

#### Scenario: A running loop is read-only and shows its consumer

- **WHEN** a user loop is currently executing and its state is `Running`
- **THEN** the library SHALL render the loop as read-only
- **AND** the library SHALL display which project and which rail are using it

#### Scenario: A running built-in stays editable

- **WHEN** the user edits a built-in loop while a run uses it
- **THEN** the edit SHALL be saved as `Draft`
- **AND** the running execution SHALL keep the graph it was launched with

## ADDED Requirements

### Requirement: Built-in loops cannot be deleted

Deleting or unpublishing a built-in loop SHALL be refused with `409` and error `builtin_loop`, and the message SHALL point the user to Restore original or Duplicate.

#### Scenario: Deleting a built-in

- **WHEN** a client deletes `factory:implement`
- **THEN** the request SHALL fail with `409 builtin_loop`
- **AND** the built-in SHALL remain in the library
