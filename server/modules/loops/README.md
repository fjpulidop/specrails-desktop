# loops

This module owns the loops capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/loop-command-catalog.ts](runtime/loop-command-catalog.ts)
- [runtime/loop-constants.ts](runtime/loop-constants.ts)
- [runtime/loop-effect.ts](runtime/loop-effect.ts)
- [runtime/loop-executors.ts](runtime/loop-executors.ts)
- [runtime/loop-factory.ts](runtime/loop-factory.ts)
- [runtime/loop-graph.ts](runtime/loop-graph.ts)
- [runtime/loop-role-engines.ts](runtime/loop-role-engines.ts)
- [runtime/loop-run-manager.ts](runtime/loop-run-manager.ts)
- [runtime/loop-runs-store.ts](runtime/loop-runs-store.ts)
- [runtime/loops-router.ts](runtime/loops-router.ts)
- [runtime/loops-store.ts](runtime/loops-store.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/loops` and any affected consumers.

Quick SDD owns delivery changes and addenda. It seeds a distinct delta target,
briefs each AI phase, and requires per-addendum coverage before validation/archive.
The retired `factory:revision` id is a compatibility alias, absent from the gallery.
