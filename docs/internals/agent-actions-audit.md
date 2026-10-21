# Agent actions audit

Every project keeps a log of what its agents **read**, **wrote**, **executed**,
called over **MCP** or fetched from the **network**. It answers "what did the
agent do?" after a run, without replaying transcripts.

The log is built from streams Desktop already consumes. It is as complete as
those streams are. In particular, **reads are only as complete as each
provider's stream reports them**: a provider that does not emit a tool event for
a read leaves no read row. Writes are additionally cross-checked by the
post-run diff (`file_provenance`), which is provider-independent.

## Table

Migration 72 adds `agent_actions` to the project database (`jobs.sqlite`):

| Column | Meaning |
| --- | --- |
| `id` | Integer key |
| `run_id` | Run that acted: queue job id, loop run id, or mission conversation id |
| `job_id` | Backing job row when there is one (`NULL` for missions) |
| `role` | `architect`, `developer`, `reviewer`, `fixer`, `mission`, `subagent`, `loop`, `run`, `agent`, … |
| `kind` | `read`, `write`, `exec`, `mcp` or `network` (CHECK constraint) |
| `target` | Path, redacted command, MCP tool (`mcp__server__tool`, `specrails_jobs:audit`), URL without query, or `search: <query>` |
| `hash` | sha256 of the written content when the call carried it, or of the recorded diff for provenance rows |
| `ts` | ISO timestamp |
| `source` | `claude-stream`, `codex-stream`, `gemini-stream`, `provider-stream`, `core-agent-event`, `core-session`, `file-provenance`, `mcp-wrapper` |

Indexes: `(run_id, ts)` and `(ts)`.

## What is never stored

- File contents, tool outputs, patches and diffs. Only paths. `apply_patch`
  contributes the file names in its envelope, never its hunks.
- Environment values. `NAME=value` assignments in commands keep `NAME=***`.
- Obvious secrets in commands: `--token`, `--password`, `--api-key` style flags,
  `Authorization:` / `Bearer` headers, `user:pass@` URL credentials and common
  token shapes (`ghp_…`, `github_pat_…`, `sk-…`, `xox?-…`, `AKIA…`, `glpat-…`,
  `npm_…`).
- URL query strings and fragments.
- MCP arguments. A mission call is recorded as `tool:action` only.

Targets are single-line and capped at 512 characters.

## Producers

| Source | Where | Notes |
| --- | --- | --- |
| Legacy queue jobs | `QueueManager` stdout reader | Claude stream-json, Codex `item.*`, Gemini `tool_use`. Claude `Task` sub-agents are followed through `parent_tool_use_id`, so their actions carry the sub-agent type as role |
| Interactive jobs and interactive loop steps | `InteractiveJobSession.onProviderEvent` | Same classification; observer failures are swallowed |
| Loop AI steps (one-shot) | `LoopRunManager` raw-line forwarder | Provider JSONL and Core `agent-event` tool-start lines (`role` comes from Core) |
| Core workflow definitions | `LoopRunManager` runtime-event observer | Core `agent-event` tool-start lines; host-run environment commands (`npm ci`, …) become `exec` rows |
| Mission Core sessions | `MissionSessionProjector` | `turn.tool` (role `mission`) and sub-agent tool output (role `subagent`), recorded after the projection commit, in the mission's pinned project |
| Mission native sessions | `AgentChatManager` | Adapter tool-use previews (truncated input; paths are recovered when visible) |
| Mission MCP calls | `recordMissionMcpAction` in `registerTieredTool` | Only first-party (capability-bearing) calls of a pinned project; external MCP clients leave no rows |
| Post-run diff | `recordProvenanceForJob` | One `write` row per provenance row (role `run`), hashed patch, same transaction, guarded against a pre-migration database |

Missions without a pinned project, or whose project is not loaded, are not
recorded.

## Writing never blocks a run

`createAgentAuditRecorder` validates rows synchronously and buffers them. It
writes from a timer: every 250 ms, or immediately once 200 rows are pending.
A batch is one SQLite transaction (one WAL commit). `record()` performs no IO
and never throws. Storage failures are counted (`stats().failed`) and logged
at most once every 10 seconds. More than 20 000 pending rows are dropped and
counted. Every stream tap catches its own errors, so a classification bug or a
broken disk cannot fail, stall or alter the run that produced the action.

The project registry creates one recorder per project connection and flushes it
before the connection closes (project removal and app shutdown).

## Export

- `GET /api/projects/:projectId/jobs/:runId/audit?format=jsonl|csv` — one run
  (matches `run_id` or `job_id`). Default `jsonl`.
- `GET /api/projects/:projectId/agent-actions?format=jsonl|csv&from=&to=` — a
  project-wide window (ISO timestamps, inclusive).

Both flush pending rows first and return at most 100 000 rows, oldest first, as
an attachment with an `X-Agent-Actions-Rows` header. CSV columns are
`id,ts,run_id,job_id,role,kind,target,hash,source`. Cells starting with `=`,
`+`, `-`, `@` are prefixed with `'` so spreadsheets do not evaluate them.

MCP: `specrails_jobs` action `audit` (read tier) with `jobId` (or `from`/`to`
for the project window) and `format` (`jsonl` default, or `csv`).

The review packet shows **What the agent did**: counts by kind across the
delivery's runs and per-run JSONL/CSV downloads.

## Retention

The project setting `agentAuditRetentionDays` (default 30, 1–3650) controls how
long rows are kept. Retention runs 5 seconds after the project opens and then
daily, reading the setting each time. A failure is logged and never thrown.

## Code

- [Module](../../server/modules/audit/README.md)
- Tests: `npx vitest run server/modules/audit server/mcp/tools/jobs-audit.test.ts`
