# loop-template-catalog Specification

## Purpose
TBD - created by archiving change loop-template-library. Update Purpose after archive.

## Requirements

### Requirement: Template Category Field And Taxonomy

Every bundled loop template SHALL declare a `category` drawn from a fixed taxonomy of exactly these 15 values: `API`, `Automation`, `CI`, `Database`, `Debugging`, `DevOps`, `Docs`, `Git`, `Maintenance`, `Performance`, `Planning`, `Quality`, `Review`, `Security`, `Testing`. The taxonomy SHALL be exported as a single source of truth and the template-list API response SHALL include each template's `category`.

#### Scenario: Every template has a taxonomy-valid category

- **WHEN** the bundled templates are enumerated
- **THEN** each template SHALL carry a `category` field
- **AND** each `category` value SHALL be a member of the 15-value taxonomy

#### Scenario: Template API exposes category

- **WHEN** a client requests `GET /api/loop-templates`
- **THEN** each returned template SHALL include its `category` alongside `id`, `name`, `description`, `tags`, and `graph`

#### Scenario: Existing templates are categorised

- **WHEN** the eight pre-existing templates are listed
- **THEN** each SHALL have a non-empty `category` from the taxonomy
- **AND** their `id` and `name` SHALL be unchanged from before this change

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
