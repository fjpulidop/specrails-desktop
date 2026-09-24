# missions

This module owns the missions capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/agent-chat-manager.ts](runtime/agent-chat-manager.ts)
- [runtime/agent-chat-registry.ts](runtime/agent-chat-registry.ts)
- [runtime/agent-chat-router.ts](runtime/agent-chat-router.ts)
- [runtime/agent-spec-framing.ts](runtime/agent-spec-framing.ts)
- [runtime/agent-steering.ts](runtime/agent-steering.ts)
- [runtime/agent-tier.ts](runtime/agent-tier.ts)
- [runtime/mission-run-notify.ts](runtime/mission-run-notify.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/missions` and any affected consumers.

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
