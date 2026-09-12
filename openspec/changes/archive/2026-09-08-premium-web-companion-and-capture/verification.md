# Verification — 2026-09-06

## Delivered scope

Desktop now exposes a versioned, grant-aware mobile mission API with bounded snapshots, queue controls, repository context and process observation. Restricted project grants cannot access global mission conversations; existing scoped Specs and Rails operations remain available. Mission capture routes confirmed selections through the annotation editor, including native capture and all-size captures, with cancellation and save retry behavior preserved.

The related Web and Companion implementations were applied to their own repositories on `codex/premium-mission-experience`. The integration checked before/after SHA-256 hashes for all 157 Web files and 19 Companion files, preserved pre-existing untracked documentation, and excluded build outputs and dependency directories. These external implementations are not part of the Desktop PR.

The website is mission-first, with current documentation, localized navigation and product descriptions in eight languages. Feature videos use the existing real application recordings with explicit playback and expansion; no simulated product interface is presented as a recording. Companion imagery is captured from the actual Flutter mission components in the read-only demo.

## Automated validation

| Area | Result |
| --- | --- |
| Desktop server coverage suite | 328 suites passed, 2 platform suites skipped; 8,114 tests passed, 7 skipped; statement coverage 86.51%, line coverage 89.22% |
| Desktop client coverage suite | 386 suites, 4,844 tests passed; statement/line coverage 89.97% |
| Desktop TypeScript | Passed |
| Desktop script tests | 65 passed |
| Desktop production build and package check | Passed; production install, CLI, MCP bridge, shell resources and integrity verified |
| Mobile gateway regression suite | 12 suites, 124 tests passed |
| Capture regression suite | 5 suites, 49 tests passed; locale parity 49 checks passed |
| Companion | Flutter analyze, 49 tests and production Web build passed |
| Web | 42 suites, 264 tests passed; statements/lines 82.02%, branches 87.77%, functions 89.59% |
| Web static/build checks | TypeScript, lint (no errors; existing Fast Refresh warnings), docs synchronization and production build passed |
| Documentation | 61 component/registry tests and 4 synchronization tests passed |
| Final real Companion image integration | ProductLanding tests passed after updating the source and intrinsic image dimensions |

All existing coverage thresholds were retained. Web coverage is limited to two workers to avoid contention with concurrent repository validation; no blanket test timeout increase was introduced.

## Browser and responsive checks

- Homepage checked at 390 and 1,440 CSS pixels in all eight locales (16 cases), including light/dark themes and reduced motion: no page overflow or uncaught page errors, and no initial MP4/WebM requests before playback.
- Documentation checked in Spanish and French at phone and desktop widths, with explicit English fallback for untranslated guides and no eager article download on the landing page.
- Download page checked on phone and desktop, including release-service failure and safe fallback links.
- Capture flow exercised in Chromium at DPR 2 with 1,440×900 and 800×720 viewports: editor appears before attachment, annotated pixels and 640×320 image size preserved, Escape/cancel retain the intended lifecycle, failed saves remain retryable and successful retry attaches once.
- Companion phone and tablet screenshots captured from the real Flutter demo with mission history, delivery state, queue/process views and message receipt icons.

## Runtime limits

The native capture IPC boundary was simulated for the browser integration checks. This change was not installed and exercised on a physical Windows machine, and the Companion was not physically tested on iOS/Android devices. Native operating-system acceptance and signed/notarized release artifacts remain CI/release validation steps. The mobile demo is observational: sending messages, changing the queue and stopping processes require a paired Desktop with the appropriate grant and advertised capability.
