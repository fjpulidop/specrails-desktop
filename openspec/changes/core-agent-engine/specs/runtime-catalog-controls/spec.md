## ADDED Requirements

### Requirement: Additive runtime discovery
Desktop SHALL accept legacy runtime APIs and validate optional engine version, node kind version, node kind IDs and builtin descriptors when advertised.

#### Scenario: Legacy API
- **WHEN** Core omits v2 capability fields
- **THEN** legacy run and resume behavior remains available

#### Scenario: Malformed catalog
- **WHEN** Core advertises malformed catalog fields
- **THEN** Desktop rejects the protocol response before using the catalog

### Requirement: Core-owned definition validation
Desktop SHALL request definition validation through workflows validate --stdin only when Core advertises workflowDefinitions. It MUST preserve structured node errors, including exit-1 responses, and reject malformed output.

#### Scenario: Validation errors
- **WHEN** Core exits 1 with a valid validation result containing node errors
- **THEN** Desktop returns those errors unchanged

#### Scenario: Unavailable capability
- **WHEN** installed Core does not advertise definition validation
- **THEN** Desktop returns an actionable unsupported-capability error without invoking the verb

### Requirement: Run-owned step and role catalogs
Controls and metrics SHALL validate v2 node paths and role IDs against the run catalog and frozen runtime config. They SHALL preserve legacy validation when a catalog is absent.

#### Scenario: Custom nested nodes
- **WHEN** a v2 run contains six custom paths including implement/reviewer
- **THEN** controls and metrics accept those paths

#### Scenario: Unknown resume node
- **WHEN** resume targets a path absent from the loaded run
- **THEN** Desktop rejects it before invoking Core

#### Scenario: Open role metrics
- **WHEN** frozen config declares more than three roles
- **THEN** metrics accept only the declared roles without converting missing usage to zero
