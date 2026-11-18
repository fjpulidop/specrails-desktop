# browser

This module owns the browser capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## Reviewed public entry points

- [runtime/browser-capture-manager.ts](runtime/browser-capture-manager.ts)
- [runtime/browser-capture-types.ts](runtime/browser-capture-types.ts)
- [runtime/browser-context-pool.ts](runtime/browser-context-pool.ts)
- [runtime/browser-playwright.ts](runtime/browser-playwright.ts)
- [runtime/run-browse-tool.ts](runtime/run-browse-tool.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/browser` and any affected consumers.

## Run browser tool

`$SPECRAILS_BROWSE` lets a run's agents check the UI they build, headless: open a page,
run simple actions, read the PNG screenshots it writes. Pieces:

| File | Role |
| --- | --- |
| [tool/browse-policy.ts](tool/browse-policy.ts) | Pure: arguments and which URLs a run may open (loopback only on its leased ports, files only inside its repositories, never private hosts) |
| [tool/main.ts](tool/main.ts) | Process entry: Chromium launch (bundled, or Playwright's in `~/.specrails/browsers`, installed on first use under a lock), `--start`, actions, screenshots, report |
| [tool/browse-tool-bundle.generated.ts](tool/browse-tool-bundle.generated.ts) | The bundled script; regenerate with `npm run build:browse-tool` (a test fails when stale) |
| [runtime/run-browse-tool.ts](runtime/run-browse-tool.ts) | Writes script and launcher at startup; `runBrowseToolEnv()` feeds `withRunPortEnv` |

The tool never relaxes `isNavigableUrl` of the app's own browser panel. Run
`npx vitest run server/modules/browser` (the integration test uses an already installed
Playwright Chromium and skips otherwise).
