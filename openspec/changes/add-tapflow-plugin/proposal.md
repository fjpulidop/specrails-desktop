## Why

Specrails builds native iOS and Android apps but cannot show them running. Tapflow (MIT, `tapflow` on npm) streams the iOS Simulator and the Android emulator and exposes them to agents over MCP. Integrating it lets a person test what an agent built without leaving Specrails, and lets agents drive the app themselves. This change is the foundation (phase 1 of the plan in the working proposal): the plugin, its install, its service and its cost. The "Test in Mobile Device" loop, native device windows and MCP wiring build on it in later changes.

Phase 0 (spike, 2026-11-28, Apple Silicon, Xcode 26.4) measured the facts this design rests on: Tapflow 0.33.0 installs with Specrails' own Node in 5 s (80 MB); its relay binds every interface with no option (a preload keeps it on loopback); `tapflow start` has no admin bootstrap (`POST /auth/init` from loopback does); one idle service costs one process of 60–130 MB at 0 % CPU; a session left connected is never released and the capture keeps running after a disconnect until the device is shut down; SIGTERM stops everything in 0.1 s with no orphans.

## What Changes

- **App-global plugin "Tapflow"**, not installed and inactive by default. Eligible only on macOS on Apple Silicon (Tapflow's agents run nowhere else); elsewhere the card says why and offers no install.
- **Detection.** Specrails-managed install (`~/.specrails/tools/tapflow`), a Tapflow the person installed (`tapflow` on PATH, `~/.tapflow/tapflow.config.json`), and a Tapflow already running (its liveness endpoint, its process) are each recognised; an external one is used and never stopped by Specrails.
- **Install in a terminal.** One click opens an installer terminal: Specrails installs the pinned `tapflow@0.33.0` and `@tapflowio/mcp-server@0.33.0` with its own Node and npm, then runs Tapflow's interactive `tapflow setup` in the same terminal so the person answers its prompts (sudo, Homebrew, Android SDK, permissions). The terminal reports its exit to the server; once the pinned packages are present the plugin is installed and inactive, and a setup that did not finish (the person may decline optional steps) is reported with Run setup again. A warning says iOS needs macOS on Apple Silicon with Xcode 26/27 and Android needs Apple Silicon in this Tapflow version.
- **Activate / deactivate.** A switch starts or stops a supervised `tapflow start`: loopback-only (preload), lean mode, audio off, display sleep allowed, smaller stream, one automated device; its own config written by Specrails (no `tapflow init` prompts); admin account and a `view,builds:write` token bootstrapped automatically and kept as 0600 secrets. A crashed service shows as inactive with the reason; the previous state is restored at app start; app shutdown stops it with SIGTERM.
- **Resources.** A `tapflow` category in the app Resources view, present only while something runs: the service tree plus the simulator and emulator processes found by signature (they do not descend from Specrails).
- **Terminal capability.** `TerminalManager.create` can run a given program instead of a shell and notify an `onExit` callback; an app-scope (`__app__`) terminal hosts the installer.

## Capabilities

### New Capabilities
- `tapflow-plugin`: install, detect, activate and measure Tapflow as an app-global plugin.

### Modified Capabilities
<!-- None: the terminal command mode and the resource category are additive and specified in the new capability. -->

## Impact

- New server module `server/modules/tapflow/` (domain, application, adapters, README), mounted under `/api/global-plugins/tapflow`, booted and shut down from `server/index.ts`.
- `server/modules/terminals`: command mode and exit callback in `TerminalManager`; `tapflow` resource category and roots.
- Client: Tapflow card and installer terminal in the Plugins page; `tapflow` category in Resources; strings in the 8 locales.
- No database migration (state in `desktop_settings`). No change to Core.
