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

## Read-only boundary

[runtime/mission-tool-policy.ts](runtime/mission-tool-policy.ts) maps every
mission turn to the provider's native read-only boundary while keeping MCP
tools callable. It sets the `toolPolicy` and `retainMcpTools` spawn options for
legacy and native live transports, and the `permissions` and `tools` fields of
the Core session policy. The kill switch is `SPECRAILS_MISSION_READ_ONLY=false`.
Per-provider evidence and limitations are in
[read-only missions](../../../docs/internals/mission-read-only-policy.md).

## Flow turns

Flow mode reaches missions only through the injected
[`FlowTurnContext`](runtime/flow-turn-context.ts) port
(`AgentChatManager.setFlowTurnContext`, bound by the composition root to the
[Flow module](../flow/README.md)); missions never import Flow or delivery.
When the port returns a Flow, the turn runs in its own Core session
(`flow:<flowId>`) with the worktree as cwd, `permissions: 'bypass'` (the rail
write-role level, so the agent can run tests and installs headless; see
[Flow permissions](../../../docs/internals/flow-mode.md#permissions)),
default tools, the mission's Specrails MCP, sub-agents under the project
policy and the static [Flow persona](runtime/agent-flow-prompt.ts), which runs
long-lived apps through `specrails_jobs background_start`. Mid-turn input is delivered as
`interrupt` ([core-session-runner.ts](runtime/core-session-runner.ts) follows
the correction's turn and sums usage). Flow turns never use a legacy
transport, never overwrite the mission's provider session and are recorded
with `surface: 'flow'`. A null port leaves mission turns unchanged.
See [Flow mode](../../../docs/internals/flow-mode.md).

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
