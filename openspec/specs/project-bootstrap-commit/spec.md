# project-bootstrap-commit Specification

## Purpose
TBD - created by archiving change add-project-builder. Update Purpose after archive.
## Requirements
### Requirement: Commit mini-form
Before any disk mutation, the Builder SHALL present a mini-form: project name (prefilled from `product.name`), location (default `~/projects/<slug>`), provider multi-select (same semantics as AddProjectDialog: deduped, first = primary), and an optional "create private GitHub repo" checkbox enabled only when the prerequisites signal reports `gh` present AND authenticated. Nothing SHALL touch disk before the user confirms this form.

#### Scenario: gh checkbox gated
- **WHEN** `gh` is missing or `gh auth token` fails
- **THEN** the GitHub checkbox renders disabled with an explanatory hint

#### Scenario: No disk writes pre-confirm
- **WHEN** the user abandons the Builder at the mini-form
- **THEN** no directory, registry entry, workspace, or project row exists

### Requirement: Orchestrated commit endpoint and ordering
`POST /api/blueprint/commit` SHALL validate synchronously (target location writable and empty-or-absent, providers non-empty, exact raw generated blueprint schema-valid with 5–10 `m1Specs`, `specsComplete=true`, scaffold-first, every detailed spec satisfying the shared canonical field/section/criteria/priority/label/dependency quality contract, framework available under the runtime policy below, no existing registry entry for the target realpath) and reject with a named error plus actionable failing-spec/field detail before any mutation. Compatibility-normalized preview data SHALL NOT be accepted as evidence that invalid enums, dependencies, or missing fields were generated correctly. On acceptance it SHALL return 202 and execute steps in this exact order, streaming per-step progress over app-global `blueprint.commit_progress` WS events with terminal `blueprint.commit_done` / `blueprint.commit_failed`:

1. create target directory
2. `git init -b main` + deterministic README.md rendered from the pitch (no AI call) + initial commit
3. registry allocation + offline workspace assemble per selected provider
4. write `blueprint.json` + `blueprint.md` into the workspace
5. insert M1 tickets
6. register the project (LAST mutation before the optional remote)
7. best-effort `gh repo create --private --source . --push`

#### Scenario: Validation rejects dirty target
- **WHEN** the target directory exists and is non-empty
- **THEN** the endpoint returns a named validation error and no step runs

#### Scenario: Quality validation rejects before directory creation
- **WHEN** any M1 spec is shallow, has incorrect headings, has fewer than 2 Out-of-Scope or Technical bullets, duplicates embedded acceptance criteria, has fewer than 4 or more than 10 structured criteria, or points a dependency forward
- **THEN** the endpoint identifies the failing spec and field and runs no commit step

#### Scenario: Invalid raw enum is not repaired for commit
- **WHEN** the generated JSON contains an invalid priority or kind that the legacy read coercer could default
- **THEN** commit rejects the raw payload before directory creation rather than validating the normalized preview

#### Scenario: Register-last crash posture
- **WHEN** the process crashes after step 4 but before step 6
- **THEN** no project row exists, no project appears in the sidebar, and re-running with a clean location succeeds

#### Scenario: gh failure never aborts
- **WHEN** step 7 fails (auth, name taken, network)
- **THEN** the commit still reports success, the project is registered and usable, and the failure surfaces as a warning step

#### Scenario: Progress streaming
- **WHEN** the commit runs
- **THEN** each step emits a `blueprint.commit_progress` event with step id and status, and the terminal event names the created `projectId` on success

### Requirement: Offline workspace assemble (headless)
The commit SHALL assemble the project workspace through an extracted callable shared with `SetupManager`'s wizard path (extract-don't-fork: the wizard keeps its streaming/phase shell around the same function). It SHALL prefer the bundled framework and use no network when that bundle exists. If the bundle is absent in dev or another non-desktop runtime (`SPECRAILS_IS_DESKTOP !== '1'`), it SHALL fall back to `npx specrails-core`. If the bundle is absent or corrupt in a packaged desktop (`SPECRAILS_IS_DESKTOP='1'`), validation SHALL fail with a clear reinstall-app message before disk mutation; packaged desktop SHALL NOT take the npx fallback.

#### Scenario: Offline assemble
- **WHEN** the commit runs with network disabled and the bundled framework present
- **THEN** steps 1–6 complete successfully

#### Scenario: Missing bundle blocks early
- **WHEN** a packaged desktop has no usable bundled framework
- **THEN** validation rejects before any disk mutation and reports that the app must be reinstalled

#### Scenario: Dev can fall back to npx
- **WHEN** no bundle is available and the server is not a packaged desktop
- **THEN** assemble invokes `npx specrails-core` and project creation can continue

#### Scenario: Wizard unaffected
- **WHEN** the Existing-project setup wizard runs after the extraction
- **THEN** its install behavior (streaming, phases, npx fallback) is unchanged

### Requirement: M1 ticket insertion
Step 5 SHALL insert all quality-validated `m1Specs` as tickets with `status='todo'`, label `M1`, `source='project-builder'`, and `created_by='project-builder'` into the workspace ticket store via the existing surgical mutate path, preserving `m1Specs` order (scaffold first) and using the store's collision-safe id allocation. It SHALL persist the generated priority and short summary, retain domain labels alongside `M1`, map backward dependency indices to ticket prerequisites, and fold the separate 4–10 `acceptanceCriteria` exactly once into the canonical five-section description through the normal `formatDescriptionWithCriteria` helper. Inserted ticket ids SHALL be recorded as advisory `ticketIds` on the M1 milestone in `blueprint.json`. Board classification SHALL also recognize legacy Builder tickets with `source='manual'` and `created_by='project-builder'` so already-created projects require no migration.

#### Scenario: Tickets land as todo
- **WHEN** the commit completes with 6 `m1Specs`
- **THEN** the board shows 6 `todo` tickets labeled `M1` in spec order with Builder source/provenance, generated priority/summary/domain labels, mapped prerequisites, the five canonical base sections, and exactly one folded acceptance-criteria section

#### Scenario: Legacy Builder tickets stay visible
- **WHEN** an existing project contains M1 tickets with `source='manual'` and `created_by='project-builder'`
- **THEN** the board includes them in its spec population without rewriting the ticket store

#### Scenario: Advisory ids recorded
- **WHEN** tickets are inserted
- **THEN** `blueprint.json` milestone M1 carries their ids, and later manual deletion of a ticket does not break any Builder surface
