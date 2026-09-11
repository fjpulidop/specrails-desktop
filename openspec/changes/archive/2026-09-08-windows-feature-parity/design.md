## Context

The app ships Tauri installers with a pkg Node sidecar, external SQLite/PTY/Playwright packages, bundled Node/Git/core, and separate x64/ARM64 release jobs. Most unit suites run only on Linux. The working branch includes multi-repo, mission steering, process logs and the new code explorer; this audit includes those features.

## Goals / Non-Goals

**Goals:** Preserve the same user workflows on Windows, remove platform assumptions, make native dependency and installed startup failures block publication, and record evidence per feature.

**Non-Goals:** Promise untested compatibility with every enterprise policy, automatically publish a release, change user data, or introduce Windows-only product semantics.

## Decisions

1. Centralize platform behavior at existing path/process/native boundaries. Prefer argv-based subprocess APIs and Node filesystem APIs over translating shell strings at each caller. Preserve existing POSIX behavior with regression coverage.
2. Emit Windows updater entries for both `OS-ARCH-nsis` and `OS-ARCH-msi`; the installed Tauri updater already selects those before the generic key. Keep a generic NSIS alias for legacy clients. Fail the manifest generation when a paired artifact/signature is absent; silently swapping installer families creates duplicate installs.
3. Validate bundled native modules after pruning and test the actual installed sidecar from a path containing spaces. Loading source modules on a build runner cannot prove that the installer contains usable resources.
4. Add a native Windows CI matrix for platform-sensitive regression tests and release installation smoke tests. Keep GUI/manual verification separate from headless checks and avoid claiming that macOS tests prove Windows behavior.
5. Keep the audit matrix and reproducible checks in the Windows platform guide. New findings refine implementation tasks as the audit proceeds.
6. Own background applications with a Windows Job Object before admitting the user command. A separate supervisor retains the job handle after wrappers exit; Stop and host loss terminate the contained job. Process snapshots cannot prove descendant ownership when intermediate launchers exit between polls. Job setup failures must fail before command admission.

## Risks / Trade-offs

- Native WebView2/ConPTY and installer behavior cannot run on this macOS host → add real Windows runner gates and label unexecuted checks clearly.
- Offline WebView2 provisioning increases installer size → use the supported evergreen offline installer to avoid first-launch network failures on clean Windows machines.
- Platform fixes touch shared infrastructure → run focused regressions first, then server/client type checking and full suites.
- Enterprise SSO policies and external provider availability differ by machine → verify app mechanics independently and document external prerequisites.
