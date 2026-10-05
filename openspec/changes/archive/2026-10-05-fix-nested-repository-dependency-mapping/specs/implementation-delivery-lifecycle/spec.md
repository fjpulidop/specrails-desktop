## ADDED Requirements

### Requirement: Warm dependencies preserve registered checkout coordinates

When a registered repository is a subdirectory of a Git checkout, Desktop SHALL prepare its installed dependencies beneath the matching checkout-relative subdirectory of the isolated worktree. Package discovery SHALL remain bounded relative to the registered source and SHALL NOT widen repository ownership or Core execution scope. Writable dependency caches SHALL remain local to the worktree. Live cleanup evidence SHALL use worktree-relative paths and require exact, live source targets for both the projected layout and historical misplaced links. Preparation and authentication SHALL reject symlinked destination ancestors and SHALL NOT overwrite existing real installations or foreign links.

#### Scenario: A registered monorepo app has its own Yarn installation
- **WHEN** the registered source is `repo/apps/busuu-courses` with installed dependencies and Git creates a full-repository worktree
- **THEN** its package entries and Yarn state are available at `worktree/apps/busuu-courses/node_modules`
- **AND** they are not newly placed in worktree-root `node_modules` or sibling applications

#### Scenario: Nested packages remain discoverable after projection
- **WHEN** a child package within the registered source has installed dependencies within the supported discovery depth
- **THEN** preparation and later live authentication use its projected worktree path despite the added registration prefix

#### Scenario: A restarted release authenticates nested warm links
- **WHEN** cleanup reconstructs evidence using the original registered subdirectory
- **THEN** exact live warm links carry fingerprints at their projected worktree-relative paths
- **AND** real directories, replaced links and links reached through symlinked ancestors remain unauthorized

#### Scenario: A retained mount contains historical misplaced links
- **WHEN** the registered subdirectory's dependency links already exist at the old worktree-root location
- **THEN** preparation can add the correctly projected dependencies without deleting or replacing the old directory
- **AND** only historical entries still pointing at their exact live source retain cleanup authentication
