## MODIFIED Requirements

### Requirement: File tree with provenance badges and filters

The Code page SHALL render a virtualised file tree on the left with chip badges showing the tickets that created and/or modified each file, with a filter toggle that defaults to **Tocado por IA** (only files with provenance entries) and can be switched to **All files**. Repository enumeration SHALL be asynchronous, bounded, symlink-safe, and unable to monopolize the desktop server's HTTP or WebSocket control plane.

#### Scenario: Default filter shows only AI-touched files

- **WHEN** the user navigates to `/code` for the first time in a project
- **THEN** the tree MUST default to **Tocado por IA**
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

## ADDED Requirements

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
