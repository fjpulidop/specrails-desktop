## Context

The former AgentChatManager used one-shot CLIs and drained follow-ups after process exit. MCP-boundary delivery improves this but cannot reach reasoning or native tools. Source inspection confirms Claude stream-json user input is folded after native tool batches and echoed with its UUID; Codex app-server exposes turn/steer with expectedTurnId. Gemini/Kimi current print transports retain MCP delivery.

## Goals / Non-Goals

**Goals:** Incorporate user corrections through native Claude/Codex input channels and safe MCP boundaries for other transports, keep ordered transcript segments and input metadata, recover pending input, and preserve Stop and permission behavior.

**Non-Goals:** Introduce experimental Gemini/Kimi transports; interrupt native shell operations; automatically change running rail jobs; claim that delivery proves the model applied an instruction.

## Decisions

1. For providers without native input, a per-capability, per-database broker delivers updates before the next MCP handler, or after an already-running handler returns. Before dispatch, the outdated tool request is explicitly not executed. Results of completed handlers, including errors, are retained.
2. In MCP delivery, a revision gate requires the agent to acknowledge delivered updates through a first-party mission tool before further actions. This prevents parallel calls planned before the correction from bypassing the inbox after another call consumed it. Acknowledgement cannot clear a newer revision.
3. Pending messages retain their queue correlation IDs, refs and attachments in an additive durable ledger. Delivery creates the user transcript row atomically. Stop and restart preserve undelivered input as marked transcript rows but never replay it automatically. Pending text remains editable until claimed.
4. The manager resolves attachments and context into the delivered payload, checkpoints any assistant segment before the correction, then continues the same provider invocation. Final settlement persists only the remaining segment while accounting for the whole invocation. Pending inputs with no safe delivery point continue through the existing resume path.
5. HTTP snapshots expose pending input and the current assistant segment; stable IDs allow WebSocket and HTTP reconciliation without losing newer text or duplicating messages. Send and Stop stay independently available while busy.
6. Claude missions use stream-json stdin with replay-user-messages. A UUID-correlated replay echo confirms provider receipt, not model reading. Codex missions use app-server turn/steer with expectedTurnId and explicit acceptance. Exactly one channel owns input delivery. Native confirmation checkpoints the transcript synchronously before later output, preserving ordering even within one stdout chunk. A definitively unsent message may continue after turn completion; an uncertain native write becomes interrupted and is never resent automatically, including after Stop or a database receipt failure.
7. Native transports reuse spawnAiCli admission, provider environment, MCP configuration, permissions, model/effort, resume and usage. They close their process at completion; no interactive daemon is left running. Native notification registrations wake watch but bypass MCP delivery and its revision gate.
8. The read-only `specrails_watch` subscribes to its invocation's input notifications and ends its wait immediately on a new message. It cancels only its own read polling, keeps accumulated events and explicitly reports that the observed operation was not stopped. Other already-running actions finish normally.

9. Busy sends wait for the next turn by default. A per-message Steer action promotes only that input to native/MCP delivery without interrupting the model; other queued inputs remain queued. Delete tombstones a still-queued inbox entry without adding a transcript bubble; the original idempotency fingerprint prevents a delayed retry from resurrecting it. The pending-message menu edits text with attachments and references intact. Once delivery owns the input, mutations fail closed.
10. Delivery lifecycle and receipts are separate: migration 28 adds monotonic sent/received/read, conservatively backfilling old delivered rows to received. Gray single/double and green double checks replace status prose and retain localized tooltip/accessibility labels. Initial input advances on native acceptance. Claude replay and Codex turn/steer acceptance only mean received, so the model explicitly acknowledges the initial Mission input ID and delivered native queueIds through capability-scoped `acknowledge_inputs`. The MCP revision acknowledgement also records reading. Neither follow-up output nor item persistence alone proves reading. Receipt events update existing rows without segmenting output, and stale HTTP/WS data cannot regress them.

## Risks / Trade-offs

- Provider-native input is accepted at its own safe boundary, not an arbitrary token interruption. Gemini/Kimi without an MCP boundary show pending honestly and continue after invocation completion; never kill work just to inject text.
- Concurrent calls or messages during extraction → serialize delivery, preserve FIFO, gate stale calls by revision and do not acknowledge newer input accidentally.
- Model does not comply with a correction → distinguish delivered from applied; operator instructions require reassessment and acknowledgement.
- Provider/settings change mid-turn → keep the active capability and execution settings frozen; do not raise authority through an incoming message.
- Failed delivery or shutdown → keep input durable and mark undelivered on stop/restart; no automatic replay of external effects.

## Migration Plan

Add an inbox ledger in the desktop database and optional HTTP/WebSocket fields. Migration 28 adds receipt state without rebuilding its table or altering message identities. Legacy queue consumers and idle sends retain compatibility. No changes to project databases or provider configuration are required.
