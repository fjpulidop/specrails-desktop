## MODIFIED Requirements

### Requirement: Built-in factory loops

The app SHALL ship built-in loops for `implement`, `freestyle` and `SDD Quick (OpenSpec)` as real, editable loops stored in the global loops library, each under its canonical factory id (`factory:implement`, `factory:freestyle`, `factory:sdd-quick-openspec`). The Freestyle built-in SHALL be created only when a provider supports Freestyle. Built-ins SHALL be listed in the Loops library with a Built-in badge and SHALL offer Edit, Duplicate and Restore original, but not Delete or Fork to edit. Editing and publishing a built-in SHALL change that built-in for every rail, agent-chat launch, MCP launch and companion launch that uses its id. Duplicate SHALL create an ordinary user loop and leave the built-in unchanged.

The `SDD Quick (OpenSpec)` built-in SHALL have a stable factory id and SHALL map to rail loop execution. Compatibility factory ids (`factory:batch`, `factory:openspec`, `factory:revision`) SHALL remain resolvable and SHALL NOT be created as editable rows.

#### Scenario: Built-ins are listed as editable loops

- **WHEN** the Loops library is opened
- **THEN** the `implement`, `freestyle` (when supported) and `SDD Quick (OpenSpec)` built-ins SHALL be listed once each with a Built-in badge
- **AND** they SHALL expose Edit and Duplicate, and SHALL NOT expose Delete or Fork to edit

#### Scenario: Editing a built-in changes it everywhere

- **WHEN** the user edits the `factory:implement` built-in and publishes it
- **THEN** every subsequent launch of `factory:implement`, from any surface, SHALL run the published edited graph

#### Scenario: Duplicating a built-in

- **WHEN** the user duplicates a built-in (or calls the fork endpoint for it)
- **THEN** a new user loop SHALL be created in `Draft` from the built-in's current content
- **AND** the built-in SHALL remain unchanged

#### Scenario: OpenSpec factory compatibility is preserved

- **WHEN** a client launches an existing OpenSpec lifecycle factory id
- **THEN** the id SHALL continue to resolve to the `SDD Quick (OpenSpec)` built-in
- **AND** new recommendations SHALL prefer the `SDD Quick (OpenSpec)` product name

## ADDED Requirements

### Requirement: Built-in seeding follows the Core default without overwriting edits

The app SHALL seed missing built-in rows idempotently, as Published, using the default graph for the selected Core's capabilities. It SHALL record the hash of the seeded default. When Core capabilities are known and the default changes, the app SHALL refresh a built-in row whose content still equals its seeded default, and SHALL NOT change a row the user edited. When Core cannot be loaded, the app SHALL seed missing rows with the legacy default and SHALL leave existing rows unchanged. An existing Freestyle row SHALL be kept when no provider supports Freestyle.

#### Scenario: Core upgrade refreshes an unedited built-in

- **WHEN** a built-in was seeded with the legacy default and Core later advertises workflow definitions
- **THEN** the unedited built-in SHALL be refreshed to the Core definition default

#### Scenario: User edits survive a default change

- **WHEN** the user edited a built-in and the default later changes
- **THEN** the built-in SHALL keep the user's content

#### Scenario: Concurrent seeding

- **WHEN** two seeding passes run at the same time
- **THEN** exactly one row SHALL exist per built-in

### Requirement: Restore original

The app SHALL reset a built-in to the current default for the selected Core (name, description and graph), mark it Published and record the new default hash. Restoring SHALL be refused while the built-in is running.

#### Scenario: Restoring an edited built-in

- **WHEN** the user restores an edited built-in
- **THEN** the built-in SHALL equal the current default and be Published
- **AND** later launches SHALL run the default
