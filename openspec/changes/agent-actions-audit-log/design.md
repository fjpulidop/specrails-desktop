## Context

Desktop runs agents through several transports: the legacy queue (one-shot and interactive provider CLIs), the loop engine (one-shot and interactive AI steps, Core workflow definitions), and missions (Core resident sessions or native provider sessions, plus the in-app MCP server). Each already parses its stream for display, accounting or projection. The audit attaches an observer to those existing parse points instead of adding new process plumbing.

## Goals / Non-Goals

**Goals:** one queryable per-project log of reads, writes, commands, MCP calls and network access; exports; a packet summary; retention; zero effect on runs.

**Non-Goals:** a security boundary or an enforcement layer; capturing reads a provider does not report; storing contents; cross-project or app-wide audit; deduplicating a Core-session journal rebuild.

## Decisions

### D1. Observe existing streams; classify in a pure domain
A single pure function `extractStreamActions(event, state, role)` recognises Claude stream-json (`assistant` tool_use blocks, `Task` sub-agent roles via `parent_tool_use_id`), Codex `item.started/completed` (deduplicated by item id; file changes on completion), Gemini `tool_use`, and Core `agent-event` tool-start lines (role from Core, `targetPaths` when present). `classifyToolCall(name, input)` serves adapter previews and Core session `turn.tool` input. Unknown tools are ignored rather than guessed.

Alternative considered: provider adapters' normalised `tool-use` events. Rejected as the primary source because the Claude adapter emits one tool per frame with a 200-character preview; the raw frame is complete. Native missions, which only see adapter events, use the preview path.

### D2. Batched, non-blocking writer
`record()` validates and buffers; a timer flushes every 250 ms, or immediately at 200 pending rows, in one transaction per batch. It performs no IO and never throws. Failures are counted and logged at most every 10 s; more than 20 000 pending rows are dropped and counted. Each tap wraps its own work in try/catch, so a bug or full disk cannot affect a run. The recorder is flushed before the project connection closes.

### D3. Provenance rows in the provenance transaction
`recordProvenanceForJob` inserts one `write` row per provenance row in its own transaction, with the sha256 of the recorded patch. The statement is prepared defensively (pre-migration databases) and each insert is guarded, so provenance never fails because of the audit. This keeps the code module free of an audit dependency.

### D4. Missions write to their pinned project
Mission tool calls are recorded with `run_id` = conversation id in the pinned project's log: Core sessions through the projector (after commit), native sessions through the chat manager (adapter previews), MCP calls through the tier wrapper (first-party capability only, `tool:action`, no arguments). Missions without a loaded pinned project are not recorded.

### D5. Redaction before storage
Commands lose environment values (`NAME=***`), secret-looking flag values, auth header values, URL credentials and common token shapes; URLs lose queries and fragments. Patterns are conservative and documented as best effort.

### D6. Retention through project settings
`agentAuditRetentionDays` follows the project-settings module (domain validation, SQLite row cleared at the default). The per-project runtime prunes 5 s after open and daily, reading the setting each time.

## Risks / Trade-offs

- Reads are incomplete for providers that do not stream read tools → documented in UI, docs, MCP description and SECURITY.md.
- Pattern-based redaction can miss unusual secret forms → SECURITY.md advises reviewing exports before sharing.
- A Core session projection rebuild can re-record tool rows → accepted; the log is review aid, not accounting.
- Packet `agentActions` reads the live log, so retention can shrink it → documented in the review-packet guide.
