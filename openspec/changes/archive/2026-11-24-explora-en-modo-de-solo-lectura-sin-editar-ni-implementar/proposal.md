# Proposal

## Why

The Intent session started as a read-only exploration of the general-resources button in the status bar, which vanished when the work-process count reached zero with the panel closed. The person then approved the minimal fix and, in the same Intent, asked for follow-ups: project settings keeping the right sidebar, project settings as a native Tauri window / app modal, a bottom gap and malformed title in native modals, and native modals minimizing alone instead of dragging the main window with them. After a host verification failure, the person also asked to keep (2026-11-24 08:12 UTC, "Keep it and record it as a requirement") the bridge test isolation from an inherited headless guard.

## What Changes

- The Resources button (`AppResourcesFooter`) is always rendered. The count shows `0` when measurement confirms it; while loading, after an error or on unsupported platforms the accessible name is "Recursos de la app" and the counter is omitted. Comments describing the old visibility are corrected and the old test that required hiding is replaced.
- Project settings keeps the right sidebar, its open/closed state and its toggle button, like a mission conversation of the same project.
- Project settings opens as a native Tauri surface window (`project-settings`) in the desktop app and as the existing in-app modal on web, sharing one content implementation.
- Dialog panels and native surface panels use `overflow-clip`, fixing the bottom gap and the title losing its format; the native frame owner is released.
- On macOS the native surface window has no parent, so minimizing it no longer minimizes the main app; Windows/Linux keep owned windows.
- The agent-runtime bridge tests strip only an inherited headless-guard `--require` so they do not depend on the host process; the 100-project overview test gets a longer timeout. Both are test-only.
- Docs updated (`DESIGN.md`, modal standard, native window surfaces, feature READMEs).

## Capabilities

### New Capabilities
- `app-resources-button`: the status-bar Resources button is persistent and its count reflects measurement state.
- `project-settings-surface`: project settings presented as a native window or app modal, keeping the project right sidebar.
- `native-surface-windows`: native modal windows minimize independently of the main window and render without clipped gaps.
- `agent-runtime-test-isolation`: bridge tests ignore an inherited headless guard.

### Modified Capabilities

(none)

## Impact

Client shell and settings, shared dialog/surface components, Tauri `surface_windows.rs`, test files, and internal docs. No server production code or API contract changes.
