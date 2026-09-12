# file-provenance Specification

## Purpose

Per-project ledger linking files in the working tree to the tickets and jobs that created or modified them, surfaced by the Code section and `TicketDetailModal`.
## Requirements
### Requirement: Provenance table schema and persistence

The app SHALL persist file⇄ticket provenance in a per-project SQLite table `file_provenance` with columns `(id, file_path, ticket_id, job_id, kind, at)`, indexed on `(file_path)`, `(ticket_id)`, and `(at DESC)`. The `kind` column SHALL be constrained to one of `'created'`, `'modified'`, `'deleted'`.

#### Scenario: Schema migration runs idempotently

- **WHEN** the server starts against a project SQLite that already has the `file_provenance` table
- **THEN** the migration MUST NOT alter the existing schema
- **AND** the server MUST log a single "migration up-to-date" line

#### Scenario: Inserts validate the kind column

- **WHEN** an insert is attempted with `kind` outside `'created'|'modified'|'deleted'`
- **THEN** the insert MUST fail with a constraint violation
- **AND** the failure MUST not crash the job-completion hook

### Requirement: QueueManager records provenance after each job

`QueueManager` SHALL register a post-job-completion hook that diffs the working tree against the job's pre-spawn snapshot and inserts one `file_provenance` row per touched path, with `ticket_id` set to the primary ticket resolved from the job's command (or `NULL` when no ticket can be resolved).

#### Scenario: Successful job records created and modified files

- **WHEN** a job completes successfully and touched two new files plus one modified file
- **THEN** the hook MUST insert exactly three rows
- **AND** the new files MUST have `kind='created'`
- **AND** the modified file MUST have `kind='modified'`
- **AND** each row MUST set `job_id` to the job's id
- **AND** each row MUST set `at` to the job's exit timestamp

#### Scenario: Failed job still records provenance for changes that landed

- **WHEN** a job exits with non-zero status but touched two files before exit
- **THEN** the hook MUST still insert two rows
- **AND** the rows MUST be associated with the job's primary ticket if any

#### Scenario: Job touches no files

- **WHEN** a job completes without modifying the working tree
- **THEN** the hook MUST insert no rows
- **AND** the hook MUST broadcast no `file.provenance_updated` events

#### Scenario: Job touches more than 50 files

- **WHEN** a job's diff contains more than 50 touched paths
- **THEN** the hook MUST insert provenance rows for all touched paths
- **AND** the hook MUST emit a single warning log entry "provenance.large_job" with the file count

#### Scenario: Deleted file produces a tombstone row

- **WHEN** the diff includes a `D` status for path `P`
- **THEN** the hook MUST insert a single row with `file_path='P'` and `kind='deleted'`
- **AND** subsequent reads from `GET /tree` MUST exclude path `P`

#### Scenario: Renamed file produces a modified row and a tombstone

- **WHEN** the diff includes an `R` status from path `A` to path `B`
- **THEN** the hook MUST insert a row for `B` with `kind='modified'`
- **AND** the hook MUST insert a row for `A` with `kind='deleted'`
- **AND** the ticket and job ids on both rows MUST match

#### Scenario: Feature flag disabled skips the hook

- **WHEN** `SPECRAILS_CODE_EXPLORER` is `"false"` at job completion
- **THEN** the hook MUST exit early without computing a diff
- **AND** no rows MUST be inserted

### Requirement: REST endpoint to list provenance by ticket

The server SHALL expose `GET /api/projects/:projectId/code/provenance?ticketId=…` that returns all `file_provenance` rows for the ticket in the active project, ordered by `at DESC`.

#### Scenario: Endpoint returns rows for a known ticket

- **WHEN** the client requests provenance for a ticket that has three rows
- **THEN** the response MUST be HTTP 200 with a JSON array of three entries
- **AND** each entry MUST include `path`, `kind`, `jobId`, and `at`

#### Scenario: Endpoint returns empty array for an unknown ticket

- **WHEN** the client requests provenance for a ticket id that has no rows
- **THEN** the response MUST be HTTP 200 with an empty JSON array

#### Scenario: Endpoint is gated by the feature flag

- **WHEN** `SPECRAILS_CODE_EXPLORER` is `"false"`
- **THEN** the endpoint MUST respond with HTTP 404
- **AND** the body MUST NOT leak any provenance data

### Requirement: WebSocket broadcast on provenance changes

The app SHALL broadcast a `file.provenance_updated` WebSocket event scoped by `projectId` for every inserted or removed provenance row, with payload `{ projectId, path, kind, ticketId, jobId, at }`.

#### Scenario: Insert triggers a broadcast

- **WHEN** the hook inserts a row for path `P`
- **THEN** the server MUST broadcast `file.provenance_updated` with the row's fields
- **AND** the broadcast MUST include the active project id

#### Scenario: Multiple inserts within a job broadcast individually

- **WHEN** the hook inserts three rows during a single post-job pass
- **THEN** the server MUST emit three separate `file.provenance_updated` events
- **AND** the events MAY be coalesced into one frame at the transport layer

### Requirement: Bounded repository-aware activity
The server SHALL expose bounded recorded activity with stable repository/run/spec/path identity and SHALL apply the same path exclusions to aggregate activity and provenance as to file reads.

#### Scenario: Spec touches two repositories
- **WHEN** a spec has recorded changes in two project memberships
- **THEN** its files listing MUST include both repositories without conflating identical relative paths

#### Scenario: Excluded path in stored provenance
- **WHEN** aggregate activity or provenance includes a path excluded by explorer policy
- **THEN** that path MUST NOT be exposed by the listing

#### Scenario: Large activity history
- **WHEN** recorded history exceeds a page limit
- **THEN** the endpoint MUST return bounded results and explicit continuation or truncation metadata

