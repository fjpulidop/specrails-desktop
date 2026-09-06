## MODIFIED Requirements

### Requirement: File tree with provenance badges and filters

The Code page SHALL render a virtualised file tree on the left with chip badges showing the tickets that created and/or modified each file, with a filter toggle that defaults to **All files** (with **Tocado por IA** available for recorded changes) and can be switched to **Tocado por IA**. Repository enumeration SHALL be asynchronous, bounded, symlink-safe, and unable to monopolize the desktop server's HTTP or WebSocket control plane.

#### Scenario: Default filter makes a new repository explorable

- **WHEN** the user navigates to `/code` for the first time in a project
- **THEN** the tree filter MUST default to **All files**
- **AND** the tree MUST display eligible files even when no provenance has been recorded
- **AND** an empty AI-touched tree MUST explain the filter and offer the **All files** switch

#### Scenario: All-files filter shows the full repo with deny-list applied

- **WHEN** the user switches the filter to **All files**
- **THEN** the tree MUST enumerate the project working tree without blocking unrelated HTTP or WebSocket handling
- **AND** the tree MUST exclude `node_modules`, `dist`, `.git`, `coverage`, `*.lock`, `*.log`, and dotfiles by default
- **AND** the tree MUST respect the project's `.gitignore` for additional exclusions
- **AND** the scanner MUST NOT follow symbolic links

#### Scenario: Repository exceeds a discovery safety bound

- **WHEN** an all-files scan reaches its configured entry or elapsed-time safety bound
- **THEN** the server MUST stop further discovery cooperatively
- **AND** it MUST return a typed truncated or retryable result instead of hanging, crashing, or silently claiming the tree is complete
- **AND** health, provider availability, and WebSocket traffic MUST remain responsive during the scan

#### Scenario: Concurrent pages share discovery work

- **WHEN** multiple requests page through the same project tree while a snapshot is being built or remains fresh
- **THEN** the server MUST deduplicate or reuse that scan rather than start one complete repository traversal per page

#### Scenario: Provenance badges render per file

- **WHEN** a file in the tree has provenance entries
- **THEN** each entry MUST render as a small chip showing the ticket id (e.g. `#42`)
- **AND** the chip representing the creating ticket MUST be visually distinguishable from the chips representing modifying tickets
- **AND** clicking any chip MUST open `TicketDetailModal` for that ticket without changing the current route

#### Scenario: Tree is virtualised and paginated

- **WHEN** the active project has more than 2000 visible entries
- **THEN** the tree MUST request entries in pages of at most 2000 from `GET /tree`
- **AND** scroll position MUST not block rendering of off-screen entries
- **AND** project-switch MUST not cause visible re-flicker thanks to `useProjectCache`

### Requirement: TicketDetailModal lists files touched by the ticket

The `TicketDetailModal` SHALL include a "Files touched by this ticket" section listing files from `file_provenance` for the modal's ticket across all project repositories, with each entry navigating to that file in the Code section on click.

#### Scenario: Files section renders when provenance exists

- **WHEN** the user opens `TicketDetailModal` for a ticket with at least one row in `file_provenance`
- **THEN** the modal MUST render a "Files touched by this ticket" section
- **AND** each file row MUST show repository identity, the path and the change kind

#### Scenario: Clicking a file navigates to the Code viewer

- **WHEN** the user clicks a file row in the modal
- **THEN** the app MUST navigate to `/code` for the active project
- **AND** the Code page MUST open that file in its recorded repository in the viewer
- **AND** the modal MUST close

#### Scenario: Files section is hidden when no provenance exists

- **WHEN** the user opens `TicketDetailModal` for a ticket with no provenance rows
- **THEN** the modal MUST NOT render the "Files touched by this ticket" section

## ADDED Requirements

### Requirement: Reader requests retain identity
Source, summary and history requests SHALL be scoped to project, repository and path and SHALL NOT overwrite a newer selection.

#### Scenario: Generation finishes after navigation
- **WHEN** summary or story generation for file A completes after opening B
- **THEN** the UI MUST continue displaying B and MUST NOT refetch A into B's reader

#### Scenario: Tree scan fails or reaches a bound
- **WHEN** a tree page fails or discovery is truncated
- **THEN** the UI MUST show an error/retry or explicit partial-result state and MUST NOT silently show an apparently complete empty tree
