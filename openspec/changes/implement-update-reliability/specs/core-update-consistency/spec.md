## ADDED Requirements

### Requirement: Authoritative runtime and framework versions
Desktop SHALL distinguish the resolved Core package version from each project's installed framework version and registry latest version, with consistent values after restart.

#### Scenario: Newer compatible Core already installed
- **WHEN** the user updates Core and restarts Desktop
- **THEN** Desktop resolves the available compatible installation without silently downgrading and reports the version actually selected

### Requirement: Verified update publication
Core and Desktop SHALL report an update as successful only after verifying its artifacts, SHALL preserve custom files, and SHALL retain or restore the previous usable installation on failure.

#### Scenario: Failed framework update
- **WHEN** installing or relinking an update fails
- **THEN** the successful version marker does not advance and the previous usable artifacts remain recoverable

#### Scenario: Dry-run and partial update
- **WHEN** the user previews or applies only a subset of managed components
- **THEN** a preview makes no changes and a partial refresh does not claim a complete framework upgrade

### Requirement: Core 5 installation compatibility
Desktop SHALL install and update Core 5 using its deterministic CLI lifecycle without requiring removed enrichment commands.

#### Scenario: Project setup with Core 5
- **WHEN** a project installs its providers through Desktop
- **THEN** installation completes and available commands and reported framework version match the installed Core package

### Requirement: Fresh status and recoverable update errors
Update completion SHALL invalidate stale discovery/version caches. Offline or failed checks SHALL retain known installed-version information and expose a recoverable failure without pretending the update succeeded.

#### Scenario: Offline restart after successful update
- **WHEN** Desktop restarts without registry access
- **THEN** it retains accurate local package and project framework versions
