## 1. PATH resolver module

- [x] 1.1 Create `server/path-resolver.ts` exporting `resolveStartupPath()` (sync) and `augmentPathFromLoginShell()` (async)
- [x] 1.2 Implement fast-path: prepend missing `/opt/homebrew/{bin,sbin}` and `/usr/local/{bin,sbin}` on darwin; `/usr/local/{bin,sbin}` and `~/.local/bin` on linux; no-op on win32
- [x] 1.3 Implement login-shell merge with `$SHELL -lic 'printf "__SRH_PATH_BEGIN__%s__SRH_PATH_END__" "$PATH"'`, 1500ms timeout, `/bin/sh` fallback when `$SHELL` unset
- [x] 1.4 Implement sentinel-based parser that extracts content between `__SRH_PATH_BEGIN__` and `__SRH_PATH_END__`, ignoring any rc-file noise before/after
- [x] 1.5 Track per-segment source (`'inherited' | 'fast-path' | 'login-shell'`) and login-shell status (`'ok' | 'skipped' | 'timeout' | 'error'`); expose via `getPathDiagnostic()`
- [x] 1.6 Skip `augmentPathFromLoginShell()` when `process.env.NODE_ENV === 'test'` or `process.env.VITEST === 'true'`
- [x] 1.7 Accept an optional `spawn` injection seam in `augmentPathFromLoginShell()` for unit tests

## 2. Wire resolver into server startup

- [x] 2.1 Call `resolveStartupPath()` in `server/index.ts` before any router / manager / `ProjectRegistry` initialisation
- [x] 2.2 Call `augmentPathFromLoginShell()` immediately after `app.listen` resolves; do not await it
- [x] 2.3 Add a single startup log line: `path resolver: inherited=<N> augmented=<M> loginShell=<status> source=<gui|terminal>` (heuristic: `source=terminal` when stdin is a TTY)

## 3. Prerequisites detection: distinguish installed vs executable

- [x] 3.1 In `server/setup-prerequisites.ts`, add `executable: boolean` to `SetupPrerequisite` and `SetupPrerequisitesStatus`
- [x] 3.2 Update `commandVersion` (or add a sibling probe) so the caller can distinguish "command not found" from "command found but failed to execute"
- [x] 3.3 Set `executable = installed && versionProbeSucceeded`; gate `meetsMinimum` on both `installed && executable && version-meets`
- [x] 3.4 Add a broken-symlink-aware `installHint` for the `installed && !executable` case ("found at <path> but failed to execute — possibly a broken symlink. Reinstall the tool or remove the stale link at <path>.")
- [x] 3.5 Update `formatMissingSetupPrerequisites` to emit the new hint for the `!executable` branch
- [x] 3.6 Update `client/src/types.ts` `SetupPrerequisite` shape to include `executable` (lives in `client/src/features/projects/hooks/usePrerequisites.ts` — no separate types.ts entry; updated there)

## 4. Diagnostic endpoint

- [x] 4.1 Extend `GET /api/hub/setup-prerequisites` in `server/hub-router.ts` to read `?diagnostic=1` query flag
- [x] 4.2 When the flag is set, attach a `diagnostic` field with `pathSegments`, `pathSources`, `loginShellStatus`, `whichResults`, `nodeEnv`, `platform`
- [x] 4.3 Ensure the default response (no flag) does NOT include the `diagnostic` field — keeps the regular UI payload small

## 5. Client surfacing

- [x] 5.1 Update `client/src/features/projects/components/PrerequisitesPanel.tsx` to render the `installed && !executable` state with a distinct visual (warning, not error) and the new hint copy
- [x] 5.2 Add a "Copy diagnostics" affordance in `client/src/features/projects/components/InstallInstructionsModal.tsx` that fetches `?diagnostic=1` and copies the JSON to the clipboard with a short success toast
- [x] 5.3 Update `client/src/features/projects/hooks/usePrerequisites.ts` only if needed to thread the `executable` field through (prefer no API change to the hook)

## 6. Tests

- [x] 6.1 Create `server/path-resolver.test.ts`:
  - [x] 6.1.1 Fast-path prepends missing dirs on darwin
  - [x] 6.1.2 Fast-path is idempotent when dirs already present
  - [x] 6.1.3 Fast-path is no-op on win32
  - [x] 6.1.4 Login-shell parser extracts content between sentinels and ignores noise
  - [x] 6.1.5 Login-shell timeout leaves PATH unchanged and logs warning once
  - [x] 6.1.6 Login-shell skipped under `VITEST=true`
- [x] 6.2 Extend `server/setup-prerequisites.test.ts`:
  - [x] 6.2.1 `installed && !executable` branch produces the broken-symlink hint
  - [x] 6.2.2 `meetsMinimum` is false when `executable` is false even if a stale version string is present
- [x] 6.3 Extend `server/hub-router.ts` tests:
  - [x] 6.3.1 `?diagnostic=1` returns `diagnostic` field with expected shape
  - [x] 6.3.2 default request omits `diagnostic`
- [x] 6.4 Extend `client/src/features/projects/components/__tests__/PrerequisitesPanel.test.tsx`:
  - [x] 6.4.1 Renders broken-symlink state with new copy when `installed && !executable`

## 7. Documentation & release notes

- [x] 7.1 Update `CLAUDE.md` "Developer prerequisites gate" paragraph to mention PATH resolution at startup and the diagnostic flag
- [x] 7.2 Add a short note in `docs/windows.md` (or create `docs/macos.md`) describing the GUI-launch PATH behaviour and the `?diagnostic=1` debug flag
- [ ] 7.3 Manually verify on Apple Silicon Mac: launch app from Finder with brew-installed node, confirm `Node.js` shows green in `AddProjectDialog`
- [ ] 7.4 Manually verify the broken-symlink case by creating a dangling `/usr/local/bin/node` symlink and confirming the new hint appears
