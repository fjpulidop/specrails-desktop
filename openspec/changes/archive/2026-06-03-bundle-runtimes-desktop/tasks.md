# Tasks: bundle-runtimes-desktop

Tasks are ordered by dependency. Each task is atomic and independently testable. Dependencies are noted where non-obvious.

---

## Task 1: Extend `PathSource` and add `resolveBundledRuntimePath()` to `server/path-resolver.ts`

**Layer**: `[backend]`

**Description**: Add the `'bundled'` literal to the `PathSource` type and export the new `resolveBundledRuntimePath()` function. This is the foundation all subsequent path-resolver changes build on. No behavior changes yet — just type and new function.

**Files**:
- Modify: `server/path-resolver.ts`

**Changes**:

1. Extend `PathSource`:
   ```typescript
   export type PathSource = 'inherited' | 'fast-path' | 'login-shell' | 'bundled'
   ```

2. Add `resolveBundledRuntimePath()`:
   ```typescript
   export function resolveBundledRuntimePath(): string {
     const p = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
     if (!p) {
       throw new Error(
         '[path-resolver] resolveBundledRuntimePath() called but SPECRAILS_BUNDLED_RUNTIMES_PATH is not set'
       )
     }
     return p
   }
   ```

**Acceptance criteria**:
- `resolveBundledRuntimePath()` returns `process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH` when set.
- `resolveBundledRuntimePath()` throws with a clear message when the env var is not set.
- `PathSource` type accepts `'bundled'` — TypeScript compilation succeeds.
- Existing `resolveStartupPath()` and `augmentPathFromLoginShell()` behavior unchanged.
- Unit tests in `server/path-resolver.test.ts` cover both success and throw cases.

---

## Task 2: Gate `resolveStartupPath()` on desktop mode

**Layer**: `[backend]`

**Description**: Modify `resolveStartupPath()` to enter a new desktop-mode branch when `SPECRAILS_IS_DESKTOP=1`. In desktop mode, prepend the bundled Node and Git bin directories as the first PATH entries; skip the homebrew/fast-path logic. Non-desktop mode is unchanged.

**Files**:
- Modify: `server/path-resolver.ts`

**Depends on**: Task 1

**Changes**:

At the top of `resolveStartupPath()`, before any existing logic:

```typescript
if (process.env.SPECRAILS_IS_DESKTOP === '1') {
  const runtimesPath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (runtimesPath) {
    const isWin = process.platform === 'win32'
    const toPrepend = isWin
      ? [
          path.join(runtimesPath, 'node'),
          path.join(runtimesPath, 'git', 'cmd'),
        ]
      : [
          path.join(runtimesPath, 'node', 'bin'),
          path.join(runtimesPath, 'git', 'bin'),
        ]
    const inherited = splitPath(process.env.PATH)
    const inheritedSet = new Set(inherited)
    const toAdd = toPrepend.filter((d) => !inheritedSet.has(d))
    const merged = [...toAdd, ...inherited]
    process.env.PATH = joinPath(merged)
    diagnostic = {
      pathSegments: merged,
      pathSources: [
        ...toAdd.map(() => 'bundled' as PathSource),
        ...inherited.map(() => 'inherited' as PathSource),
      ],
      loginShellStatus: 'skipped',
    }
  }
  return
}
```

**Acceptance criteria**:
- When `SPECRAILS_IS_DESKTOP=1` and `SPECRAILS_BUNDLED_RUNTIMES_PATH=/tmp/runtimes`, `process.env.PATH` starts with `/tmp/runtimes/node/bin:/tmp/runtimes/git/bin:` (macOS) or equivalent Windows dirs.
- `diagnostic.pathSources` for those dirs is `'bundled'`.
- When `SPECRAILS_IS_DESKTOP` is unset, no behavior change — all existing tests pass.
- `__resetPathResolverForTest()` still resets state correctly.
- New unit tests cover: desktop mode sets PATH, desktop mode without BUNDLED_RUNTIMES_PATH is a no-op (no crash), non-desktop path unchanged.

---

## Task 3: Gate `augmentPathFromLoginShell()` on desktop mode

**Layer**: `[backend]`

**Description**: Make `augmentPathFromLoginShell()` a no-op when `SPECRAILS_IS_DESKTOP=1`. Add the guard immediately after the existing Windows and test env guards.

**Files**:
- Modify: `server/path-resolver.ts`

**Depends on**: Task 1

**Changes**:

In `augmentPathFromLoginShell()`, after the `process.env.NODE_ENV === 'test'` guard:

```typescript
if (process.env.SPECRAILS_IS_DESKTOP === '1') {
  diagnostic.loginShellStatus = 'skipped'
  return
}
```

**Acceptance criteria**:
- When `SPECRAILS_IS_DESKTOP=1`, `augmentPathFromLoginShell()` resolves immediately without spawning a shell process.
- `diagnostic.loginShellStatus` is `'skipped'` after the no-op return.
- Non-desktop mode: existing behavior unchanged, all existing tests pass.
- New unit test covers: desktop mode returns without calling `spawn`.

---

## Task 4: Extend `server/setup-prerequisites.ts` with desktop-mode bundle health check

**Layer**: `[backend]`

**Description**: Add two new optional fields to `SetupPrerequisite` (`bundled` and `error`) and introduce a desktop-mode branch in `getSetupPrerequisitesStatus()` that probes bundled binary absolute paths instead of running `which` against the system PATH. Claude/Codex provider CLIs remain probed via the system PATH in all modes.

**Files**:
- Modify: `server/setup-prerequisites.ts`

**Depends on**: Task 1 (for the env var convention, but not a direct call dependency)

**Changes**:

1. Extend the `SetupPrerequisite` interface:
   ```typescript
   export interface SetupPrerequisite {
     // ... existing fields ...
     bundled?: true
     error?: 'corrupted-bundle'
   }
   ```

2. Add internal helpers (not exported):
   ```typescript
   type BundledToolKey = 'node' | 'npm' | 'npx' | 'git'
   const BUNDLED_TOOL_KEYS: ReadonlySet<string> = new Set(['node', 'npm', 'npx', 'git'])

   function isBundledTool(key: string): key is BundledToolKey {
     return BUNDLED_TOOL_KEYS.has(key)
   }

   function getBundledToolPath(runtimesBase: string, tool: BundledToolKey): string {
     if (process.platform === 'win32') {
       const map: Record<BundledToolKey, string> = {
         node: path.join(runtimesBase, 'node', 'node.exe'),
         npm:  path.join(runtimesBase, 'node', 'npm.cmd'),
         npx:  path.join(runtimesBase, 'node', 'npx.cmd'),
         git:  path.join(runtimesBase, 'git',  'cmd', 'git.exe'),
       }
       return map[tool]
     }
     const map: Record<BundledToolKey, string> = {
       node: path.join(runtimesBase, 'node', 'bin', 'node'),
       npm:  path.join(runtimesBase, 'node', 'bin', 'npm'),
       npx:  path.join(runtimesBase, 'node', 'bin', 'npx'),
       git:  path.join(runtimesBase, 'git',  'bin', 'git'),
     }
     return map[tool]
   }
   ```

3. In `getSetupPrerequisitesStatus()`, in the `definitions.map(...)` block, add a branch before the existing `locateCommand` call:
   ```typescript
   const isDesktop = process.env.SPECRAILS_IS_DESKTOP === '1'
   const runtimesBase = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? ''

   const prerequisites: SetupPrerequisite[] = definitions.map((definition) => {
     if (isDesktop && definition.kind === 'tool' && isBundledTool(definition.key)) {
       const bundledPath = getBundledToolPath(runtimesBase, definition.key as BundledToolKey)
       const probe = probeVersion(definition.key, bundledPath)
       if (!probe.executed) {
         return {
           ...definition,
           installed: true,
           executable: false,
           bundled: true as const,
           error: 'corrupted-bundle' as const,
           resolvedPath: bundledPath,
           executionError: probe.error,
           meetsMinimum: false,
           installHint: 'Bundle corrupted — reinstall the SpecRails Hub app.',
         }
       }
       const meetsMinimum = installed && executable && meetsMinimumVersion(probe.version, definition.minVersion)
       return {
         ...definition,
         installed: true,
         executable: true,
         bundled: true as const,
         version: probe.version,
         resolvedPath: bundledPath,
         meetsMinimum: meetsMinimumVersion(probe.version, definition.minVersion),
         installHint: '',
       }
     }
     // Existing system probe path ...
   })
   ```

**Note**: The `path` import must be added at the top of `setup-prerequisites.ts` (currently only `spawnSync` and `listAdapters` are imported).

**Acceptance criteria**:
- When `SPECRAILS_IS_DESKTOP=1` and bundled binaries are probed successfully: all four tool entries have `bundled: true, installed: true, executable: true`.
- When `SPECRAILS_IS_DESKTOP=1` and a bundled binary probe fails: the entry has `bundled: true, executable: false, error: 'corrupted-bundle'`, and `installHint` is the corrupted-bundle message.
- Provider CLIs (claude, codex) are always probed via the system path regardless of desktop mode.
- `formatMissingSetupPrerequisites()` surfaces the corrupted-bundle hint correctly.
- Non-desktop mode: all existing behavior and tests pass.
- New unit tests in `server/setup-prerequisites.test.ts` cover desktop mode success and desktop mode corruption paths, with `SPECRAILS_IS_DESKTOP` and `SPECRAILS_BUNDLED_RUNTIMES_PATH` set in the test env.

---

## Task 5: Update `server/path-resolver.test.ts` — full coverage for desktop mode

**Layer**: `[backend]`

**Description**: Add test coverage for all three path-resolver desktop-mode behaviors: `resolveBundledRuntimePath()`, the desktop branch of `resolveStartupPath()`, and the desktop no-op in `augmentPathFromLoginShell()`. Uses `__resetPathResolverForTest()` between tests.

**Files**:
- Modify: `server/path-resolver.test.ts`

**Depends on**: Tasks 1, 2, 3

**Test cases to add**:

```
resolveBundledRuntimePath
  ✓ returns env var value when set
  ✓ throws when env var is missing

resolveStartupPath — desktop mode
  ✓ prepends node/bin and git/bin dirs when SPECRAILS_IS_DESKTOP=1 (macOS)
  ✓ prepends node/ and git/cmd/ dirs when SPECRAILS_IS_DESKTOP=1 (Windows)
  ✓ marks prepended dirs as 'bundled' in diagnostic
  ✓ is a no-op when SPECRAILS_IS_DESKTOP=1 but BUNDLED_RUNTIMES_PATH unset (no crash)
  ✓ does NOT run homebrew prepend when SPECRAILS_IS_DESKTOP=1

augmentPathFromLoginShell — desktop mode
  ✓ returns immediately without spawning when SPECRAILS_IS_DESKTOP=1
  ✓ sets loginShellStatus to 'skipped' in desktop mode
```

**Acceptance criteria**:
- All new tests pass.
- Existing tests still pass (non-desktop paths preserved).
- Coverage contribution meets server coverage thresholds.

---

## Task 6: Update `server/setup-prerequisites.test.ts` — desktop mode coverage

**Layer**: `[backend]`

**Description**: Add test coverage for the desktop-mode branch of `getSetupPrerequisitesStatus()`. Mock `probeVersion` behavior using env vars and `spawnSync` mocking.

**Files**:
- Modify: `server/setup-prerequisites.test.ts`

**Depends on**: Task 4

**Test cases to add**:

```
getSetupPrerequisitesStatus — desktop mode
  ✓ all bundled tools return bundled: true, installed: true, executable: true on success
  ✓ resolvedPath is the bundled binary path, not a system which result
  ✓ meetsMinimum is true when version meets threshold
  ✓ corrupted-bundle: executable: false, error: 'corrupted-bundle' when probe fails
  ✓ corrupted-bundle: installHint is 'Bundle corrupted — reinstall...'
  ✓ corrupted-bundle: entry appears in missingRequired
  ✓ provider CLIs (claude/codex) are still probed via system path in desktop mode
  ✓ non-desktop mode unchanged: uses which, no bundled field
```

**Acceptance criteria**:
- All new tests pass.
- Server coverage thresholds maintained (80% lines/functions/statements).

---

## Task 7: Set env vars on sidecar spawn in `src-tauri/src/lib.rs`

**Layer**: `[infra]`

**Description**: Before calling `.spawn()` on the sidecar command, resolve the bundled runtimes path via Tauri's resource API and inject `SPECRAILS_IS_DESKTOP=1` and `SPECRAILS_BUNDLED_RUNTIMES_PATH` into the sidecar environment. The existing macOS login-shell PATH override is retained (it's needed for Claude CLI discovery, not for Node/Git).

**Files**:
- Modify: `src-tauri/src/lib.rs`

**Changes**:

In the `setup` closure, after the sidecar is created via `app_handle.shell().sidecar("specrails-server")` and before the macOS `#[cfg(target_os = "macos")]` block:

```rust
// Resolve bundled runtimes path from Tauri resource directory.
let runtimes_path = app_handle
    .path()
    .resource_dir()
    .ok()
    .map(|p| p.join("runtimes").to_string_lossy().into_owned())
    .unwrap_or_default();

let sidecar = app_handle
    .shell()
    .sidecar("specrails-server")
    .expect("specrails-server sidecar not configured")
    .args([&parent_pid_arg])
    .env("SPECRAILS_IS_DESKTOP", "1")
    .env("SPECRAILS_BUNDLED_RUNTIMES_PATH", &runtimes_path);
```

The `#[cfg(target_os = "macos")]` login-shell PATH override block continues to chain `.env("PATH", &shell_path)` after the base sidecar. Chain order matters: the sidecar's `PATH` env from the macOS block is set AFTER `SPECRAILS_BUNDLED_RUNTIMES_PATH`, so the sidecar inherits both independently. The Node server's `resolveStartupPath()` then reads `SPECRAILS_BUNDLED_RUNTIMES_PATH` and prepends bundled dirs first — ahead of anything in the macOS-resolved `PATH`.

**Requires Cargo**: `tauri::Manager` is already imported. `app_handle.path().resource_dir()` is available via `tauri::path::PathResolver` (Tauri v2 API already used in this project).

**Acceptance criteria**:
- `SPECRAILS_IS_DESKTOP=1` is present in the sidecar's environment.
- `SPECRAILS_BUNDLED_RUNTIMES_PATH` resolves to the actual `runtimes/` sub-path of the Tauri resource dir.
- Build succeeds on macOS and Windows (`cargo build --release`).
- Existing sidecar spawn behavior (port check, health poll, PID tracking) unchanged.

---

## Task 8: Add `runtimes/**/*` to `src-tauri/tauri.conf.json` bundle resources

**Layer**: `[infra]`

**Description**: Extend the `bundle.resources` array in `tauri.conf.json` to include the runtimes directory that CI will populate. This is a one-line JSON change.

**Files**:
- Modify: `src-tauri/tauri.conf.json`

**Changes**:

```json
"resources": [
  "binaries/better_sqlite3.node",
  "binaries/pty.node",
  "binaries/node-pty/**/*",
  "runtimes/**/*"
]
```

**Acceptance criteria**:
- `tauri build` completes without errors when `src-tauri/runtimes/` is populated.
- `tauri build` completes without errors when `src-tauri/runtimes/` does not exist (glob matches nothing — Tauri should not error on an empty glob for a resource entry; verify this behavior in local test build).
- The app bundle on macOS contains `Contents/Resources/runtimes/` with node and git subdirectories.
- The app bundle on Windows contains `resources/runtimes/` with node and git subdirectories.

**Note**: If Tauri errors on an empty glob, add the `runtimes/` directory to `.gitignore` and add a placeholder `.gitkeep` file so the directory always exists at build time in local development. CI populates it with real content before `tauri build`.

---

## Task 9: Add Node 22 LTS download + checksum steps to `build-macos` in `desktop-release.yml`

**Layer**: `[infra]`

**Description**: Add workflow-level env vars `NODE_BUNDLE_VERSION` and `GIT_BUNDLE_VERSION`. Add a "Download and verify Node.js" step and a "Download and verify Git" step to the `build-macos` job. Steps run before `npm run build:desktop`.

**Files**:
- Modify: `.github/workflows/desktop-release.yml`

**Changes**:

Add at workflow level (top of file, after `permissions:`):

```yaml
env:
  NODE_BUNDLE_VERSION: "22.x"
  GIT_BUNDLE_VERSION: "2.49.0"
```

Add to `build-macos` job, between "Install dependencies" and "Import codesign certificate" steps:

```yaml
- name: Download and verify Node.js ${{ env.NODE_BUNDLE_VERSION }} (macOS arm64)
  run: |
    set -euo pipefail
    NODE_VERSION=$(curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" \
      | grep 'node-v.*-darwin-arm64\.tar\.gz$' | awk '{print $2}' \
      | grep -oP 'v[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
    TARBALL="node-${NODE_VERSION}-darwin-arm64.tar.gz"
    URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"
    echo "Downloading Node.js ${NODE_VERSION} (macOS arm64)..."
    curl -fsSL "${URL}" -o "${TARBALL}"
    EXPECTED_SHA=$(curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
      | grep "${TARBALL}" | awk '{print $1}')
    ACTUAL_SHA=$(sha256sum "${TARBALL}" | awk '{print $1}')
    if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
      echo "CHECKSUM MISMATCH: expected=${EXPECTED_SHA} actual=${ACTUAL_SHA}"
      exit 1
    fi
    echo "Checksum OK: ${ACTUAL_SHA}"
    mkdir -p src-tauri/runtimes/node
    tar -xzf "${TARBALL}" --strip-components=1 -C src-tauri/runtimes/node
    rm "${TARBALL}"
    echo "Extracted Node.js ${NODE_VERSION} to src-tauri/runtimes/node/"

- name: Download and verify Git ${{ env.GIT_BUNDLE_VERSION }} (macOS arm64)
  run: |
    set -euo pipefail
    # Use a static arm64 Git binary from git-scm.com releases.
    # The exact URL pattern and checksum approach follows the same convention
    # as the Node download above. Update GIT_BUNDLE_VERSION in env to pin.
    GIT_VERSION="${{ env.GIT_BUNDLE_VERSION }}"
    # git-scm.com provides macOS binaries; for CI reproducibility we use the
    # official git/git release on GitHub which distributes universal macOS binaries.
    TARBALL="git-${GIT_VERSION}-darwin-arm64.tar.gz"
    # NOTE: the actual download URL must be confirmed against the git-scm.com
    # release page for the target version. Placeholder shown — update before merge.
    URL="https://sourceforge.net/projects/git-osx-installer/files/${TARBALL}/download"
    curl -fsSL "${URL}" -o "${TARBALL}"
    # Verify SHA256 against the checksum published alongside the release.
    # (Implementation detail: store expected SHA in GIT_MACOS_SHA secret or hardcode
    #  per version in the workflow — to be decided during implementation.)
    mkdir -p src-tauri/runtimes/git
    tar -xzf "${TARBALL}" --strip-components=1 -C src-tauri/runtimes/git
    rm "${TARBALL}"
    echo "Extracted Git ${GIT_VERSION} to src-tauri/runtimes/git/"
```

**Acceptance criteria**:
- `build-macos` job downloads Node 22 LTS and Git before `npm run build:desktop`.
- Checksum mismatch causes the job to fail with `exit 1` before any binary is extracted.
- `src-tauri/runtimes/node/` and `src-tauri/runtimes/git/` exist and are non-empty when the build step runs.

**Note for implementer**: The exact macOS arm64 Git binary distribution URL requires research during implementation. Options: `git-scm.com` static build, Homebrew bottle (requires brew installed, adds complexity), or building from source in CI. The conservative choice is the git-scm.com static build for macOS. Confirm the canonical URL and checksum mechanism before this task is merged.

---

## Task 10: Add Node 22 LTS download + checksum steps to `build-windows` in `desktop-release.yml`

**Layer**: `[infra]`

**Description**: Add Node and Git download + checksum steps to the `build-windows` job, analogous to Task 9 but targeting Windows x64.

**Files**:
- Modify: `.github/workflows/desktop-release.yml`

**Changes**:

Add to `build-windows` job, between "Install dependencies" and "Build desktop app" steps:

```yaml
- name: Download and verify Node.js ${{ env.NODE_BUNDLE_VERSION }} (Windows x64)
  shell: bash
  run: |
    set -euo pipefail
    NODE_VERSION=$(curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" \
      | grep 'node-v.*-win-x64\.zip$' | awk '{print $2}' \
      | grep -oP 'v[0-9]+\.[0-9]+\.[0-9]+' | head -n1)
    ZIPFILE="node-${NODE_VERSION}-win-x64.zip"
    URL="https://nodejs.org/dist/${NODE_VERSION}/${ZIPFILE}"
    echo "Downloading Node.js ${NODE_VERSION} (Windows x64)..."
    curl -fsSL "${URL}" -o "${ZIPFILE}"
    EXPECTED_SHA=$(curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
      | grep "${ZIPFILE}" | awk '{print $1}')
    ACTUAL_SHA=$(sha256sum "${ZIPFILE}" | awk '{print $1}')
    if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
      echo "CHECKSUM MISMATCH: expected=${EXPECTED_SHA} actual=${ACTUAL_SHA}"
      exit 1
    fi
    echo "Checksum OK: ${ACTUAL_SHA}"
    mkdir -p src-tauri/runtimes/node
    unzip -q "${ZIPFILE}" -d tmp_node
    # The zip extracts to node-vX.Y.Z-win-x64/ — move contents up one level.
    mv tmp_node/node-${NODE_VERSION}-win-x64/* src-tauri/runtimes/node/
    rmdir tmp_node/node-${NODE_VERSION}-win-x64 tmp_node
    rm "${ZIPFILE}"
    echo "Extracted Node.js ${NODE_VERSION} to src-tauri/runtimes/node/"

- name: Download and verify Git for Windows portable (x64)
  shell: bash
  run: |
    set -euo pipefail
    GIT_VERSION="${{ env.GIT_BUNDLE_VERSION }}"
    # Git for Windows portable: self-extracting 7z archive from GitHub releases.
    ARCHIVE="PortableGit-${GIT_VERSION}-64-bit.7z.exe"
    URL="https://github.com/git-for-windows/git/releases/download/v${GIT_VERSION}.windows.1/${ARCHIVE}"
    echo "Downloading Git for Windows ${GIT_VERSION} portable (x64)..."
    curl -fsSL -L "${URL}" -o "${ARCHIVE}"
    # Verify SHA256 (checksum published in the GitHub release body).
    # (Store expected SHA as GIT_WINDOWS_SHA env var or hardcode per version.)
    echo "Extracting Git for Windows..."
    mkdir -p src-tauri/runtimes/git
    # The portable 7z.exe is a self-extracting archive.
    chmod +x "${ARCHIVE}"
    ./"${ARCHIVE}" -o"src-tauri/runtimes/git" -y
    rm "${ARCHIVE}"
    echo "Extracted Git for Windows to src-tauri/runtimes/git/"
```

**Acceptance criteria**:
- `build-windows` job downloads Node 22 LTS zip (Windows x64) and Git for Windows portable before `npm run build:desktop`.
- Checksum mismatch causes job failure before extraction.
- `src-tauri/runtimes/node/` contains `node.exe`, `npm.cmd`, `npx.cmd`.
- `src-tauri/runtimes/git/cmd/` contains `git.exe`.

---

## Task 11: Add smoke test steps to `build-macos` and `build-windows`

**Layer**: `[infra]`

**Description**: After `npm run build:desktop` (or after the upload step), add a smoke test step that strips system Node and Git from the runner's PATH and verifies the bundled binaries respond to `--version`. Job fails if any binary exits non-zero.

**Files**:
- Modify: `.github/workflows/desktop-release.yml`

**Depends on**: Tasks 9, 10

**Changes (macOS)**:

Add after the build step, before the upload step:

```yaml
- name: Smoke test bundled runtimes (macOS arm64)
  run: |
    set -euo pipefail
    # Scrub common system Node and Git locations from PATH.
    CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' \
      | grep -vE '(/usr/local/bin|/opt/homebrew|nvm|volta|nodenv|node|n/)' \
      | tr '\n' ':' | sed 's/:$//')
    export PATH="${CLEAN_PATH}"

    echo "=== PATH after scrub ==="
    echo "$PATH"
    echo "========================"

    BUNDLED_NODE="src-tauri/runtimes/node/bin/node"
    BUNDLED_NPM="src-tauri/runtimes/node/bin/npm"
    BUNDLED_NPX="src-tauri/runtimes/node/bin/npx"
    BUNDLED_GIT="src-tauri/runtimes/git/bin/git"

    echo "Testing bundled node..." && "${BUNDLED_NODE}" --version
    echo "Testing bundled npm..."  && "${BUNDLED_NPM}"  --version
    echo "Testing bundled npx..."  && "${BUNDLED_NPX}"  --version
    echo "Testing bundled git..."  && "${BUNDLED_GIT}"  --version
    echo "Smoke test PASSED."
```

**Changes (Windows)**:

```yaml
- name: Smoke test bundled runtimes (Windows x64)
  shell: pwsh
  run: |
    $ErrorActionPreference = "Stop"
    # Scrub system Node and Git from PATH.
    $cleanPath = ($env:PATH -split ';') | Where-Object {
      $_ -notmatch 'node' -and $_ -notmatch 'Git' -and $_ -notmatch 'nvm'
    } | Join-String -Separator ';'
    $env:PATH = $cleanPath

    Write-Host "=== PATH after scrub ===" ; Write-Host $env:PATH ; Write-Host "========================"

    $node = "src-tauri\runtimes\node\node.exe"
    $npm  = "src-tauri\runtimes\node\npm.cmd"
    $npx  = "src-tauri\runtimes\node\npx.cmd"
    $git  = "src-tauri\runtimes\git\cmd\git.exe"

    foreach ($tool in @($node, $npm, $npx, $git)) {
      Write-Host "Testing ${tool}..."
      & $tool --version
      if ($LASTEXITCODE -ne 0) { Write-Error "${tool} --version failed"; exit 1 }
    }
    Write-Host "Smoke test PASSED."
```

**Acceptance criteria**:
- Both `build-macos` and `build-windows` jobs include the smoke test step.
- If any bundled binary exits non-zero, the job fails and no artifacts are uploaded.
- Smoke test runs against the unpacked `src-tauri/runtimes/` directory (pre-bundle contents), not the final `.dmg` or `.exe`.
- macOS: smoke test output shows 4 successful `--version` lines.
- Windows: smoke test output shows 4 successful `--version` lines.

---

## Task 12: Update `PrerequisitesPanel` for desktop-mode corrupted-bundle display

**Layer**: `[frontend]`

**Description**: Modify `client/src/features/projects/components/PrerequisitesPanel.tsx` (and associated hooks/types) to handle the `bundled: true` and `error: 'corrupted-bundle'` fields on prerequisite entries. In desktop mode, suppress the "More info" link and `InstallInstructionsModal`. Show "Bundle corrupted — reinstall app" message for corrupt entries.

**Files**:
- Modify: `client/src/features/projects/components/PrerequisitesPanel.tsx`
- Modify: `client/src/features/projects/hooks/usePrerequisites.ts` (add type for new fields)

**Changes**:

1. Extend the client-side `SetupPrerequisite` type (in the hooks file or a shared types file) to include:
   ```typescript
   bundled?: true
   error?: 'corrupted-bundle'
   ```

2. In `PrerequisitesPanel`, for each tool entry:
   - If `item.error === 'corrupted-bundle'`: render a red error row with "Bundle corrupted — reinstall the SpecRails Hub app." Do NOT render the "More info" link. Do NOT allow triggering `InstallInstructionsModal`.
   - If `item.bundled === true` and `item.executable === true`: render a green row with the version string and a small "bundled" badge (optional visual indicator).
   - If neither field is present: existing render logic unchanged.

3. `AddProjectDialog` already disables submit when `missingRequired.length > 0`. No changes needed there — the corrupted-bundle entry propagates via `missingRequired` correctly.

**Acceptance criteria**:
- When API returns `error: 'corrupted-bundle'` on a tool, the panel shows the corrupted-bundle message with no install link.
- When API returns `bundled: true` on all tools and all are executable, the panel shows all-green with no user action required.
- Existing non-desktop panel behavior unchanged.
- Client test coverage: add cases in the existing `PrerequisitesPanel` test file for the corrupted-bundle state and the all-bundled-healthy state.

---

## Task 13: Update `InstallInstructionsModal` to guard against rendering in desktop mode

**Layer**: `[frontend]`

**Description**: As a defence-in-depth guard, the `InstallInstructionsModal` component should not render OS-specific install instructions when the currently-missing tool has `error === 'corrupted-bundle'`. This is secondary to the `PrerequisitesPanel` change in Task 12 (which should prevent the modal from being opened at all), but ensures robustness.

**Files**:
- Modify: `client/src/features/projects/components/InstallInstructionsModal.tsx` (or wherever the modal is defined)

**Changes**:

At the start of the modal's render, check if the selected tool has `error === 'corrupted-bundle'`. If so, render a simplified error panel: "This tool is bundled with the SpecRails Hub app and cannot be installed separately. If you see this message, the app bundle may be corrupted. Please reinstall SpecRails Hub." Include a "Close" button only (no copy-to-clipboard, no install commands).

**Acceptance criteria**:
- Modal does not show OS install commands when `error === 'corrupted-bundle'`.
- Modal shows the reinstall message instead.
- Non-desktop modal behavior unchanged.

---

## Task 14: Add `.gitignore` entry for `src-tauri/runtimes/`

**Layer**: `[infra]`

**Description**: The `src-tauri/runtimes/` directory is populated by CI at build time and must not be committed. Add it to `.gitignore`.

**Files**:
- Modify: `.gitignore`

**Changes**:

```
# Bundled runtimes — populated by CI, not checked in
src-tauri/runtimes/
```

If Tauri errors on an empty `runtimes/**/*` resource glob (Task 8 note), also add a tracked placeholder:

```
# Keep the runtimes dir present for local builds (populated by CI with real binaries)
src-tauri/runtimes/.gitkeep
```

Then add to `.gitignore`:
```
src-tauri/runtimes/*
!src-tauri/runtimes/.gitkeep
```

**Acceptance criteria**:
- `git status` shows no untracked content under `src-tauri/runtimes/` after populating it locally.
- `.gitkeep` (if added) IS tracked by git.
- `npm run dev:server` and local non-desktop usage are unaffected.

---

## Task 15: Integration test — path-resolver diagnostic in desktop mode

**Layer**: `[backend]`

**Description**: Add a test that simulates the full desktop startup sequence: set `SPECRAILS_IS_DESKTOP=1` and `SPECRAILS_BUNDLED_RUNTIMES_PATH`, call `resolveStartupPath()`, then call `augmentPathFromLoginShell()` with a mock spawn, and verify that PATH starts with the bundled dirs and the mock spawn was never called.

**Files**:
- Modify: `server/path-resolver.test.ts`

**Depends on**: Tasks 2, 3, 5

**Acceptance criteria**:
- Full sequence test passes: bundled dirs are first in PATH; mock spawn was not called; `loginShellStatus` is `'skipped'`.
- `getPathDiagnostic()` returns `pathSources` with `'bundled'` for the prepended dirs.
- Coverage contribution maintains thresholds.

---

## Task 16: Review and update CLAUDE.md documentation sections

**Layer**: `[docs]`

**Description**: Update the relevant sections in `CLAUDE.md` to reflect the new desktop-mode behavior. Specifically: `GUI-launch PATH resolution`, `Developer prerequisites gate`, and add the new `bundled-runtimes` capability and `Env Vars Contract` table per the delta-spec.

**Files**:
- Modify: `CLAUDE.md`

**Depends on**: All preceding tasks complete.

**Acceptance criteria**:
- `CLAUDE.md` accurately describes: `SPECRAILS_IS_DESKTOP` and `SPECRAILS_BUNDLED_RUNTIMES_PATH` env vars; desktop-mode `resolveStartupPath()` behavior; desktop-mode prerequisite check behavior; `resolveBundledRuntimePath()` export; new `'bundled'` PathSource; `bundled-runtimes` capability section.
- No references to "homebrew prepend" in the desktop-mode code path description.
- Existing non-desktop behavior descriptions unchanged.
