# agent-runtime

This module owns the agent-runtime capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/agent-runtime-accounting.ts](runtime/agent-runtime-accounting.ts)
- [runtime/agent-runtime-bridge.ts](runtime/agent-runtime-bridge.ts)
- [runtime/agent-runtime-controls-router.ts](runtime/agent-runtime-controls-router.ts)
- [runtime/agent-runtime-controls.ts](runtime/agent-runtime-controls.ts)
- [runtime/agent-runtime-events.ts](runtime/agent-runtime-events.ts)
- [runtime/agent-runtime-loader.ts](runtime/agent-runtime-loader.ts)
- [runtime/agent-runtime-paths.ts](runtime/agent-runtime-paths.ts)
- [runtime/agent-runtime-settings-router.ts](runtime/agent-runtime-settings-router.ts)
- [runtime/agent-runtime-settings.ts](runtime/agent-runtime-settings.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/agent-runtime` and any affected consumers.
