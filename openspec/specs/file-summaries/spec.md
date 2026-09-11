# file-summaries Specification

## Purpose

AI-generated plain-language summaries of files in a project, hash-gated against re-generation and budgeted against monthly app-wide spend. Powers the Code section's file viewer header.
## Requirements
### Requirement: Summary persistence layout

The app SHALL persist per-file AI summaries as JSON files under `<project>/.specrails/file-summaries/<sha256-of-relative-path>.json`, each conforming to a versioned schema with fields `schemaVersion`, `path`, `fileHash`, `summary`, `language`, `generatedAt`, `generatedBy`, and `triggeredBy`.

#### Scenario: Summary written after successful generation

- **WHEN** `FileSummaryManager` completes a successful generation for path `P`
- **THEN** the corresponding JSON file MUST be written atomically (temp + rename)
- **AND** the file MUST contain all required schema fields
- **AND** `schemaVersion` MUST be `1`
- **AND** `fileHash` MUST equal the sha256 of the file contents used as input

#### Scenario: Summary read returns null for unknown path

- **WHEN** no JSON file exists for path `P`
- **THEN** the manager's `readSummary(P)` MUST return null
- **AND** no error MUST be thrown

#### Scenario: Path with non-ASCII characters is hashed consistently

- **WHEN** the relative path contains non-ASCII characters
- **THEN** the sha256 hash of the path MUST be computed against its UTF-8 byte representation
- **AND** subsequent reads MUST find the same file

### Requirement: Hash-gated regeneration

`FileSummaryManager` SHALL refuse to regenerate a summary when the existing summary's `fileHash` already matches the current file contents' sha256.

#### Scenario: Unchanged content does not re-spend tokens

- **WHEN** a regeneration is requested for path `P`
- **AND** the existing summary's `fileHash` matches the current file hash
- **THEN** the manager MUST NOT spawn a model call
- **AND** the manager MUST NOT write to `ai_invocations`
- **AND** the manager MAY broadcast a `file.summary_updated` event with the existing payload

#### Scenario: Changed content triggers regeneration

- **WHEN** a regeneration is requested for path `P`
- **AND** the existing summary's `fileHash` differs from the current file hash
- **THEN** the manager MUST enqueue a model call
- **AND** on success the manager MUST overwrite the JSON file with the new hash and summary

#### Scenario: Missing existing summary always regenerates

- **WHEN** a regeneration is requested for path `P`
- **AND** no JSON file exists for `P`
- **THEN** the manager MUST enqueue a model call

### Requirement: Concurrency and per-job caps

`FileSummaryManager` SHALL cap concurrency at 2 in-flight generations per project and 8 app-wide, and SHALL refuse to enqueue more than 50 regenerations triggered by a single job.

#### Scenario: Third in-flight per project queues

- **WHEN** the manager already has 2 in-flight generations for the active project
- **AND** a fourth regeneration is requested for the same project
- **THEN** the new request MUST queue
- **AND** the queue entry MUST drop with a `file.summary_skipped` event if not started within 5 minutes

#### Scenario: Job with 60 touched files enqueues at most 50

- **WHEN** the QueueManager hook reports 60 touched files for one job
- **AND** all 60 have changed content hashes
- **THEN** the manager MUST enqueue exactly 50 generations
- **AND** the remaining 10 MUST each emit `file.summary_skipped` with `reason='per-job-cap'`

### Requirement: Monthly budget cap

`FileSummaryManager` SHALL refuse non-user-initiated regenerations when the current month's `ai_invocations` spend with `surface='file-summary'` for the project meets or exceeds the app-wide `summary_monthly_budget_usd` setting.

#### Scenario: Spend below budget proceeds normally

- **WHEN** the month-to-date spend is below the budget
- **THEN** the manager MUST proceed with regeneration

#### Scenario: Spend at or above budget skips automatic regeneration

- **WHEN** the month-to-date spend equals or exceeds the budget
- **AND** a regeneration is requested by the QueueManager hook
- **THEN** the manager MUST NOT spawn a model call
- **AND** the manager MUST emit `file.summary_skipped` with `reason='budget'`

#### Scenario: User-initiated regeneration with override bypasses the cap

- **WHEN** the client calls `POST /file/regenerate-summary` with `overrideBudget: true`
- **AND** the month-to-date spend exceeds the budget
- **THEN** the manager MUST proceed with regeneration
- **AND** the resulting `ai_invocations` row MUST still be written with `surface='file-summary'`

### Requirement: Cost is recorded in `ai_invocations`

Every model call made by `FileSummaryManager` SHALL write a row to `ai_invocations` with `surface='file-summary'` and the standard cost/token/duration fields, identical in shape to other surfaces.

#### Scenario: Successful generation persists an invocation row

- **WHEN** a generation succeeds
- **THEN** an `ai_invocations` row MUST be inserted with `surface='file-summary'`, `status='completed'`, `model='claude-haiku-4-5'` (or the configured model), and populated cost/token fields
- **AND** the server MUST broadcast `spending.invalidated` for the project

#### Scenario: Failed generation persists a failure row

- **WHEN** a generation fails (network error, model error, timeout)
- **THEN** an `ai_invocations` row MUST be inserted with `status='failed'`
- **AND** the row's cost MUST be `0` (or the partial cost reported by the API)
- **AND** the server MUST broadcast `file.summary_failed` with the reason

### Requirement: Staleness detection via on-read hash comparison

The server SHALL recompute the current file's hash on every `GET /file` and `GET /summary` request and SHALL set `summaryStale=true` in the response whenever the on-disk content hash differs from the stored summary's `fileHash`.

#### Scenario: Fresh summary returns stale=false

- **WHEN** the client requests a file whose on-disk hash matches the stored summary's hash
- **THEN** the response MUST include `summaryStale: false`

#### Scenario: Stale summary returns stale=true without auto-regeneration

- **WHEN** the client requests a file whose on-disk hash differs from the stored summary's hash
- **THEN** the response MUST include `summaryStale: true`
- **AND** the server MUST NOT enqueue an automatic regeneration
- **AND** the existing summary text MUST still be returned

#### Scenario: Missing file returns summaryStale=true and content unavailable

- **WHEN** the client requests a path that no longer exists on disk
- **AND** a stored summary exists
- **THEN** the response MUST set `summaryStale: true`
- **AND** the response MUST include the existing summary
- **AND** the response MUST set `content` to null with `reason='not-found'`

### Requirement: Chokidar-driven stale marking

`FileSummaryManager` SHALL attach a chokidar watcher when the Code section is open for a project and SHALL update the stored summary's hash bookkeeping (without regenerating) when a watched file's content changes outside of a job.

#### Scenario: External edit marks the summary stale

- **WHEN** a user edits a tracked file in their external editor
- **AND** the file's hash changes
- **THEN** the manager MUST broadcast `file.summary_updated` with `stale: true`
- **AND** the manager MUST NOT spawn a model call

#### Scenario: Watcher torn down on project switch

- **WHEN** the user switches to a different project or closes the Code section
- **THEN** the manager MUST detach the chokidar watcher for the previous project
- **AND** no further stale events MUST fire for paths in the previous project

### Requirement: Prompt is byte-stable and supports truncation

The prompt sent to the model SHALL be deterministic (no timestamps, no live metrics in the system part) and SHALL truncate files larger than 8000 tokens to the first 4000 + last 2000 tokens joined by a `// … truncated … //` marker, recording `truncated: true` in `generatedBy`.

#### Scenario: Small file is sent in full

- **WHEN** a file fits within the 8000-token budget
- **THEN** the prompt MUST contain the full file
- **AND** `generatedBy.truncated` MUST be `false`

#### Scenario: Large file is head+tail truncated

- **WHEN** a file exceeds the 8000-token budget
- **THEN** the prompt MUST contain only the first 4000 tokens, the marker, and the last 2000 tokens
- **AND** `generatedBy.truncated` MUST be `true`

#### Scenario: System prompt is identical across calls

- **WHEN** two generations run back-to-back within the cache TTL
- **THEN** the system part of both prompts MUST be byte-identical
- **AND** the second call SHOULD register a prompt cache hit

### Requirement: REST endpoints for summary retrieval and regeneration

The server SHALL expose `GET /api/projects/:projectId/code/summary?path=…` and `POST /api/projects/:projectId/code/file/regenerate-summary` under the `SPECRAILS_CODE_EXPLORER` flag.

#### Scenario: GET summary returns 200 with payload when summary exists

- **WHEN** the client requests `GET /summary?path=P` for a path with a stored summary
- **THEN** the response MUST be HTTP 200
- **AND** the body MUST include `summary`, `language`, `generatedAt`, `summaryStale`, `triggeredBy`

#### Scenario: GET summary returns 200 with null body when no summary exists

- **WHEN** the client requests `GET /summary?path=P` for a path with no stored summary
- **THEN** the response MUST be HTTP 200
- **AND** the body MUST be `{ "summary": null }`

#### Scenario: POST regenerate enqueues a generation

- **WHEN** the client posts to `POST /file/regenerate-summary?path=P`
- **THEN** the server MUST enqueue a generation for `P`
- **AND** the response MUST be HTTP 202 with `{ enqueued: true }`

#### Scenario: POST regenerate honours overrideBudget

- **WHEN** the client posts with `{ overrideBudget: true }`
- **AND** the project is over budget
- **THEN** the server MUST still enqueue the generation
- **AND** the response MUST be HTTP 202

### Requirement: Orphan summary sweep

On every Code section open, the app SHALL run an idle sweep that removes summary JSON files whose `path` no longer exists on disk, capped at 200 deletions per sweep.

#### Scenario: Orphan files are removed

- **WHEN** the sweep runs and finds 5 summary JSONs whose `path` no longer exists
- **THEN** all 5 JSONs MUST be deleted
- **AND** the sweep MUST log a single line summarising deletion count

#### Scenario: Sweep is bounded

- **WHEN** the sweep finds 500 orphan summaries in one pass
- **THEN** the sweep MUST delete at most 200
- **AND** the remaining 300 MUST be picked up by the next sweep

### Requirement: Explanations are bound to evidence and lifecycle
Summary generation SHALL use the hash of the source bytes actually sent to the provider, expose model/date/truncation and freshness, and reject provider error results. Story generation SHALL disclose incomplete patch evidence and SHALL NOT invent explanations when evidence is absent.

#### Scenario: Source changes while queued or running
- **WHEN** source bytes change before or during generation
- **THEN** the persisted hash MUST match the supplied snapshot
- **AND** the resulting freshness state MUST reflect the current source

#### Scenario: Project closes during generation
- **WHEN** the project or manager is disposed
- **THEN** queued requests MUST settle and active provider processes MUST be cancelled
- **AND** late results MUST NOT access a closed database

#### Scenario: Concurrent explanations near the spending limit
- **WHEN** several summary/story requests arrive together
- **THEN** generation MUST obey bounded concurrency and shared spending checks

#### Scenario: Provider returns an error with exit code zero
- **WHEN** a provider event reports an error result
- **THEN** the text MUST NOT be persisted as a successful explanation

