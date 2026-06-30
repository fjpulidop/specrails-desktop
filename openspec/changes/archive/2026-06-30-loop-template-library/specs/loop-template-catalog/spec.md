## ADDED Requirements

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

The bundled template catalog SHALL contain at least 40 templates, collectively covering every category in the taxonomy. Every template SHALL be Specrails-owned: original naming and prompt text inspired by common closed-loop patterns, with NO third-party prose copied verbatim into the bundle. Every template's graph SHALL pass graph validation and SHALL contain a Loop Decider with exactly one `continue` edge and one `stop` edge.

#### Scenario: Catalog meets the size and coverage floor

- **WHEN** the bundled templates are enumerated
- **THEN** there SHALL be at least 40 templates
- **AND** at least one template SHALL exist for every category in the taxonomy

#### Scenario: Every template graph is publishable

- **WHEN** each template's graph is validated
- **THEN** validation SHALL pass (exactly one Start, at least one End, no dangling edges, no orphan nodes, sane config)
- **AND** the graph SHALL contain a Decider node whose outgoing edges include exactly one `continue` branch and exactly one `stop` branch

#### Scenario: Template identity is unique

- **WHEN** the catalog is enumerated
- **THEN** every template `id` SHALL be unique
- **AND** every template `name` SHALL be unique
- **AND** every template SHALL have a non-empty `description` and at least one tag

### Requirement: Deterministic Spec-To-Graph Porting

Templates SHALL be generated from a declarative per-template specification via a deterministic compile step, so that every generated graph is structurally consistent and valid. A step that corresponds to running a project gate (tests, lint, type-check, build, coverage, format) SHALL use the agent-driven magic command for that gate rather than a hardcoded shell command, preserving cross-stack portability. Any step that mutates code or tests SHALL inject the guardrails constant.

#### Scenario: Generated graphs are valid by construction

- **WHEN** a template is compiled from its declarative specification
- **THEN** the resulting graph SHALL pass graph validation without manual node placement

#### Scenario: Gate steps stay tooling-agnostic

- **WHEN** a template includes a step whose purpose is to run a project gate (e.g. the test suite or the linter)
- **THEN** that step SHALL reference the corresponding `{{cmd:*}}` magic command
- **AND** the template SHALL NOT hardcode a stack-specific shell command (e.g. `npm test`) as a Shell node

#### Scenario: Mutating steps carry the guardrails

- **WHEN** a template contains a step that modifies code or tests
- **THEN** that step's prompt SHALL include the `{{const:GUARDRAILS}}` token
