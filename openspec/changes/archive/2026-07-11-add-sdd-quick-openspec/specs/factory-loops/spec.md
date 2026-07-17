## MODIFIED Requirements

### Requirement: Built-in factory loops

The app SHALL ship built-in "factory" loops for `implement`, `batch`, `freestyle`, and `SDD Quick (OpenSpec)`. They SHALL appear in the Loops gallery alongside user loops, marked read-only (locked), and SHALL NOT be editable in place. A "Fork to edit" action SHALL clone a factory loop into a new editable user draft, leaving the original unchanged.

The `SDD Quick (OpenSpec)` factory loop SHALL have a stable factory id and SHALL map to rail loop execution. Existing OpenSpec lifecycle factory ids SHALL remain resolvable for compatibility.

#### Scenario: Factory loops are listed and locked

- **WHEN** the Loops gallery is opened
- **THEN** the `implement`, `batch`, `freestyle`, and `SDD Quick (OpenSpec)` factory loops SHALL be listed as read-only (locked)
- **AND** they SHALL NOT expose Edit / Delete / Publish actions

#### Scenario: Forking a factory loop

- **WHEN** the user invokes "Fork to edit" on a factory loop
- **THEN** a new editable user loop SHALL be created as a clone of the factory loop's graph in `Draft` state
- **AND** the original factory loop SHALL remain unchanged

#### Scenario: OpenSpec factory compatibility is preserved

- **WHEN** a client launches an existing OpenSpec lifecycle factory id
- **THEN** the id SHALL continue to resolve to a valid OpenSpec lifecycle graph
- **AND** new recommendations SHALL prefer the `SDD Quick (OpenSpec)` product name
