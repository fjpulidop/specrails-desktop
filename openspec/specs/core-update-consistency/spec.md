# core-update-consistency Specification

## Purpose
TBD - created by archiving change implement-update-reliability. Update Purpose after archive.
## Requirements
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

### Requirement: Compatible published Core bundled by default

Desktop releases SHALL include an exact published compatible Core version with a vendored npm dependency lock containing resolved versions and integrity hashes. The release workflow's version assertion SHALL match the lock, and bundle smoke checks SHALL use a Node version supported by that Core package.

#### Scenario: Fresh Desktop installation
- **WHEN** Desktop is built with an updated bundled Core version
- **THEN** its offline Core resources contain that version and its complete locked runtime dependency tree
- **AND** the staged package passes the CLI and Desktop integration-contract checks

#### Scenario: Retained execution after a bundle update
- **WHEN** an existing execution is resumed after Desktop's bundled Core version changes
- **THEN** existing runtime-selection and recovery rules continue to preserve the execution's original runtime

