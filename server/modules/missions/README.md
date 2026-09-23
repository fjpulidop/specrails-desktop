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
