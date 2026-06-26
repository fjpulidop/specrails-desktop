## ADDED Requirements

### Requirement: Global Loops Section And Sidebar Entry

The app SHALL expose a single global "Loops" section at the route `/loops`, reachable from a dedicated sidebar entry placed ABOVE the project list and separated from it by a visible separator. The entry MUST NOT be rendered per-project, and activating it SHALL open a full-page surface (not a modal) that is not scoped to any active project.

#### Scenario: Sidebar entry sits above the project list

- **WHEN** the sidebar renders with the Loops feature enabled
- **THEN** a "Loops" entry SHALL appear above the project list
- **AND** a visible separator SHALL be rendered between the Loops entry and the project list

#### Scenario: Activating the entry opens a full-page surface

- **WHEN** the user clicks the "Loops" sidebar entry
- **THEN** the app SHALL navigate to the `/loops` route
- **AND** the section SHALL render as a full-page surface, not as a modal overlay
- **AND** the surface SHALL NOT require an active project to be selected

### Requirement: Feature Flag Gating

The Loops section and its API SHALL be gated by feature flags: `FEATURE_LOOPS_SECTION` on the client and `SPECRAILS_LOOPS_SECTION` on the server, both defaulting to ON (opt-out). When the server flag is set to the string `"false"`, every `/api/loops` route MUST return HTTP 404. When the client flag is set to the string `"false"`, the sidebar entry MUST be hidden and the `/loops` route MUST NOT be reachable.

#### Scenario: Server flag off returns 404

- **WHEN** `SPECRAILS_LOOPS_SECTION` equals the string `"false"`
- **THEN** any request to a `/api/loops` route SHALL respond with HTTP 404

#### Scenario: Client flag off hides the sidebar entry

- **WHEN** `FEATURE_LOOPS_SECTION` equals the string `"false"`
- **THEN** the "Loops" sidebar entry SHALL NOT be rendered
- **AND** navigating directly to `/loops` SHALL NOT render the Loops section

#### Scenario: Default state enables the section

- **WHEN** neither flag is set to the string `"false"`
- **THEN** the sidebar entry SHALL be visible and the `/api/loops` routes SHALL respond normally

### Requirement: Global Loop Definition Storage

Loop definitions SHALL be GLOBAL and shared across all projects. They MUST be persisted in the app-level desktop database (`desktop.sqlite`) in a `loops` table, NOT in any per-project database. A loop definition created or modified from one project context SHALL be visible and usable from every other project without duplication.

#### Scenario: Loop is visible across project contexts

- **WHEN** a loop definition is created while one project is active
- **THEN** the same loop definition SHALL appear in the Loops library regardless of which project is active afterward
- **AND** the definition SHALL be stored exactly once in the `desktop.sqlite` `loops` table

### Requirement: Loop Definition CRUD

The app SHALL provide create, read/list, update, and delete operations over global loop definitions via the `/api/loops` routes. Deleting a loop that is in the `Published` state MUST surface a confirmation that explicitly states the loop will disappear from every rail loop-mode picker before the deletion is committed.

#### Scenario: Create and list a loop definition

- **WHEN** the user creates a new loop definition
- **THEN** the loop SHALL be persisted in the global `loops` table
- **AND** a subsequent list request SHALL include the newly created loop

#### Scenario: Update a loop definition

- **WHEN** the user updates an existing loop definition's fields
- **THEN** the persisted definition SHALL reflect the updated fields
- **AND** the loop's identity SHALL be preserved across the update

#### Scenario: Deleting a Published loop confirms removal from pickers

- **WHEN** the user requests deletion of a loop whose lifecycle state is `Published`
- **THEN** the app SHALL show a confirmation stating the loop will disappear from every rail loop-mode picker
- **AND** the deletion SHALL be committed only after the user confirms

### Requirement: Loop Lifecycle States

Every loop definition SHALL carry a lifecycle state of exactly one of `Draft`, `Published`, or `Running`. ONLY loops in the `Published` state SHALL appear in the rail `mode=loop` picker. Publishing a loop SHALL run graph validation (delegated to the loop-builder-canvas capability) and MUST fail when validation fails, leaving the loop unpublished. Editing a `Published` loop SHALL return it to `Draft`. A loop that is currently executing SHALL be `Running` and read-only, and the library MUST display which project and rail are using it.

#### Scenario: Only Published loops appear in the rail picker

- **WHEN** the rail loop-mode picker is opened
- **THEN** only loops whose lifecycle state is `Published` SHALL be listed
- **AND** loops in `Draft` or `Running` state SHALL NOT be listed in that picker

#### Scenario: Publishing validates the graph

- **WHEN** the user attempts to publish a loop whose graph fails validation
- **THEN** the publish SHALL be rejected and the loop SHALL remain unpublished
- **WHEN** the user attempts to publish a loop whose graph passes validation
- **THEN** the loop's lifecycle state SHALL transition to `Published`

#### Scenario: Editing a Published loop returns it to Draft

- **WHEN** the user edits a loop whose lifecycle state is `Published`
- **THEN** the loop's lifecycle state SHALL transition to `Draft`

#### Scenario: A running loop is read-only and shows its consumer

- **WHEN** a loop is currently executing and its state is `Running`
- **THEN** the library SHALL render the loop as read-only
- **AND** the library SHALL display which project and which rail are using it

### Requirement: Specrails-Owned Starter Templates

The app SHALL bundle Specrails-owned starter loop templates with original Specrails text and naming (for example "Ship & Green", "Verify Pass", "CI Watch", "Lint & Fix", "Type Safe", "Coverage Climb", "Build Fix", "Deploy Check"). No third-party content SHALL be bundled. Templates MAY use the native authoring tokens (`{{spec.*}}` data tokens and `{{cmd:*}}` magic commands). A "Use template" action SHALL clone the selected template into a NEW loop definition in the `Draft` state owned by the user, leaving the original template unchanged.

#### Scenario: Use template clones into a new Draft

- **WHEN** the user invokes "Use template" on a Specrails starter template
- **THEN** a new loop definition SHALL be created in the `Draft` state
- **AND** the new definition SHALL be a clone of the template's content owned by the user
- **AND** the original template SHALL remain unchanged

#### Scenario: Bundled templates are Specrails-owned only

- **WHEN** the starter templates are listed
- **THEN** every listed template SHALL use Specrails-owned text and naming
- **AND** no third-party content SHALL be present among the bundled templates

### Requirement: Full Locale Coverage For Loops Strings

Every user-facing string in the Loops section SHALL be provided through a new `loops` i18n namespace and MUST be available in all 8 supported locales (`en`, `es`, `fr`, `de`, `pt`, `it`, `zh`, `ja`). No user-visible string in the section SHALL be hardcoded, and the locale key-parity test MUST enforce that every locale mirrors the English `loops` namespace key tree and placeholders exactly.

#### Scenario: New loops namespace exists in every locale

- **WHEN** the locale resources are loaded
- **THEN** a `loops` namespace SHALL exist for each of the 8 supported locales
- **AND** each locale's `loops` namespace SHALL contain the same key tree and `{{placeholders}}` as the English source

#### Scenario: Key-parity test enforces loops namespace

- **WHEN** the locale key-parity test runs
- **THEN** it SHALL include the `loops` namespace in its comparison
- **AND** it SHALL fail if any locale is missing a key or placeholder present in the English `loops` namespace
