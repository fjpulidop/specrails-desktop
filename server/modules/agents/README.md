# agents

This module owns the agents capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/agent-defaults.ts](runtime/agent-defaults.ts)
- [runtime/agent-refine-db.ts](runtime/agent-refine-db.ts)
- [runtime/agent-refine-manager.ts](runtime/agent-refine-manager.ts)
- [runtime/agent-store.ts](runtime/agent-store.ts)
- [runtime/profile-manager.ts](runtime/profile-manager.ts)
- [runtime/profiles-router.ts](runtime/profiles-router.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/agents` and any affected consumers.
