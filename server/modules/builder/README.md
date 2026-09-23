# builder

This module owns the builder capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/blueprint-chat-manager.ts](runtime/blueprint-chat-manager.ts)
- [runtime/blueprint-commit.ts](runtime/blueprint-commit.ts)
- [runtime/blueprint-draft-parser.ts](runtime/blueprint-draft-parser.ts)
- [runtime/blueprint-render.ts](runtime/blueprint-render.ts)
- [runtime/blueprint-router.ts](runtime/blueprint-router.ts)
- [runtime/blueprint-spec-quality.ts](runtime/blueprint-spec-quality.ts)
- [runtime/blueprint-types.ts](runtime/blueprint-types.ts)
- [runtime/milestone-chain-store.ts](runtime/milestone-chain-store.ts)
- [runtime/milestone-chain.ts](runtime/milestone-chain.ts)
- [runtime/milestone-progress.ts](runtime/milestone-progress.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/builder` and any affected consumers.
