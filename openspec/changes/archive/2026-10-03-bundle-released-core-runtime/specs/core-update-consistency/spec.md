## ADDED Requirements

### Requirement: Compatible published Core bundled by default

Desktop releases SHALL include an exact published compatible Core version with a vendored npm dependency lock containing resolved versions and integrity hashes. The release workflow's version assertion SHALL match the lock, and bundle smoke checks SHALL use a Node version supported by that Core package.

#### Scenario: Fresh Desktop installation
- **WHEN** Desktop is built with an updated bundled Core version
- **THEN** its offline Core resources contain that version and its complete locked runtime dependency tree
- **AND** the staged package passes the CLI and Desktop integration-contract checks

#### Scenario: Retained execution after a bundle update
- **WHEN** an existing execution is resumed after Desktop's bundled Core version changes
- **THEN** existing runtime-selection and recovery rules continue to preserve the execution's original runtime
