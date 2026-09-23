# code

This module owns the code capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/changes-reader.ts](runtime/changes-reader.ts)
- [runtime/code-activity.ts](runtime/code-activity.ts)
- [runtime/code-explorer-router.ts](runtime/code-explorer-router.ts)
- [runtime/file-provenance.ts](runtime/file-provenance.ts)
- [runtime/file-story-manager.ts](runtime/file-story-manager.ts)
- [runtime/file-story.ts](runtime/file-story.ts)
- [runtime/file-summary-generator.ts](runtime/file-summary-generator.ts)
- [runtime/file-summary-manager.ts](runtime/file-summary-manager.ts)
- [runtime/project-code-discovery.ts](runtime/project-code-discovery.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/code` and any affected consumers.
