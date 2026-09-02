# code-explorer Specification

## Purpose

Read-only **Code** section per project for non-developers: virtualised file tree with provenance chips, Monaco viewer with AI summary header. Gated behind `VITE_FEATURE_CODE_EXPLORER` (client) and `SPECRAILS_CODE_EXPLORER` (server).

## Requirements

### Requirement: Code section sidebar entry and route

The app SHALL render a **Code** entry in the project's left sidebar (`ProjectLayout`) that navigates to the route `/code` for the active project, gated behind the client feature flag `VITE_FEATURE_CODE_EXPLORER` and the server feature flag `SPECRAILS_CODE_EXPLORER`.

#### Scenario: Sidebar entry hidden when client flag is off

- **WHEN** `VITE_FEATURE_CODE_EXPLORER` is unset or `"false"`
- **THEN** the **Code** sidebar entry MUST NOT render in `ProjectLayout`
- **AND** direct navigation to `/code` MUST redirect to the project home

#### Scenario: Sidebar entry visible and navigable when client flag is on

- **WHEN** `VITE_FEATURE_CODE_EXPLORER` is `"true"` and a project is active
- **THEN** the **Code** sidebar entry MUST render
- **AND** clicking it MUST navigate to `/code` for the active project
- **AND** the route MUST be preserved by `useProjectRouteMemory` across project switches

#### Scenario: Server router returns 404 when server flag is disabled

- **WHEN** `SPECRAILS_CODE_EXPLORER` is `"false"`
- **AND** the client requests any endpoint under `/api/projects/:projectId/code/**`
- **THEN** the server MUST respond with HTTP 404
- **AND** the client MUST show a "Code section is disabled" empty state

### Requirement: File tree with provenance badges and filters

The Code page SHALL render a virtualised file tree on the left with chip badges showing the tickets that created and/or modified each file, with a filter toggle that defaults to **Tocado por IA** (only files with provenance entries) and can be switched to **All files**. Repository enumeration SHALL be asynchronous, bounded, symlink-safe, and unable to monopolize the desktop server's HTTP or WebSocket control plane.

#### Scenario: Default filter shows only AI-touched files

- **WHEN** the user navigates to `/code` for the first time in a project
- **THEN** the tree filter MUST default to **Tocado por IA**
- **AND** the tree MUST only display files for which `file_provenance` has at least one row in the active project
- **AND** an empty tree MUST show copy that mentions running a job and offers the **All files** switch

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

### Requirement: File-summary watcher startup is isolated from reads

The server SHALL keep file-summary watcher initialization outside the latency-critical Code Explorer response path and SHALL constrain it with the same build-directory, dot-directory, and symlink policy as tree discovery.

#### Scenario: First Code Explorer request starts the watcher

- **WHEN** the first Code Explorer request for a project triggers watcher initialization
- **THEN** the read request MUST be able to complete without waiting for recursive watcher readiness
- **AND** watcher initialization MUST NOT follow symbolic links or enter denied build and dot directories

#### Scenario: Watcher initialization fails

- **WHEN** the watcher cannot initialize because of filesystem or resource pressure
- **THEN** the server MUST log the failure and continue serving read-only Code Explorer requests
- **AND** it MUST NOT terminate the desktop sidecar

### Requirement: File viewer with AI summary header

When the user opens a file, the page SHALL render an AI Summary header card above a read-only Monaco viewer, with the summary text, the originating ticket, the list of modifying tickets, a stale flag, and a ↻ regenerate button.

#### Scenario: File without summary shows generation prompt

- **WHEN** the user opens a file that has no `.specrails/file-summaries/<hash>.json` entry
- **THEN** the header MUST show copy explaining no summary exists yet
- **AND** the header MUST show a button "Generar resumen" that calls `POST /file/regenerate-summary`
- **AND** the viewer below MUST still render the file contents read-only

#### Scenario: File with fresh summary displays narrative header

- **WHEN** the user opens a file whose summary's `fileHash` matches the current content hash
- **THEN** the header MUST render the summary text
- **AND** the header MUST render the originating ticket as a clickable chip
- **AND** the header MUST render modifying tickets as clickable chips
- **AND** the header MUST NOT render a stale flag

#### Scenario: File with stale summary displays a stale banner

- **WHEN** the user opens a file whose summary's `fileHash` does not match the current content hash
- **THEN** the header MUST render the existing summary text
- **AND** the header MUST render a "Stale" badge next to the timestamp
- **AND** the header MUST render a ↻ regenerate button enabled by default

#### Scenario: Regenerate respects the budget cap and surfaces refusals

- **WHEN** the user clicks ↻ regenerate
- **AND** the project is over its monthly budget cap for `surface='file-summary'`
- **THEN** the client MUST show a confirmation prompting "Override budget?"
- **AND** confirming MUST resend the request with `overrideBudget: true`
- **AND** dismissing MUST cancel the regeneration with no side effects

#### Scenario: Binary and oversized files are refused gracefully

- **WHEN** the user opens a file the server identifies as binary or larger than 2 MB
- **THEN** the viewer MUST NOT load Monaco
- **AND** the viewer MUST show a "Binary file" or "File too large to preview" panel with the file's size and mime
- **AND** the AI summary header MUST still render if a summary exists, with a note that Monaco preview is disabled

#### Scenario: Monaco is lazy-loaded behind the feature flag

- **WHEN** the user navigates to `/code` for the first time in a session
- **AND** opens a previewable file
- **THEN** Monaco MUST be loaded via dynamic `import()` (not part of the main route chunk)
- **AND** a "Cargando editor…" skeleton MUST render until Monaco is ready
- **AND** subsequent file opens in the same session MUST reuse the loaded Monaco instance

### Requirement: Real-time updates from WebSocket events

The Code page SHALL subscribe to `file.provenance_updated`, `file.summary_updated`, and `file.summary_failed` WebSocket events, filter them by the active project id, and update the tree and open viewer without a full reload.

#### Scenario: Provenance event refreshes the tree row

- **WHEN** the active project receives `file.provenance_updated` for path `P`
- **THEN** the tree row for `P` MUST re-render with the updated badge set within 500 ms
- **AND** if `P` is currently open in the viewer, its modifying-tickets chip list MUST update

#### Scenario: Summary event refreshes the open viewer

- **WHEN** the active project receives `file.summary_updated` for path `P`
- **AND** `P` is currently open in the viewer
- **THEN** the AI Summary header MUST re-render with the new text and clear any "Stale" flag
- **AND** any "regenerating…" indicator MUST be dismissed

#### Scenario: Summary failure event surfaces a toast

- **WHEN** the active project receives `file.summary_failed` for path `P`
- **AND** `P` is currently open in the viewer
- **THEN** the client MUST show a sonner error toast with the failure reason
- **AND** the header's ↻ regenerate button MUST remain available

### Requirement: TicketDetailModal lists files touched by the ticket

The `TicketDetailModal` SHALL include a "Files touched by this ticket" section listing files from `file_provenance` for the modal's ticket, with each entry navigating to that file in the Code section on click.

#### Scenario: Files section renders when provenance exists

- **WHEN** the user opens `TicketDetailModal` for a ticket with at least one row in `file_provenance`
- **THEN** the modal MUST render a "Files touched by this ticket" section
- **AND** each file row MUST show the path and the kind (`created` or `modified`)

#### Scenario: Clicking a file navigates to the Code viewer

- **WHEN** the user clicks a file row in the modal
- **THEN** the app MUST navigate to `/code` for the active project
- **AND** the Code page MUST open that file in the viewer
- **AND** the modal MUST close

#### Scenario: Files section is hidden when no provenance exists

- **WHEN** the user opens `TicketDetailModal` for a ticket with no provenance rows
- **THEN** the modal MUST NOT render the "Files touched by this ticket" section
