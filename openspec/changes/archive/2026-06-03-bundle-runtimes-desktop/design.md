# Technical Design: bundle-runtimes-desktop

## Overview

This change introduces a "desktop mode" execution branch gated on a single env var (`SPECRAILS_IS_DESKTOP=1`) set by the Tauri host process before spawning the Node.js sidecar. The design is additive: every existing non-desktop code path is preserved exactly. The new code paths are narrow, isolated behind the env gate, and tested independently.

The change touches five distinct surfaces: the path resolver module, the prerequisites module, the Rust Tauri host, the Tauri configuration manifest, and the GitHub Actions desktop release workflow.

---

## Component Map and Data Flow

```
Tauri host (lib.rs)
  └─ sets env: SPECRAILS_IS_DESKTOP=1
               SPECRAILS_BUNDLED_RUNTIMES_PATH=/path/to/Resources/runtimes
  └─ spawns sidecar: specrails-server

sidecar startup (index.ts)
  └─ resolveStartupPath()          ← path-resolver.ts (MODIFIED)
       ├── [SPECRAILS_IS_DESKTOP=1] prepend bundled node/bin + git/bin
       └── [non-desktop]           existing homebrew/fast-path logic
  └─ augmentPathFromLoginShell()   ← path-resolver.ts (MODIFIED)
       ├── [SPECRAILS_IS_DESKTOP=1] immediate no-op return
       └── [non-desktop]           existing login-shell merge

GET /api/hub/setup-prerequisites   ← hub-router.ts → setup-prerequisites.ts (MODIFIED)
  ├── [SPECRAILS_IS_DESKTOP=1]     probe bundled absolute paths directly
  │     ├── success → { bundled: true, installed: true, executable: true }
  │     └── failure → { bundled: true, error: 'corrupted-bundle' }
  └── [non-desktop]                existing which/probe logic unchanged

CI: desktop-release.yml            ← MODIFIED
  build-macos:
    download Node 22 LTS arm64 → verify checksum → copy to src-tauri/runtimes/
    download Git macOS arm64   → verify checksum → copy to src-tauri/runtimes/
    tauri build → bundles runtimes/** via tauri.conf.json resources
    smoke test: strip PATH of node/git → probe bundled binaries

  build-windows:
    download Node 22 LTS x64  → verify checksum → copy to src-tauri/runtimes/
    download Git for Windows   → verify checksum → copy to src-tauri/runtimes/
    tauri build → bundles runtimes/** via tauri.conf.json resources
    smoke test: strip PATH of node/git → probe bundled binaries
```

---

## Surface 1: `server/path-resolver.ts`

### New export: `resolveBundledRuntimePath()`

```typescript
/**
 * Returns the absolute path to the bundled runtimes directory.
 * Only valid when SPECRAILS_IS_DESKTOP=1 and SPECRAILS_BUNDLED_RUNTIMES_PATH is set.
 * Throws if called outside desktop mode or if the env var is missing.
 */
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

`SPECRAILS_BUNDLED_RUNTIMES_PATH` is set to the absolute path of the `runtimes/` directory inside the Tauri resource root. On macOS this resolves to `<app>.app/Contents/Resources/runtimes`. On Windows it resolves to `<install-dir>/resources/runtimes`. Tauri sets this via `lib.rs` before spawn (see Surface 3).

### Modified: `resolveStartupPath()`

Add a desktop-mode early branch at the top of the function:

```typescript
export function resolveStartupPath(): void {
  // Desktop mode: bundled runtimes always win; skip all system PATH discovery.
  if (process.env.SPECRAILS_IS_DESKTOP === '1') {
    const runtimesPath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    if (runtimesPath) {
      const nodeBin = path.join(runtimesPath, 'node', 'bin')      // macOS
      const gitBin  = path.join(runtimesPath, 'git',  'bin')      // macOS
      // Windows equivalents use the same join — node.exe is directly in node/
      // and git.exe is in git/cmd/. Both dirs are prepended; harmless if absent.
      const gitCmd  = path.join(runtimesPath, 'git',  'cmd')      // Windows
      const toAdd   = [nodeBin, gitBin, gitCmd].filter(
        (d) => !splitPath(process.env.PATH).includes(d)
      )
      const merged  = [...toAdd, ...splitPath(process.env.PATH)]
      process.env.PATH = joinPath(merged)
      diagnostic = {
        pathSegments: merged,
        pathSources: [
          ...toAdd.map(() => 'bundled' as PathSource),
          ...splitPath(process.env.PATH).map(() => 'inherited' as PathSource),
        ],
        loginShellStatus: 'skipped',
      }
    }
    return
  }

  // Non-desktop: existing logic unchanged ...
}
```

`PathSource` gains a new literal `'bundled'` alongside `'inherited' | 'fast-path' | 'login-shell'`. The diagnostic response exposed by `GET /api/hub/setup-prerequisites?diagnostic=1` will surface `'bundled'` for prepended runtime dirs, which aids support diagnostics.

### Modified: `augmentPathFromLoginShell()`

Add a desktop-mode guard immediately after the existing Windows and test guards:

```typescript
export async function augmentPathFromLoginShell(opts: AugmentOptions = {}): Promise<void> {
  if (process.platform === 'win32') { ... }
  if (process.env.NODE_ENV === 'test' || ...) { ... }

  // Desktop mode: login-shell augmentation must never run — it could prepend
  // system node/git dirs ahead of bundled ones.
  if (process.env.SPECRAILS_IS_DESKTOP === '1') {
    diagnostic.loginShellStatus = 'skipped'
    return
  }

  // Existing login-shell spawn logic ...
}
```

**Why no fallback to login-shell in desktop mode**: the invariant requires bundled dirs to be first. The login-shell output could prepend `/usr/local/bin` (macOS) or a user-installed Node version manager dir, shadowing the bundled node. The only safe option is to skip augmentation entirely.

---

## Surface 2: `server/setup-prerequisites.ts`

### Modified: `getSetupPrerequisitesStatus()`

When `SPECRAILS_IS_DESKTOP=1`, the tool check loop changes entirely for `node`, `npm`, `npx`, and `git`. Instead of `which` + version probe against the resolved PATH, it uses `SPECRAILS_BUNDLED_RUNTIMES_PATH` to construct absolute paths and probes them directly.

**Desktop-mode prerequisite check logic:**

```typescript
function getBundledToolPath(runtimesBase: string, tool: 'node' | 'npm' | 'npx' | 'git'): string {
  if (process.platform === 'darwin') {
    const map = {
      node: path.join(runtimesBase, 'node', 'bin', 'node'),
      npm:  path.join(runtimesBase, 'node', 'bin', 'npm'),
      npx:  path.join(runtimesBase, 'node', 'bin', 'npx'),
      git:  path.join(runtimesBase, 'git',  'bin', 'git'),
    }
    return map[tool]
  }
  // win32
  const map = {
    node: path.join(runtimesBase, 'node', 'node.exe'),
    npm:  path.join(runtimesBase, 'node', 'npm.cmd'),
    npx:  path.join(runtimesBase, 'node', 'npx.cmd'),
    git:  path.join(runtimesBase, 'git',  'cmd', 'git.exe'),
  }
  return map[tool]
}
```

The `SetupPrerequisite` interface gains two optional fields specific to desktop mode:

```typescript
export interface SetupPrerequisite {
  // ... existing fields ...
  /** True when this tool is provided by the bundled runtime (desktop mode only). */
  bundled?: true
  /** Desktop mode: 'corrupted-bundle' when the bundled binary fails --version probe. */
  error?: 'corrupted-bundle'
}
```

The main function branches:

```typescript
export function getSetupPrerequisitesStatus(options: PrerequisiteOptions = {}): SetupPrerequisitesStatus {
  const isDesktop = process.env.SPECRAILS_IS_DESKTOP === '1'
  const runtimesBase = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? ''

  // ... tool definitions array (unchanged) ...

  const prerequisites: SetupPrerequisite[] = definitions.map((definition) => {
    // Provider CLIs (claude, codex) are never bundled — probe via which/version normally.
    if (!isDesktop || definition.kind === 'provider' || !isBundledTool(definition.key)) {
      // existing which + probeVersion logic
      return buildPrerequisiteFromSystem(definition)
    }

    // Desktop-mode: probe the bundled absolute path directly.
    const bundledPath = getBundledToolPath(runtimesBase, definition.key as BundledToolKey)
    const probe = probeVersion(definition.key, bundledPath)
    if (!probe.executed) {
      return {
        ...definition,
        installed: true,   // binary file exists (Tauri placed it); but it failed
        executable: false,
        bundled: true,
        error: 'corrupted-bundle',
        resolvedPath: bundledPath,
        executionError: probe.error,
        meetsMinimum: false,
        installHint: 'Bundle corrupted — reinstall the SpecRails Hub app.',
      }
    }
    const meetsMinimum = meetsMinimumVersion(probe.version, definition.minVersion)
    return {
      ...definition,
      installed: true,
      executable: true,
      bundled: true,
      version: probe.version,
      resolvedPath: bundledPath,
      meetsMinimum,
      installHint: '',  // never shown in desktop mode
    }
  })
  // ... rest unchanged ...
}
```

**Important**: `formatMissingSetupPrerequisites()` is the server-side defence in `SetupManager.startInstall`. In desktop mode, a corrupted bundle error from this function would surface a message like "Bundle corrupted — reinstall app" instead of OS install instructions. The existing function delegates to `installHint`, which is already overridden in the corrupted-bundle case above — no additional changes to `formatMissingSetupPrerequisites` needed.

**Client UI note**: the `PrerequisitesPanel` component reads `error: 'corrupted-bundle'` from the API response. When present, it suppresses the "More info / install instructions" modal trigger and renders a single "Bundle corrupted — reinstall app" message. This is a client-side change in `client/src/features/projects/components/PrerequisitesPanel.tsx` that is tracked as a separate task.

---

## Surface 3: `src-tauri/src/lib.rs`

### Modified: sidecar spawn

Before calling `.spawn()` on the sidecar command, inject the two new env vars:

```rust
// Resolve the bundled runtimes directory from Tauri's resource path.
// tauri::path::resource_dir() gives the Contents/Resources/ dir on macOS
// and the resources/ dir on Windows.
let runtimes_path = app_handle
    .path()
    .resource_dir()
    .ok()
    .map(|p| p.join("runtimes").to_string_lossy().to_string())
    .unwrap_or_default();

let sidecar = app_handle
    .shell()
    .sidecar("specrails-server")
    .expect("specrails-server sidecar not configured")
    .args([&parent_pid_arg])
    .env("SPECRAILS_IS_DESKTOP", "1")
    .env("SPECRAILS_BUNDLED_RUNTIMES_PATH", &runtimes_path);
```

The existing macOS login-shell PATH override (`#[cfg(target_os = "macos")]` block) is retained. That PATH is used by Claude CLI discovery — the non-bundled AI provider. It does not affect which Node or Git binary the sidecar uses, because `resolveStartupPath()` in desktop mode prepends bundled dirs first and the login-shell PATH is appended after.

**Thread safety**: `runtimes_path` is a `String` computed once in the `setup` closure. No shared mutable state. Safe to move into the sidecar env call.

---

## Surface 4: `src-tauri/tauri.conf.json`

The `bundle.resources` array currently contains:

```json
"resources": [
  "binaries/better_sqlite3.node",
  "binaries/pty.node",
  "binaries/node-pty/**/*"
]
```

Extend it with platform-specific runtime glob patterns. Tauri's resource bundler respects OS-specific overrides via the `tauri.macos.conf.json` / `tauri.windows.conf.json` pattern, but the simplest approach (and the one consistent with existing usage) is to place the runtimes under a path that works for both OS builds:

```json
"resources": [
  "binaries/better_sqlite3.node",
  "binaries/pty.node",
  "binaries/node-pty/**/*",
  "runtimes/**/*"
]
```

The CI download steps (Surface 5) place files into `src-tauri/runtimes/node/` and `src-tauri/runtimes/git/` before `tauri build` runs. Tauri then copies `runtimes/**/*` into the appropriate bundle location (`Contents/Resources/runtimes/` on macOS, `resources/runtimes/` on Windows). The relative path `runtimes/**/*` is relative to the `src-tauri/` directory, which is already Tauri's resource root.

**Directory layout written by CI (macOS arm64):**
```
src-tauri/runtimes/
  node/
    bin/
      node        (ELF arm64 binary, +x)
      npm         (shell script invoking ../lib/node_modules/npm/bin/npm-cli.js)
      npx         (shell script invoking ../lib/node_modules/npm/bin/npx-cli.js)
    lib/
      node_modules/
        npm/      (npm package tree)
  git/
    bin/
      git         (static arm64 binary, +x)
      git-*       (auxiliary git executables)
    lib/
      ...
    share/
      ...
```

**Directory layout written by CI (Windows x64):**
```
src-tauri/runtimes/
  node/
    node.exe
    npm.cmd
    npx.cmd
    node_modules/
      npm/
  git/
    cmd/
      git.exe
    usr/
      bin/
        ...
    mingw64/
      ...
```

**Why `runtimes/**/*` and not two separate entries per platform**: Tauri's resource bundling is additive — both macOS and Windows builds read the same `tauri.conf.json`. Since each CI job downloads only the binaries for its target platform and places them under `src-tauri/runtimes/`, the glob resolves to the right content per build without conditional config. An absent directory produces no error — Tauri only copies what exists.

---

## Surface 5: `.github/workflows/desktop-release.yml`

### `build-macos` job additions

**Step: Download and verify Node 22 LTS (macOS arm64)**

```yaml
- name: Download and verify Node.js ${{ env.NODE_BUNDLE_VERSION }} (macOS arm64)
  env:
    NODE_BUNDLE_VERSION: ${{ env.NODE_BUNDLE_VERSION }}
  run: |
    set -euo pipefail
    # Resolve the latest patch release for the pinned major series.
    NODE_VERSION=$(curl -sS "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" \
      | grep 'node-v.*-darwin-arm64\.tar\.gz$' | awk '{print $2}' \
      | grep -oP 'v[0-9]+\.[0-9]+\.[0-9]+' | head -n1)

    TARBALL="node-${NODE_VERSION}-darwin-arm64.tar.gz"
    URL="https://nodejs.org/dist/${NODE_VERSION}/${TARBALL}"

    echo "Downloading Node.js ${NODE_VERSION} for macOS arm64..."
    curl -fsSL "${URL}" -o "${TARBALL}"

    # Checksum verification against the official SHASUMS256.txt
    EXPECTED_SHA=$(curl -sS "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" \
      | grep "${TARBALL}" | awk '{print $1}')
    ACTUAL_SHA=$(sha256sum "${TARBALL}" | awk '{print $1}')
    if [[ "${EXPECTED_SHA}" != "${ACTUAL_SHA}" ]]; then
      echo "CHECKSUM MISMATCH for ${TARBALL}: expected=${EXPECTED_SHA} actual=${ACTUAL_SHA}"
      exit 1
    fi
    echo "Checksum OK: ${ACTUAL_SHA}"

    # Extract into src-tauri/runtimes/node/
    mkdir -p src-tauri/runtimes/node
    tar -xzf "${TARBALL}" --strip-components=1 -C src-tauri/runtimes/node
    rm "${TARBALL}"
    echo "Node.js ${NODE_VERSION} extracted to src-tauri/runtimes/node/"
```

**Step: Download and verify Git (macOS arm64)**

The macOS arm64 static Git binary is sourced from the git-scm.com releases. The exact URL and checksum mechanism follow the same pattern as the Node download step, using the `GIT_BUNDLE_VERSION` env var.

**Step: Smoke test bundled binaries (macOS)**

```yaml
- name: Smoke test bundled Node.js and Git (macOS)
  run: |
    set -euo pipefail

    # Strip system node and git from PATH to verify bundled binaries are self-contained.
    CLEAN_PATH=$(echo "$PATH" | tr ':' '\n' \
      | grep -v '/usr/local/bin' \
      | grep -v '/opt/homebrew' \
      | grep -v 'node' \
      | grep -v 'nvm' \
      | grep -v 'volta' \
      | tr '\n' ':' | sed 's/:$//')
    export PATH="${CLEAN_PATH}"

    BUNDLED_NODE="src-tauri/runtimes/node/bin/node"
    BUNDLED_GIT="src-tauri/runtimes/git/bin/git"

    echo "Testing bundled Node.js..."
    "${BUNDLED_NODE}" --version
    echo "Testing bundled npm..."
    src-tauri/runtimes/node/bin/npm --version
    echo "Testing bundled npx..."
    src-tauri/runtimes/node/bin/npx --version
    echo "Testing bundled Git..."
    "${BUNDLED_GIT}" --version
    echo "Smoke test passed."
```

### `build-windows` job additions

Analogous steps using PowerShell (the existing `build-windows` job uses `shell: bash` for most steps):

**Download Node 22 LTS (Windows x64)**: fetches the `.zip` from `nodejs.org/dist/`, verifies SHA256 against `SHASUMS256.txt`, extracts to `src-tauri/runtimes/node/`.

**Download Git for Windows portable (Windows x64)**: fetches the `PortableGit-<version>-64-bit.7z.exe` self-extracting archive from `github.com/git-for-windows/git/releases`. Extracts using the archive's own extractor (`./PortableGit.exe -o src-tauri/runtimes/git -y`).

**Smoke test (Windows)**: strips PATH of Node and Git (PowerShell `$env:PATH` manipulation), then calls `.\src-tauri\runtimes\node\node.exe --version` and `.\src-tauri\runtimes\git\cmd\git.exe --version`.

### Global env var at workflow level

Add at the top of `desktop-release.yml`:

```yaml
env:
  NODE_BUNDLE_VERSION: "22.x"
  GIT_BUNDLE_VERSION: "2.49.0"   # Updated per release; the actual download uses latest stable patch
```

---

## Invariants and Safety Properties

**Invariant 1: Bundled first, always.**
When `SPECRAILS_IS_DESKTOP=1`, the bundled bin dirs are the first entries in `process.env.PATH` after `resolveStartupPath()`. No subsequent code path (login-shell merge, user config, Tauri PATH override) may prepend new dirs ahead of them. Enforced by: `augmentPathFromLoginShell()` returning immediately, and `mergeLoginShellPath()` appending — never prepending — to the existing PATH. The `mergeLoginShellPath` function uses `[...additions, ...current]` which would prepend additions; however since `augmentPathFromLoginShell` is a no-op in desktop mode, `mergeLoginShellPath` is never called.

**Invariant 2: Desktop mode does not affect the non-desktop server.**
The env var `SPECRAILS_IS_DESKTOP` is never set in the non-desktop server boot path (`npm run dev:server`, `npm start`). All gating is `process.env.SPECRAILS_IS_DESKTOP === '1'` — a falsy check on an unset variable preserves existing behavior.

**Invariant 3: Corrupted bundle → visible error, never silent OS fallback.**
If `probeVersion(bundledPath)` fails in desktop mode, the `SetupPrerequisite` row gets `executable: false, error: 'corrupted-bundle'`. The `missingRequired` array includes it. `formatMissingSetupPrerequisites()` emits the corrupted-bundle hint. `AddProjectDialog` disables its submit. No OS-level fallback is attempted.

**Invariant 4: Checksum verification before Tauri build.**
The CI steps download Node and Git before `npm run build:desktop`. The checksum step runs before the extract step. If either checksum fails, the CI job fails with a non-zero exit before any Tauri artifact is produced. There is no way for an unchecksummed binary to reach the bundle.

**Invariant 5: Smoke test uses a PATH with system Node/Git scrubbed.**
The smoke test step explicitly filters common system tool directories from PATH. If a bundled binary silently delegates to a system binary (e.g., a shell script wrapper that calls `node` by name without an absolute path), the smoke test will catch it.

---

## Risks and Mitigations

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Node 22 LTS `.tar.gz` structure changes between patch releases | Low | `--strip-components=1` normalization; smoke test catches bad extract |
| Git for Windows portable extracts to unexpected layout | Medium | Smoke test probes `git/cmd/git.exe` explicitly; CI fails fast |
| Tauri `resource_dir()` returns unexpected path on Windows (spaces, Unicode) | Low | Use `to_string_lossy()` and pass as env var; `probeVersion` already handles paths with spaces on Windows via quoting |
| Bundle resources inflate update delta size significantly | Accepted | 60–80 MB per platform accepted in spec; delta updater only sends changed files |
| macOS Gatekeeper strips execute bit from bundled node/git after notarization | Low | Both are inside the app bundle which is codesigned; Gatekeeper respects the signature |
| `npx specrails-core@latest` spawned with bundled npx may hit npm proxy issues | Out of scope | No npm registry mirroring in this change; network connectivity still required |

---

## Compatibility

### Non-Desktop Mode: Unchanged

Every non-desktop execution path (`npm run dev:server`, Docker, plain `node server/index.js`) is unaffected:
- `resolveStartupPath()` enters the existing branch (env var not set).
- `augmentPathFromLoginShell()` runs normally.
- `getSetupPrerequisitesStatus()` runs the existing `which` + `probeVersion` logic.
- No new required env vars; no API contract changes.

### API Contract

`GET /api/hub/setup-prerequisites` response now includes `bundled: true` and optionally `error: 'corrupted-bundle'` on tool entries in desktop mode. The `installed`, `executable`, `meetsMinimum` fields remain present and accurate. This is an additive extension — existing clients that ignore unknown fields are unaffected.

`GET /api/hub/setup-prerequisites?diagnostic=1` response now includes `'bundled'` as a possible `pathSources` entry value. Additive.

### CI Contract

Two new repository secrets are not required — the Node download from nodejs.org and Git from git-scm.com are public. No auth headers needed. The `GIT_BUNDLE_VERSION` env var can be updated via workflow file edit without a PR to server code.
