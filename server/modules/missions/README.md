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

## Intent drafts and the commit_draft gate

The operator writes the intent first (intent-mode): one fenced `intent-draft`
block before any `spec-draft` ([operator prompt](runtime/agent-operator-prompt.ts),
section "Writing the intent"). [agent-spec-framing.ts](runtime/agent-spec-framing.ts)
derives the gate from the stored messages: an answered `intent-draft` (or a
legacy `problem-frame`) authorises ONE `commit_draft`, and `answeredSpecIntent`
returns the intent the MCP `commit_draft` attaches to the spec. Payload rules are
the shared `parseIntentDraft` (specs domain), so the client card and the gate
accept the same blocks. `flow-offer` is for existing specs only.

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
long-lived apps through `specrails_jobs background_start`. Mid-turn input is delivered as
`interrupt` ([core-session-runner.ts](runtime/core-session-runner.ts) follows
the correction's turn and sums usage). Intent turns never use a legacy
transport, never overwrite the mission's provider session and are recorded
with `surface: 'flow'`. A null port leaves mission turns unchanged.
See [Intent mode](../../../docs/internals/intent-mode.md).

## Failure assistance

The operator uses `specrails_jobs runtime_diagnose` and paged `runtime_evidence`
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
