## Why

An agent mission can leave the entire desktop backend unavailable when a project-scoped MCP inspection stalls or the sidecar disappears mid-turn. The UI then keeps the mission in a permanent thinking state, reports models as unavailable, and offers no truthful recovery path even though the original request was already accepted.

## What Changes

- Bound Code Explorer all-files enumeration so an MCP `tree` request cannot monopolize or exhaust the shared desktop server.
- Make expensive repository discovery cooperative, cancellable, and explicitly limited while preserving pagination, deny-list, and `.gitignore` behavior.
- Give agent turns and MCP activity a terminal timeout/failure path that always clears live state instead of waiting forever.
- Reconcile in-flight mission state after WebSocket reconnection or sidecar restart, distinguishing an active turn from an orphaned optimistic spinner.
- Preserve and surface useful partial provider output alongside a failure when a CLI emits text before exiting unsuccessfully.
- Keep model selection atomic with provider selection so a stale Claude model can never be submitted to Codex, Gemini, or Kimi while the new catalog is loading.
- Prevent Contract Layer enrichment from silently switching an agent-authored spec to a different installed provider; unsupported providers skip enrichment explicitly instead of falling back to Claude.
- Add regression coverage for a stalled Code Explorer tool, provider failure, server loss, reconnection, and creating a new mission after recovery.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `code-explorer`: All-files tree discovery must remain responsive and bounded for large repositories and MCP consumers.
- `desktop-agent-chat`: Accepted turns must settle truthfully across tool stalls, provider failures, WebSocket loss, and sidecar restarts, without leaving permanent thinking state or blocking new missions.
- `add-spec-model-selection`: Provider changes must invalidate the prior model immediately and submission must wait for a valid model from the selected provider.

## Impact

- Server: `code-explorer-router`, file-summary watcher activation, agent turn lifecycle, MCP invocation handling, and any lightweight turn-status endpoint needed for reconciliation.
- Client: shared WebSocket lifecycle, `AgentChatContext` live-state recovery, and Add Spec provider/model selection.
- Contract Layer: post-commit provider ownership and unsupported-provider behavior for agent-authored specs.
- Contracts: Code Explorer pagination/error semantics and app-global agent-chat settlement/recovery behavior.
- Tests: router responsiveness and limits, manager terminal events, reconnection reconciliation, and partial-output failure rendering.
- No provider invocation or new external dependency is required by the change.
