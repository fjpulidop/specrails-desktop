## Why

After an agent run, a reviewer can see the diff and the transcript but cannot answer simple questions quickly: which files did the agents read, which commands did they run, which MCP tools did they call, what did they fetch from the network? The external feedback of 2026-10 (task 4.2) asks for that record, exportable, with a retention limit, and honest about its completeness.

Desktop already consumes every stream that carries this information: provider JSONL in the queue and the loop engine, Core `agent-event` tool lines, Core session `turn.tool` events, the post-run diff (`file_provenance`) and the MCP calls of mission agents. Nothing records them as one queryable log.

## What Changes

- **Table.** A project-database migration adds `agent_actions(id, run_id, job_id, role, kind, target, hash, ts, source)` with `kind IN ('read','write','exec','mcp','network')` and indexes on `(run_id, ts)` and `(ts)`.
- **Capability module `server/modules/audit/`.**
  - Pure domain: classification of provider tool events (Claude, Codex, Gemini, Core agent events, Core sessions) into rows; provider tool-name mapping (Read/Grep/Glob → read, Edit/Write/MultiEdit/apply_patch → write, Bash/shell/exec_command → exec, WebFetch/WebSearch → network, `mcp__*` → mcp); target normalisation; command and URL redaction; JSONL/CSV formats; retention cutoff.
  - Application: a batched recorder (flush every 250 ms or 200 rows) that never blocks or fails a run; stream taps; export and prune use cases.
  - Adapters: SQLite store (one transaction per batch), per-project runtime (sha256, retention timers), HTTP exports.
- **Producers.** Queue jobs, interactive sessions, loop AI steps, Core workflow definitions, mission Core sessions and native missions, file provenance writes (with the sha256 of the recorded diff), and first-party mission MCP calls through `registerTieredTool` (role `mission`).
- **Never stored.** File contents, tool outputs, diffs, MCP arguments and environment values. Commands are redacted (`NAME=***`, secret flags, auth headers, URL credentials, token shapes).
- **Export.** `GET /api/projects/:id/jobs/:runId/audit?format=jsonl|csv`, a project-wide `GET /api/projects/:id/agent-actions?format=&from=&to=`, and MCP `specrails_jobs` action `audit` (read tier).
- **Review packet.** A "What the agent did" section with counts by kind and per-run JSONL/CSV downloads.
- **Retention.** Project setting `agentAuditRetentionDays` (default 30, 1–3650) through the project-settings module; cleanup shortly after project startup and daily. Visible in project settings, localized in the 8 locales.
- **Honest limit, documented.** Reads are only as complete as each provider's stream.

## Capabilities

### New Capabilities
- `agent-actions-audit`: per-project record of agent reads, writes, commands, MCP calls and network access, with export, packet summary and retention.

### Modified Capabilities
<!-- None: the review packet, MCP jobs facade and project settings gain additive fields only, specified in the new capability. -->

## Impact

- Server: `server/db/migrations.ts` (migration 73), new `server/modules/audit/`, `queue-manager.ts`, `interactive-job-session.ts`, `loop-run-manager.ts`, `mission-session-projector.ts`, `mission-core-sessions.ts`, `agent-chat-manager.ts`, `file-provenance.ts`, `mcp/tools/types.ts`, `mcp/tools/jobs.ts`, `review-packet.ts`, `project-router-jobs.ts`, `project-registry.ts`, `index.ts`, project-settings module.
- Client: review packet page, project settings section, 8 locales.
- Docs: `docs/internals/agent-actions-audit.md`, API reference, configuration, MCP guide, review packet, `SECURITY.md`.
- Migration numbering: other open PRs also append migrations; renumbering at merge is expected.
