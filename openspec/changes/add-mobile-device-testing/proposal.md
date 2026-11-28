## Why

With Tapflow installed (change `add-tapflow-plugin`), a person who built a native iOS or Android app with Specrails still has to build it, find the artifact, boot a simulator and install it by hand. Phase 2 makes that one click: after Implement delivers code for a mobile app, Specrails offers "Test in Mobile Device", builds the app for the simulator, installs and launches it through Tapflow, and the person sees it running. Tapflow stays invisible.

## What Changes

- **Mobile project detection** (pure, `server/modules/tapflow/mobile-project.ts`): native Xcode apps (iOS app targets only), native Gradle apps (`com.android.application`), Kotlin Multiplatform, Flutter, React Native and Expo (managed: `expo prebuild`). Simulator build plans (Debug, unsigned, arm64, derived data under `.specrails/mobile-build/`) and artifact selection (`.app` zipped on upload, arm64/universal `.apk`; never `.ipa`/`.aab`).
- **Platform choice**: a single-platform project tests its platform without asking; a multiplatform one asks iOS / Android / Both, recommending the platform the change touched (shared code → both) or the person's last choice for the project, which is remembered.
- **Built-in loop `factory:mobile-test`** ("Test in Mobile Device"): a Core definition with two Desktop host tasks, `mobile.build` (detect, resolve the Xcode scheme, run the build in the run's working copy, find the artifact) and `tapflow.deliver` (upload the build, open a device session, boot, install, launch, always disconnect). Autonomous: a failure ends the run with the reason and the build log tail. Offered only when Tapflow is installed, the Core advertises host tasks and the project has a mobile app.
- **Offer after delivery**: a mission row like the PR CI offer, with the platform buttons when the project is multiplatform.
- **Device lifecycle**: one device per platform, shut down after an idle grace period once nobody watches it (the spike measured the capture running until `shutdown_device`).

## Capabilities

### New Capabilities
- `mobile-device-testing`: detect mobile apps, build them for simulators and run them on Tapflow devices from a loop offered after delivery.

### Modified Capabilities
<!-- None. -->

## Impact

- `server/modules/tapflow`: mobile-project domain, host-task handlers and their adapters (build runner, Tapflow MCP client), offer projection.
- `server/modules/loops`: the `factory:mobile-test` recipe and factory registration; host-task handler composition in `server/project-context-loops.ts`.
- Client: the offer row with platform choice; strings in the 8 locales.
- Native device windows are phase 2b (separate change).
