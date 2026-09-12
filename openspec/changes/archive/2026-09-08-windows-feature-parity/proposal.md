## Why

Windows x64 and ARM64 installers exist, but the current checks do not exercise the installed application and recent features have primarily been verified on macOS. Platform-specific failures in process execution, native integrations, filesystem operations, and updates must be caught before a release.

## What Changes

- Audit every app surface for Windows assumptions and fix reproducible defects, preserving macOS behavior.
- Keep Windows updates within their installation format (NSIS or MSI) and reject incomplete release artifacts.
- Verify packaged native dependencies and add Windows runtime regression and installed-app smoke gates for both architectures.
- Document the supported feature matrix, dependencies, and remaining real-device verification explicitly.

## Capabilities

### New Capabilities
- `windows-feature-parity`: Cross-platform execution, filesystem and native desktop behavior, plus verification gates for shipped Windows builds.

### Modified Capabilities
- `desktop-release-channel`: Require installer-specific Windows update artifacts and successful Windows package smoke checks before publication.

## Impact

Server/platform helpers, providers and subprocess lifecycle, repository/filesystem services, Tauri native host, client platform integrations, build scripts and Windows CI/release workflows. Existing user data and the current branch's feature work are preserved.
