# Spec Delta

## Purpose

Let people set missions aside indefinitely without losing their history, and find, restore or discard them through explicit sidebar scopes.

## ADDED Requirements

### Requirement: Persistent reversible archive
The system SHALL persist a nullable archive timestamp independently of trash state. Archiving SHALL preserve history, attachments, sessions, project pin and favorite membership. Restoring SHALL clear only archive state. Existing missions SHALL start non-archived.

#### Scenario: Archive and reload
- **WHEN** an idle active mission is archived and the application restarts
- **THEN** its archive timestamp remains non-null, its history and metadata remain intact and it is excluded from Active

#### Scenario: Idempotent operations
- **WHEN** archive is repeated or restore is repeated
- **THEN** repeated archive retains the first timestamp and repeated restore leaves the mission active without duplicate effects

#### Scenario: Unknown or trashed mission
- **WHEN** archive or unarchive targets an unknown or trashed mission
- **THEN** the API returns not found and does not restore trash implicitly

### Requirement: Refuse archive while live
The system SHALL reject archiving a streaming mission or one with background agents/work, using HTTP 409 with an explanatory error and code MISSION_LIVE. Refusal SHALL leave mission state and running work unchanged.

#### Scenario: Streaming or background activity
- **WHEN** archive is requested during a streaming turn, reserved turn, background session or running background work
- **THEN** the request returns MISSION_LIVE without setting the archive timestamp, stopping agents or removing the row

#### Scenario: Idle resident session
- **WHEN** a mission has an idle resident session without running work
- **THEN** that alone does not prevent archive

### Requirement: Archive-scoped lists
The desktop list API SHALL accept active, archived or all archive scope, defaulting to active and rejecting invalid scope. All scopes SHALL exclude trashed missions. The mobile mission list SHALL exclude archived missions without adding mobile archive operations.

#### Scenario: Scope results
- **WHEN** active, archived and trashed missions exist
- **THEN** Active returns only non-archived non-trashed missions, Archived only archived non-trashed missions and All their union

#### Scenario: Invalid scope
- **WHEN** an unsupported archive scope is requested
- **THEN** the desktop API returns 400 instead of broadening the result

### Requirement: Sidebar archive selector
Expanded Mission mode SHALL show an accessible, localized Active / Archived / All selector beside Projects. Its default SHALL be Active. Selected scope SHALL apply to Favorites, Home and all project groups, independently of live-only state, and survive reload. Invalid storage SHALL fall back to Active; storage failure SHALL not break rendering.

#### Scenario: Placement and keyboard access
- **WHEN** expanded Mission mode is rendered
- **THEN** the selector is beside Projects, keyboard operable and exposes its selected option
- **AND** it is hidden when collapsed or outside Mission mode

#### Scenario: Persist and recover
- **WHEN** Archived or All is selected and the application reloads
- **THEN** that selection is restored
- **AND** a corrupt stored value falls back to Active

#### Scenario: Scoped groups and favorites
- **WHEN** a favorite project-pinned mission is archived
- **THEN** it appears only in Archived and All and retains both its favorite flag and project pin after restore

#### Scenario: Empty view
- **WHEN** Active or Archived has no matching missions after filters
- **THEN** a localized No active missions or No archived missions line is shown
- **AND** All with no matches also shows an explanatory empty state

### Requirement: Mission archive row actions
Non-archived rows SHALL offer Archive and no Delete. Archived rows SHALL offer Restore and confirmed Delete. Archived rows SHALL be muted, with an Archived marker in All. Successful archive of the open mission SHALL select a neighboring active mission or the empty Mission state without an error.

#### Scenario: Archive and restore journey
- **WHEN** a person archives a mission, selects Archived and restores that mission
- **THEN** it disappears from Active, appears in Archived, and returns to Active with its full history and original grouping

#### Scenario: Archive the open mission
- **WHEN** the open mission is successfully archived
- **THEN** the sidebar and center panel select a neighboring non-archived mission or the empty Mission state

#### Scenario: Failed archive
- **WHEN** archiving returns a conflict or transport failure
- **THEN** an explanatory localized error is shown and the current selection and row remain unchanged

### Requirement: Archived history is read-only
Archived missions SHALL remain openable for history reading, but SHALL not accept messages, queued input or new execution until restored. Server admission SHALL enforce this even for stale clients; restoring SHALL enable messaging again.

#### Scenario: Open archived history
- **WHEN** an archived mission is opened
- **THEN** its stored history is readable and the composer explains that restoration is required to send

#### Scenario: Direct send is refused
- **WHEN** a stale client attempts to send or enqueue work to an archived mission
- **THEN** the server returns a conflict without adding messages, input records or spawning work

### Requirement: Delete requires archive and preserves trash
The system SHALL reject deletion of a non-archived non-trashed mission with HTTP 409 and code NOT_ARCHIVED before stopping work. Confirmed Delete on an archived mission SHALL use the existing soft-delete path. Trash Undo, restore, permanent purge and 30-day retention SHALL remain unchanged, including for legacy trash without archive state.

#### Scenario: Direct active delete
- **WHEN** a client sends soft or permanent DELETE for a non-archived non-trashed mission
- **THEN** NOT_ARCHIVED is returned and no data or running work changes

#### Scenario: Confirmed archived delete
- **WHEN** Delete is confirmed for an archived mission
- **THEN** deleted_at is set and the mission enters existing 30-day trash with history retained until purge

#### Scenario: Undo returns to archive
- **WHEN** deletion of an archived mission is undone
- **THEN** deleted_at clears, archive state remains and the mission reappears in Archived and All

#### Scenario: Legacy trash expiry
- **WHEN** an existing trashed mission without an archive timestamp expires or is permanently purged
- **THEN** existing purge behavior still removes it without requiring a new archive operation
