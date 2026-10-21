## MODIFIED Requirements

### Requirement: Expanded Specrails-Owned Template Catalog

The bundled template catalog SHALL contain exactly the Core-native starters: `ship-and-green`, `verify-pass`, `ci-watch`, `lint-and-fix`, `type-safe`, `coverage-climb`, `build-fix` and `deploy-check`. When the selected Core advertises both `engineV2: 1` and `workflowDefinitions: 1`, each starter SHALL be served as a Core definition graph; otherwise it SHALL be served as its equivalent legacy graph. Templates that exist only as legacy graphs SHALL NOT be bundled. Every template SHALL be Specrails-owned, with NO third-party prose copied verbatim. Every template's graph SHALL pass graph validation.

#### Scenario: Catalog is exactly the Core-native starters

- **WHEN** the bundled templates are enumerated
- **THEN** their ids SHALL be exactly the eight Core-native starters, in that order
- **AND** no legacy-only template (for example `opsx-lifecycle` or `autoloop-tdd`) SHALL be listed

#### Scenario: Removed template ids are not found

- **WHEN** a client creates a loop from a removed template id
- **THEN** the request SHALL fail with 404
- **AND** loops previously cloned from that template SHALL keep their stored graph

#### Scenario: Every template graph is publishable

- **WHEN** each template's graph is validated
- **THEN** validation SHALL pass (exactly one Start, at least one End, no dangling edges, no orphan nodes, sane config)
- **AND** every legacy Decider SHALL have exactly one `continue` branch and exactly one `stop` branch

#### Scenario: Template identity is unique

- **WHEN** the catalog is enumerated
- **THEN** every template `id` SHALL be unique
- **AND** every template `name` SHALL be unique
- **AND** every template SHALL have a non-empty `description` and at least one tag

## REMOVED Requirements

### Requirement: Deterministic Spec-To-Graph Porting

**Reason**: The ported templates were legacy-only graphs that a Core without engine 1 refuses to run; they were removed from the catalog.
**Migration**: None. Previously cloned loops keep their stored graph and can be converted with "Convert to Core".

### Requirement: OpenSpec Lifecycle Template Registration

**Reason**: `opsx-lifecycle` duplicated the editable `factory:sdd-quick-openspec` built-in.
**Migration**: Use the SDD Quick (OpenSpec) built-in loop, which can be edited in place.
