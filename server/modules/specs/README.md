# specs

This module owns the specs capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/contract-refine-runner.ts](runtime/contract-refine-runner.ts)
- [runtime/proposal-manager.ts](runtime/proposal-manager.ts)
- [runtime/smash-runner.ts](runtime/smash-runner.ts)
- [runtime/spec-addenda-core.ts](runtime/spec-addenda-core.ts)
- [runtime/spec-addenda.ts](runtime/spec-addenda.ts)
- [runtime/spec-contract-prompt.ts](runtime/spec-contract-prompt.ts)
- [runtime/spec-draft-parser.ts](runtime/spec-draft-parser.ts)
- [runtime/spec-launcher-manager.ts](runtime/spec-launcher-manager.ts)
- [runtime/spec-models.ts](runtime/spec-models.ts)
- [runtime/ticket-store.ts](runtime/ticket-store.ts)
- [runtime/ticket-watcher.ts](runtime/ticket-watcher.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/specs` and any affected consumers.
