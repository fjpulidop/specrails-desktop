## 1. Server

- [x] 1.1 Mobile project detection, platform choice, build plans and artifact selection (pure), with tests
- [x] 1.2 Host tasks `mobile.build` and `tapflow.deliver` with their adapters, with tests
- [x] 1.3 `factory:mobile-test` recipe and registration, gated on Tapflow and host tasks
- [x] 1.4 Offer after delivery with platform choice and remembered preference

## 2. Client

- [x] 2.1 Offer row with platform buttons; strings in the 8 locales

## 3. Device windows

- [x] 3.1 Server: single-use ticket, Tapflow sign-in and cookie, redirect; release with grace period
- [x] 3.2 Host: `device_window_open` (external, no capability, loopback-only navigation, closed event)
- [x] 3.3 Client: Open <device> on the card; release on the closed event

## 4. Verification

- [x] 3.1 Suites and typecheck
- [x] 3.2 Live: an iOS sample project from the offer to the app running on the simulator

## 5. Run from Loops

- [x] 5.1 Seed `factory:mobile-test` as an editable built-in; never copied, never a generic or rail loop; publish contract
- [x] 5.2 Start on a checkout, a delivery or a branch (temporary worktree, removed at the end), with a chosen device per platform; options and run view routes
- [x] 5.3 Loops card Run on a device and its dialog; a loop window asks the main window to open the device; strings in the 8 locales
- [x] 5.4 MCP `mobile_test` with `target` checkout/branch and `devices`
- [x] 5.5 Gradle builds get ANDROID_HOME and a JDK 17+; live: an Android app from the loop to the emulator

## 6. Agent, Processes, Resources, pinning

- [x] 6.1 MCP `mobile_test` target `mission` (the caller's Intent worktree), conversation from the capability, tier exception inside the agent's own active Intent; Intent persona section
- [x] 6.2 Observed background processes; a mission's run in its Processes with the run log, Tapflow's log, the build PID and the outcome
- [x] 6.3 Resources: device ids and simulator names, builds in the app-wide Tapflow category, mission kinds `mobile-device`, `mobile-build`, `tapflow-service`, footprints in the mission view, recording while a run is in progress
- [x] 6.4 Pin Tapflow's whole tree: shipped lockfile, `npm ci`
