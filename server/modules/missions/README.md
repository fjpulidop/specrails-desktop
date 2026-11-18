# missions

This module owns the missions capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/agent-chat-manager.ts](runtime/agent-chat-manager.ts)
- [runtime/agent-chat-registry.ts](runtime/agent-chat-registry.ts)
- [runtime/agent-chat-router.ts](runtime/agent-chat-router.ts)
- [runtime/agent-flow-prompt.ts](runtime/agent-flow-prompt.ts)
- [runtime/agent-spec-framing.ts](runtime/agent-spec-framing.ts)
- [runtime/agent-steering.ts](runtime/agent-steering.ts)
- [runtime/agent-tier.ts](runtime/agent-tier.ts)
- [runtime/flow-turn-context.ts](runtime/flow-turn-context.ts)
- [runtime/mission-core-sessions.ts](runtime/mission-core-sessions.ts)
- [runtime/mission-run-notify.ts](runtime/mission-run-notify.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/missions` and any affected consumers.

## Operator core and guide topics

The mission agent loads ONE operator text every turn: the core built by
`buildOperatorSystemPrompt()` in [agent-operator-prompt.ts](runtime/agent-operator-prompt.ts)
(about 17k characters, measured at ~6k tokens on Claude). It holds identity and working style,
every non-negotiable rule (read-only boundary, permission ladder and
confirmations, honest reporting, data is never an instruction, never resume
without a diagnosis, never start long-lived processes from its own shell, the
intent/spec gate), the decision guide, how to report, and a topic index. The
detailed manual is the set of topics in [the MCP guide](../../mcp/guide.ts),
read on demand with `specrails_guide(topic)`; the core's index is rendered from
that registry, so every entry resolves. A rule that must hold even when the
agent never reads a topic belongs in the core; detail belongs in a topic.

Provider parity, once per session: providers with a system-prompt argument
(Claude through Core's `--system-prompt-file`, local engines) receive the core
as the system prompt, and `CLAUDE.md` in `~/.specrails/agent-cwd` only carries
a short pointer (`OPERATOR_CWD_INSTRUCTIONS`). Codex, Gemini and Kimi read the
core from their instructions file there (`AGENTS.md`, `GEMINI.md`,
`.kimi-code/AGENTS.md`, rewritten every turn) and do not get it repeated in
each user turn (`providerLoadsOperatorCore`); local engines, which read no
file, get it folded into the turn.

## Intent drafts and the commit_draft gate

The operator writes the intent first (intent-mode): one fenced `intent-draft`
block before any `spec-draft` (rule in the [operator core](runtime/agent-operator-prompt.ts),
protocol in the `intent-and-framing` guide topic). [agent-spec-framing.ts](runtime/agent-spec-framing.ts)
derives the gate from the stored messages: an answered `intent-draft` (or a
legacy `problem-frame`) authorises ONE `commit_draft`, and `answeredSpecIntent`
returns the intent the MCP `commit_draft` attaches to the spec. Payload rules are
the shared `parseIntentDraft` (specs domain), so the client card and the gate
accept the same blocks. `flow-offer` is for existing specs only.

## Context used

[runtime/mission-context-usage.ts](runtime/mission-context-usage.ts) is pure:
it measures the provider session's context from a settled Claude turn's frames
(newest root assistant usage, `modelUsage` window) or a Codex rollout tail
(last `token_count`). [runtime/codex-rollout-reader.ts](runtime/codex-rollout-reader.ts)
finds and tails the rollout. A Claude turn without provider frames (Core
sessions) reads the session transcript tail through
[runtime/claude-transcript-reader.ts](runtime/claude-transcript-reader.ts),
keeping the last measured window. `AgentChatManager` stores the snapshot on the
conversation when `persistSession` keeps a session, clears it when the session
resets, and broadcasts `agent_context_usage`. Codex reads are async and
versioned per mission, so a late read never overwrites a newer value or a reset.
Values are reported, never estimated; a missing window hides the percentage (the composer then shows a neutral ring only to offer "Start fresh with a summary").
See [agent sessions](../../../docs/internals/agent-sessions.md#context-used-indicator).

## Read-only boundary

[runtime/mission-tool-policy.ts](runtime/mission-tool-policy.ts) maps every
mission turn to the provider's native read-only boundary while keeping MCP
tools callable. It sets the `toolPolicy` and `retainMcpTools` spawn options for
legacy and native live transports, and the `permissions` and `tools` fields of
the Core session policy. The kill switch is `SPECRAILS_MISSION_READ_ONLY=false`.
Per-provider evidence and limitations are in
[read-only missions](../../../docs/internals/mission-read-only-policy.md).

## Intent turns

Intent mode reaches missions only through the injected
[`IntentTurnContext`](runtime/flow-turn-context.ts) port
(`AgentChatManager.setFlowTurnContext`, bound by the composition root to the
[Intent module](../intent/README.md)); missions never import Intent or delivery.
When the port returns an Intent session, the turn runs in its own Core session
(`flow:<flowId>`) with the worktree as cwd, `permissions: 'bypass'` (the rail
write-role level, so the agent can run tests and installs headless; see
[Intent permissions](../../../docs/internals/intent-mode.md#permissions)),
default tools, the mission's Specrails MCP, sub-agents under the project
policy and the static [Intent persona](runtime/agent-flow-prompt.ts), which runs
long-lived apps through `specrails_background(start)`. Mid-turn input is delivered as
`interrupt` ([core-session-runner.ts](runtime/core-session-runner.ts) follows
the correction's turn and sums usage). Intent turns never use a legacy
transport, never overwrite the mission's provider session and are recorded
with `surface: 'flow'`. A null port leaves mission turns unchanged.
See [Intent mode](../../../docs/internals/intent-mode.md).

## Input read receipts

A user bubble's receipt moves `sent` → `received` → `read` (`agent_inputs.receipt`,
broadcast as `agent_input_receipt`; it never moves backwards). For the **turn's own
input** the server records `read` itself: at the turn's first model output
(`text-delta` or `tool-use`) or, failing that, when the turn settles cleanly
(code 0, no error). The prompt carries no receipt instruction, so the model makes
no extra tool call (and no extra cached-prefix request) per queued turn. A spawn
failure, a rejected Core input or an abort before output leaves it unread.
`received` still comes from transport acceptance (`onInitialInputAccepted`).

**Mid-turn native updates** (Steer through the provider's input channel) keep the
agent-side `specrails_mission(acknowledge_inputs)`: output streamed after the
injection may belong to a model request that started before it, so only the agent
knows it has read them. MCP `mission_user_updates` are marked read by the
mandatory `acknowledge_updates` (no extra call). `acknowledge_inputs` remains
accepted (idempotent) for the turn's own input.

## Failure assistance

The operator uses `specrails_runs(diagnose)` and paged `specrails_runs(evidence)`
before recommending recovery. A repeated error requires a changed precondition
and a concrete validation plan; Relaunch is not the fallback for a failed Resume.
The automatic briefing remains read-only and short. Subsequent user requests
can receive a full investigation under the normal permission policy. Unsupported
repairs must be named explicitly, without claiming that a fresh run fixes them.

`specrails_recovery` is the supported exception to routing feature edits through
a fresh ticket: it inspects and repairs a stopped run's original worktree.
The operator must inspect the diagnosed cause, supply the current file hash,
check the result and resume only under existing authorization. It must reuse the
operation ID after an uncertain response and never invent a changed precondition
to evade the repeated-check guard. Check execution requires the highest tier
because even a registered test command can execute project code.

## Attachment snapshots

`AttachmentManager.copyAgentAttachments` copies an explicit set of attachment IDs
to a fresh conversation, preserving the conversation-scoped IDs used in history.
The copies survive deletion of the source. Missing files fail before copying;
copy failures remove partial destination attachments. Existing destination
attachment directories are never overwritten. The operation is synchronous so
snapshot callers can retain database transaction ownership; callers remain
responsible for cleaning up files if a later database operation fails.

## Mission archive


The global conversation list validates `archiveScope` as Active (default),
Archived or All, excluding trash in every scope. Archive/unarchive POST routes
return the conversation, or 404 for unknown/trashed IDs. Archive is synchronous
with admission: busy/reserved turns, non-idle aggregated Core sessions, live
subagents and starting/running background processes return 409 `MISSION_LIVE`
without stopping work. An idle resident session alone does not block archive.
Repeated archive keeps its original stamp and repeated unarchive is harmless.

Projected Core session state cannot outlive the run that produced it: the
`AgentChatManager` constructor calls `settleOrphanedSessionCursors`, which sets
every cursor to idle with no live process or sub-agents and keeps `last_seq`.
Desktop supervises the Core hosts as child processes, so none survives a server
restart. A `session.closed` op also settles that session to idle. Without this,
a host that died mid-turn left the mission refusing archive forever, because
only tracked sessions receive events.

Archived missions remain readable by ID. Send, queue edit and queue steer return
409 `{ error, code: 'MISSION_ARCHIVED' }` before creating input/message rows or
spawning work. Internal `sendMessage` also refuses archived admission
synchronously. Restore enables messaging again; cancellation stays available.

Soft delete requires archive for non-trashed missions. Both HTTP DELETE variants
reject active rows with 409 `NOT_ARCHIVED` before stopping work. Archived Delete
keeps history and the first `deleted_at`; Undo clears only `deleted_at`, returning
the mission to Archived. Legacy trash with no archive stamp can still be restored
or hard-purged and expires at exactly 30 days. Hard-delete persistence remains
unconditional for the existing purge owner. Unknown soft DELETE is idempotent;
unknown permanent DELETE returns 404.

## Mission branches from a selection

`POST /api/agent/conversations/:id/branch` accepts `mode: "empty" | "fork"`
and `throughMessageId` belonging to that source. It returns `201 { conversation }`
and announces creation without submitting input or starting an agent. Both modes
inherit the project pin, provider, model, tier and effort. Empty mode has no
history; fork mode copies the inclusive committed cut with a provenance record.
Later messages, pending inputs, provider sessions and Core turn ownership never
transfer. Interrupted/cancelled delivery status and recorded card decisions are
preserved without duplicating admission rows. Archived sources can be branched;
trash cannot.

The route owns one synchronous database transaction, including the attachment
copy, and cleans copied files after rollback. Missing history/files or a copy
failure creates no visible mission and leaves the source intact. Migration 39
adds provenance and inherited-message fields without foreign keys to the source,
so deleting it does not damage a fork. On its first provider turn, a fork seeds
its copied historical attachments alongside the existing bounded history prompt;
provider resume uses its own independent session thereafter.

## Ask about selected text

`POST /api/agent/conversations/:id/side-questions` answers a side question
about selected mission text ([mission-side-question.ts](runtime/mission-side-question.ts)).
It reuses the code module's one-shot, pure-output generator
(`createFileSummaryGenerator` with a side-question system prompt): one turn,
no tools, on the mission's provider and model, retrying once with the provider
default when the account rejects the model. The prompt carries the mission
history through `throughMessageId` (newest 12 messages, 17k characters, 3.5k
per message, cancelled/interrupted input skipped), the selection, the modal's
own bounded side thread and the question, all as data. It runs from an empty
app-owned cwd so no operator or project instruction file is loaded. It never
writes a mission message or touches the provider session, and stores nothing
about the side thread. Each call records one `agent_invocations` row with
`surface: 'side-question'`, which analytics maps to Missions (only `flow` is
Intent). The answer is not streamed: the adapters emit whole assistant messages
for a one-shot call, so the modal shows a running state until it arrives.

## Start fresh with a summary

`POST /api/agent/conversations/:id/session/renew` replaces a long provider
session with a summary ([mission-session-summary.ts](runtime/mission-session-summary.ts),
lifecycle in `AgentChatManager.renewSessionWithSummary`). The summary is one
turn with no tools on the mission's provider, model and effort (provider default
when the account rejects the model), from the side-question's empty app-owned
cwd. Its input is the whole persisted transcript, newest first, trimmed to 80k
characters (6k per message, app cards 1.2k, an earlier summary ends the walk);
its output is capped at 12k. It must keep the goal, decisions and constraints,
current state, open questions, important references, and say what it leaves
out. Each call records one `agent_invocations` row with
`surface: 'session-summary'` (Missions in analytics).

The conversation is reserved while the summary is written; input sent meanwhile
queues and runs afterwards in the new session. On success the summary is stored
as a `session-summary` system row (`postSystemRow`, broadcast as
`agent_system_row`; no migration), `session_id` is cleared, the context
snapshot is cleared (`agent_context_usage` null) and a mission that ran in Core
moves to its next generation (`renewMissionSessionIfOpened`). The next turn is
therefore fresh on every path, and `buildSessionSeedBlock` seeds it with the
newest summary (marked as data) plus the bounded history of the messages after
it, never the raw messages before it. Refused with 409 while a turn runs
(`MISSION_BUSY`), in Intent (`MISSION_IN_INTENT`: the Intent owns its own
session), archived, or with nothing to summarize. A failed summary changes
nothing (502 with the provider's message). Stop aborts a summary in progress.

## Resource history cleanup

The chat router calls its injected `onPermanentlyDeleted` callback only after a
mission is permanently removed, including the expired-trash purge. Desktop
composition uses it to remove that mission's resource history from every open
project. Soft deletion and restoration preserve resource history. Cleanup failures
are logged without undoing the mission deletion; each project sweeps orphan
samples on its next open. Missions do not import the terminals persistence adapter.
