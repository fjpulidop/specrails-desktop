## ADDED Requirements

### Requirement: Per-project agent actions log
Each project database SHALL keep an `agent_actions` table with the columns `id`, `run_id`, `job_id` (nullable), `role`, `kind`, `target`, `hash` (nullable), `ts` and `source`. `kind` SHALL be one of `read`, `write`, `exec`, `mcp` or `network`, enforced by the database. The table SHALL be indexed by `(run_id, ts)` and by `ts`. Rows of one project SHALL never be written to or read from another project's database.

#### Scenario: Invalid kind is rejected
- **WHEN** a row with kind `delete` is inserted
- **THEN** the database rejects it

#### Scenario: Projects stay isolated
- **WHEN** project A records an action for run `r1`
- **THEN** an export of run `r1` in project B returns no rows

### Requirement: Actions are recorded from existing agent streams
Desktop SHALL classify tool events from the streams it already consumes into actions:
- Claude stream-json `tool_use` blocks, attributing actions inside a `Task` sub-agent to its `subagent_type`;
- Codex `item.started` / `item.completed` frames, recording each item once and file changes on completion;
- Gemini `tool_use` frames;
- Core `agent-event` tool-start lines, using the event's role;
- Core session `turn.tool` starts and sub-agent tool output of missions;
- native mission tool-use events;
- `file_provenance` writes;
- tool calls of first-party mission agents through the in-app MCP server, with role `mission`.

Read, Grep, Glob and equivalents SHALL map to `read`; Edit, Write, MultiEdit, apply_patch and equivalents to `write`; Bash, shell, exec_command and equivalents to `exec`; WebFetch, WebSearch and equivalents to `network`; `mcp__*` tools to `mcp`. Tools outside these groups SHALL NOT be recorded.

#### Scenario: Implement run leaves read, exec and write rows
- **WHEN** an Implement run's agent reads a file, runs a command and edits a file
- **THEN** the run has `read`, `exec` and `write` rows with the file paths and the command as targets

#### Scenario: Sub-agent attribution
- **WHEN** a Claude `Task` with `subagent_type: sr-architect` greps the repository
- **THEN** the read row has role `architect`

#### Scenario: Provenance write carries a hash
- **WHEN** the post-run diff records a modified file with a patch
- **THEN** a `write` row with source `file-provenance` stores the sha256 of that patch and not the patch

#### Scenario: Mission MCP call
- **WHEN** an in-app mission agent of a pinned project calls `specrails_jobs` with action `list`
- **THEN** a row with run id = conversation id, role `mission`, kind `mcp` and target `specrails_jobs:list` is recorded, without the call's arguments

#### Scenario: External MCP client
- **WHEN** an external MCP client without an agent capability calls a tool
- **THEN** no mission row is recorded

### Requirement: No contents or secrets are stored
The log SHALL store targets only. File contents, tool outputs, diffs, MCP arguments and environment values SHALL NOT be stored. Before storage, commands SHALL have environment assignment values, secret-looking flag values, authorization header values, URL credentials and common token formats replaced by `***`, and URLs SHALL lose their query string and fragment. Targets SHALL be single-line and bounded.

#### Scenario: Environment value in a command
- **WHEN** an agent runs `API_KEY=xyz npm run deploy`
- **THEN** the stored target is `API_KEY=*** npm run deploy`

#### Scenario: File content
- **WHEN** an agent writes a file with content `SECRET`
- **THEN** no row contains `SECRET`

### Requirement: Recording never affects a run
Recording SHALL be batched (flush at most every 250 ms, or as soon as 200 rows are pending, one transaction per batch). Recording SHALL perform no IO on the caller's path and SHALL never throw into a run, a session projection or an MCP call. Storage failures SHALL be counted and logged without reaching the run. Pending rows SHALL be flushed before the project connection closes.

#### Scenario: Writer failure
- **WHEN** the audit store throws on every write during a job
- **THEN** the job's events, logs and terminal status are the same as without the audit, and the failures are counted

### Requirement: Exports
Desktop SHALL export one run's actions at `GET /api/projects/:projectId/jobs/:runId/audit?format=jsonl|csv` (matching the run id or the job id) and a project-wide window at `GET /api/projects/:projectId/agent-actions?format=jsonl|csv&from=&to=`. JSONL SHALL be the default. CSV SHALL have the header `id,ts,run_id,job_id,role,kind,target,hash,source` and SHALL neutralise spreadsheet formulas. Exports SHALL include rows still pending in the batch. An invalid format or timestamp SHALL return `400`. MCP `specrails_jobs` SHALL offer a read-tier `audit` action with the same data.

#### Scenario: CSV export of a run
- **WHEN** a client requests `/jobs/run-1/audit?format=csv`
- **THEN** the response is a CSV attachment with the header row and one row per action of `run-1`, oldest first

#### Scenario: Project window
- **WHEN** a client requests `/agent-actions?from=2026-10-01T00:00:00Z`
- **THEN** only actions at or after that instant are returned

### Requirement: Review packet summary
The review packet SHALL include `agentActions`: counts by kind across the delivery's runs, their total, and the runs that have rows; or `null` when no run has rows. The packet page SHALL show "What the agent did" with the counts, the completeness caveat and per-run JSONL/CSV downloads.

#### Scenario: Packet with recorded actions
- **WHEN** a delivery's run recorded 2 reads and 1 command
- **THEN** the packet reports `{ read: 2, exec: 1, write: 0, mcp: 0, network: 0 }` with total 3 and offers the run's downloads

### Requirement: Retention
The project setting `agentAuditRetentionDays` SHALL default to 30 and accept integers from 1 to 3650. Desktop SHALL delete rows older than the window shortly after the project opens and then daily, reading the setting each time. A retention failure SHALL be logged and never thrown.

#### Scenario: Old rows removed
- **WHEN** the retention is 30 days and a row is 40 days old
- **THEN** the next cleanup deletes it and keeps a 10-day-old row

#### Scenario: Invalid setting
- **WHEN** a client sets `agentAuditRetentionDays` to `0`
- **THEN** the settings update is rejected with `400` and nothing is written

### Requirement: Documented completeness
Documentation, the packet caveat and the MCP action description SHALL state that reads are only as complete as each provider's stream.

#### Scenario: Reviewer reads the packet
- **WHEN** the "What the agent did" section is open
- **THEN** it states that reads depend on what each provider reports
