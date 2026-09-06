## ADDED Requirements

### Requirement: Releases require verification of their source revision
Publication MUST validate the release version and require successful quality checks for the exact source revision being distributed.

#### Scenario: Unverified revision
- **WHEN** checks are failed, cancelled, absent, or belong to another commit
- **THEN** the release SHALL remain unpublished by the distribution job.

### Requirement: npm payloads are checked before publishing
The system SHALL validate executable entrypoints and required runtime files in the generated npm tarball before publication.

#### Scenario: Missing runtime asset
- **WHEN** a build succeeds but the tarball omits a required runtime asset
- **THEN** the package check SHALL fail before npm publication.

### Requirement: Mutable channels preserve newer releases
Desktop publication SHALL serialize changes to its latest channel and reject attempts to replace a newer version with an older release.

#### Scenario: Late older build
- **WHEN** an older tag finishes after a newer version is already live
- **THEN** latest SHALL continue to reference the newer version.

### Requirement: Compatibility checks cannot silently skip
Core compatibility notifications SHALL validate the requested exact version and fail if the integration contract cannot be found or checked.

#### Scenario: Contract unavailable
- **WHEN** a dispatch installs a package without a readable integration contract
- **THEN** compatibility SHALL fail instead of reporting success.

### Requirement: Documentation reflects executable workflows
Both READMEs SHALL describe reproducible installation, development and update commands, and distinguish native functionality and unverified platform acceptance.

#### Scenario: Native development onboarding
- **WHEN** a contributor follows Desktop's native development instructions
- **THEN** the instructions SHALL identify required tools, automatic frontend/backend preparation, fixed ports, and the lack of an installer requirement.
