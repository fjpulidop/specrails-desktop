# browser

This module owns the browser capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/browser-capture-manager.ts](runtime/browser-capture-manager.ts)
- [runtime/browser-capture-types.ts](runtime/browser-capture-types.ts)
- [runtime/browser-context-pool.ts](runtime/browser-context-pool.ts)
- [runtime/browser-playwright.ts](runtime/browser-playwright.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/browser` and any affected consumers.
