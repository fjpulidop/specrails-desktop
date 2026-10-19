# terminals

This module owns the terminals capability and its adjacent regression tests.
Runtime files contain effectful coordination and adapters. Domain/application
subdirectories, where present, enforce inward dependency rules.

## App addresses

A mission's dev server is opened in the device's own browser, not an embedded
one. `domain/app-urls.ts` extracts the `local` and `network` (private LAN/VPN)
addresses a process prints; `runtime/app-urls.ts` attaches them as `appUrls` to
running processes on read (REST, mission MCP tools, WS events). The operator
prompt asks the user before launching a dev server exposed on the local network
(the framework's own host flag); nothing here binds or proxies ports.

## Reviewed public entry points

- [runtime/app-urls.ts](runtime/app-urls.ts)
- [runtime/background-process-control.ts](runtime/background-process-control.ts)
- [runtime/background-process-service.ts](runtime/background-process-service.ts)
- [runtime/background-process-store.ts](runtime/background-process-store.ts)
- [runtime/background-windows-bootstrap.ts](runtime/background-windows-bootstrap.ts)
- [runtime/terminal-manager.ts](runtime/terminal-manager.ts)
- [runtime/terminal-marks-store.ts](runtime/terminal-marks-store.ts)
- [runtime/terminal-settings.ts](runtime/terminal-settings.ts)

The [boundary manifest](../boundaries.json) records dependencies for every
production file and subpaths consumed outside this capability. The architecture
test rejects undeclared dependency changes; domain/application rules remain
independent of manifest generation. Prefer a focused public subpath over an
eager barrel that initializes all effectful adapters.

Run `npx vitest run server/modules/terminals` and any affected consumers.
