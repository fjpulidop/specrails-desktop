## 1. Server

- [x] 1.1 Terminal command mode and `onExit` in `TerminalManager.create`, with tests
- [x] 1.2 `server/modules/tapflow` domain: eligibility, status derivation, service env and config, resource roots by signature, with tests
- [x] 1.3 Application use cases (status, install, activate, deactivate, uninstall, boot, shutdown) over ports, with tests using fakes
- [x] 1.4 Adapters: process (install command, supervised service, loopback preload), relay (probe, bootstrap), store, HTTP routes; preload test binding a wildcard listen to 127.0.0.1
- [x] 1.5 Composition in `server/index.ts` (routes, boot restore, shutdown) and `tapflow` resource category; boundary manifest and module README

## 2. Client

- [x] 2.1 Tapflow card in the Plugins page with status, warning, switch and install/uninstall
- [x] 2.2 Installer terminal view attached to the app-scope terminal
- [x] 2.3 `tapflow` category in Resources; strings in the 8 locales

## 3. Verification

- [x] 3.1 Typecheck, server modules and terminals suites, client tests
- [x] 3.2 Live in the dev app: install detection, activate/deactivate, resources while a simulator runs
