# Context Bundle: bundle-runtimes-desktop

Everything a developer needs to implement this change without reading anything else first.

---

## Quick Reference

| Env var | Set by | Value in desktop | Value outside desktop |
|---------|--------|------------------|-----------------------|
| `SPECRAILS_IS_DESKTOP` | `src-tauri/src/lib.rs` | `'1'` | unset |
| `SPECRAILS_BUNDLED_RUNTIMES_PATH` | `src-tauri/src/lib.rs` | abs path to `runtimes/` inside app bundle | unset |
| `NODE_BUNDLE_VERSION` | workflow `env:` block | e.g. `'22.x'` | N/A (CI only) |
| `GIT_BUNDLE_VERSION` | workflow `env:` block | e.g. `'2.49.0'` | N/A (CI only) |

---

## File: `server/path-resolver.ts` — Current State

Full file content is at `/Users/javi/repos/specrails-hub/server/path-resolver.ts`.

**Key exported symbols**:
- `PathSource` (type): `'inherited' | 'fast-path' | 'login-shell'` — **needs `'bundled'` added**
- `LoginShellStatus` (type): `'ok' | 'skipped' | 'timeout' | 'error'`
- `resolveStartupPath(): void` — **needs desktop-mode branch at the top**
- `parseLoginShellOutput(stdout: string): string | null` — no changes needed
- `augmentPathFromLoginShell(opts?): Promise<void>` — **needs desktop-mode no-op guard**
- `getPathDiagnostic(): PathDiagnostic` — no changes needed
- `__resetPathResolverForTest(): void` — no changes needed

**New export to add**:
- `resolveBundledRuntimePath(): string` — returns `SPECRAILS_BUNDLED_RUNTIMES_PATH`, throws if unset

**Critical internal state** (module-level variables):
```typescript
let diagnostic: PathDiagnostic = {
  pathSegments: [],
  pathSources: [],
  loginShellStatus: 'skipped',
}
let warnedLoginShell = false
```

`diagnostic` must be updated correctly in the desktop branch of `resolveStartupPath()`. The `'bundled'` PathSource literal must be added to the `PathSource` type before referencing it in the diagnostic update.

**Private helpers used by `resolveStartupPath()`**:
```typescript
function splitPath(value: string | undefined): string[]   // splits by ':' or ';'
function joinPath(segments: string[]): string              // joins by ':' or ';'
function getDelimiter(): string                            // ':' on POSIX, ';' on Windows
function fastPathDirectories(): string[]                   // homebrew dirs etc.
```

All of these are available for use in the new desktop branch since they are in the same module.

---

## File: `server/setup-prerequisites.ts` — Current State

**Missing import**: `path` is NOT currently imported. You must add:
```typescript
import path from 'path'
```

**Existing imports at top of file**:
```typescript
import { spawnSync } from 'child_process'
import { listAdapters } from './providers'
```

**Key exported symbols**:
- `SetupPrerequisite` (interface): **needs two new optional fields**
- `SetupPrerequisitesStatus` (interface): no changes needed
- `MIN_VERSIONS`: `{ node: '18.0.0', npm: '9.0.0', git: '2.20.0', uv: '0.1.0' }` — no changes
- `getSetupPrerequisitesStatus(options?): SetupPrerequisitesStatus` — **needs desktop branch in the map loop**
- `parseSemver`, `compareVersions`: no changes
- `formatMissingSetupPrerequisites(status?)`: no changes needed (installHint is already overridden per entry)

**Internal helpers to be aware of**:
```typescript
function locateCommand(command: string): CommandLookup   // uses which/where
function probeVersion(command: string, resolvedPath?: string): VersionProbe  // runs --version
function meetsMinimumVersion(version: string | undefined, minVersion: string | undefined): boolean
function brokenSymlinkHint(...): string   // not needed in desktop mode
```

**The `probeVersion` function signature**:
```typescript
interface VersionProbe {
  executed: boolean
  version?: string
  error?: string
}

function probeVersion(command: string, resolvedPath?: string): VersionProbe
```

In desktop mode, call `probeVersion(definition.key, bundledPath)` where `bundledPath` is the absolute path to the bundled binary. This bypasses the `which` step entirely and goes straight to `spawnSync(target, ['--version'])`.

**The definitions array** (inside `getSetupPrerequisitesStatus`):

Tool definitions for node, npm, npx, git are the first four entries (indices 0–3). Provider CLIs are added in the `listAdapters()` loop after them. `uv` is added if `options.includeUv` is true. The desktop-mode branch must only activate for `kind === 'tool'` entries with keys in `{ 'node', 'npm', 'npx', 'git' }` — NOT for provider CLIs and NOT for `uv` (uv is never bundled).

---

## File: `src-tauri/src/lib.rs` — Current State

Full file is at `/Users/javi/repos/specrails-hub/src-tauri/src/lib.rs`.

**Sidecar spawn location** (in the `setup` closure, around line 117):

```rust
let sidecar = app_handle
    .shell()
    .sidecar("specrails-server")
    .expect("specrails-server sidecar not configured")
    .args([&parent_pid_arg]);
```

The variable `sidecar` is then modified by the `#[cfg(target_os = "macos")]` block which chains `.env("PATH", &shell_path)` to resolve Claude CLI.

**How to inject env vars**: chain `.env(key, value)` calls on the `sidecar` builder before `spawn()`. The Tauri v2 `CommandBuilder` type implements a builder pattern where each `.env()` call returns `Self`.

**How to get the resource directory** (Tauri v2 API already used in this file via `app_handle`):

```rust
use tauri::Manager;  // already imported at top

let runtimes_path = app_handle
    .path()
    .resource_dir()
    .ok()
    .map(|p| p.join("runtimes").to_string_lossy().into_owned())
    .unwrap_or_default();
```

`app_handle.path()` returns the `PathResolver`. `.resource_dir()` returns `Result<PathBuf, tauri::Error>`. The `.ok().map(...).unwrap_or_default()` converts failures to an empty string — acceptable because the server's `resolveStartupPath()` checks for an empty string and skips the prepend harmlessly.

**Variable scoping issue**: the sidecar variable `let sidecar = ...` is re-bound by the macOS `#[cfg]` block. The env injections must come before the macOS block re-shadows it, OR be chained INSIDE the macOS block's `let sidecar = { ... }` expression. The simplest approach: set `.env("SPECRAILS_IS_DESKTOP", "1").env("SPECRAILS_BUNDLED_RUNTIMES_PATH", &runtimes_path)` on the initial `let sidecar = app_handle.shell().sidecar(...)...` line. Then the macOS block can further chain `.env("PATH", ...)` on the result.

**Insertion point** (between lines 121 and 131 approximately):

```rust
// Current:
let sidecar = app_handle
    .shell()
    .sidecar("specrails-server")
    .expect("specrails-server sidecar not configured")
    .args([&parent_pid_arg]);

// After change:
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

---

## File: `src-tauri/tauri.conf.json` — Current State

```json
"bundle": {
  "active": true,
  "createUpdaterArtifacts": "v1Compatible",
  "targets": "all",
  "icon": [ ... ],
  "externalBin": ["binaries/specrails-server"],
  "resources": [
    "binaries/better_sqlite3.node",
    "binaries/pty.node",
    "binaries/node-pty/**/*"
  ],
  "macOS": {
    "entitlements": "./entitlements.plist"
  }
}
```

**Change**: add `"runtimes/**/*"` to the `resources` array. The glob is relative to the `src-tauri/` directory (Tauri's project root for resource resolution).

```json
"resources": [
  "binaries/better_sqlite3.node",
  "binaries/pty.node",
  "binaries/node-pty/**/*",
  "runtimes/**/*"
]
```

**Tauri v2 resource path resolution at runtime**: `app_handle.path().resource_dir()` returns the OS-specific resources directory:
- macOS: `<app>.app/Contents/Resources/`
- Windows: `<install-dir>/resources/`

Tauri copies `src-tauri/runtimes/**/*` into `<resources-dir>/runtimes/**/*` preserving the relative tree. So `src-tauri/runtimes/node/bin/node` becomes `Contents/Resources/runtimes/node/bin/node` on macOS and `resources/runtimes/node/bin/node` on Windows. The server-side `getBundledToolPath()` must build paths accordingly.

---

## File: `.github/workflows/desktop-release.yml` — Current State

Full file is at `/Users/javi/repos/specrails-hub/.github/workflows/desktop-release.yml`.

**Build jobs**: `build-macos` (line 12), `build-windows` (line 74), `build-windows-arm64` (line 122), `deploy` (line 164).

**`build-macos` step order** (current):
1. `actions/checkout`
2. `actions/setup-node` (node 20)
3. Install Rust stable
4. Rust cache
5. Install dependencies (`npm ci && cd client && npm ci`)
6. Import codesign certificate
7. Install Apple API key
8. Build desktop app (`npm run build:desktop`)
9. Upload `.dmg` artifact

**Insertion point for Tasks 9 and 11**: runtime download steps go AFTER "Install dependencies" (step 5) and BEFORE "Import codesign certificate" (step 6). Smoke test goes AFTER "Build desktop app" (step 8) and BEFORE "Upload `.dmg` artifact" (step 9).

**`build-windows` step order** (current):
1. `actions/checkout`
2. `actions/setup-node` (node 20)
3. Install Rust stable
4. Rust cache
5. Install dependencies (`npm ci && cd client && npm ci`)
6. Build desktop app (`npm run build:desktop`)
7. Upload Windows installer artifacts

**Insertion point for Tasks 10 and 11**: runtime download steps go AFTER step 5, BEFORE step 6. Smoke test goes AFTER step 6, BEFORE step 7.

**Workflow-level `env:` block**: currently there is no top-level `env:` block. Add it after `permissions:` and before `jobs:`:

```yaml
permissions:
  contents: write

env:
  NODE_BUNDLE_VERSION: "22.x"
  GIT_BUNDLE_VERSION: "2.49.0"

jobs:
```

**Note**: `build-windows-arm64` is explicitly OUT OF SCOPE for this change. Do not add runtime bundling steps there. The spec scopes bundling to macOS arm64 and Windows x64 only.

---

## Test Files to Modify

**`server/path-resolver.test.ts`** — current tests use `__resetPathResolverForTest()` in `beforeEach`. Pattern to follow for new desktop-mode tests:

```typescript
describe('desktop mode', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    __resetPathResolverForTest()
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = '/tmp/fake-runtimes'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    __resetPathResolverForTest()
  })

  it('prepends bundled dirs to PATH', () => {
    const before = process.env.PATH ?? ''
    resolveStartupPath()
    const after = process.env.PATH ?? ''
    expect(after.startsWith('/tmp/fake-runtimes/node/bin:')).toBe(true)
    expect(after).toContain('/tmp/fake-runtimes/git/bin')
    expect(after).toContain(before.split(':')[0])  // existing PATH preserved after
  })
})
```

**`server/setup-prerequisites.test.ts`** — the test file uses `vi.mock('child_process')` or direct `spawnSync` mocking via `vi.spyOn`. Pattern:

```typescript
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'

vi.mock('child_process', () => ({
  spawnSync: vi.fn(),
}))

const mockSpawnSync = vi.mocked(spawnSync)

describe('getSetupPrerequisitesStatus — desktop mode', () => {
  beforeEach(() => {
    process.env.SPECRAILS_IS_DESKTOP = '1'
    process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH = '/fake/runtimes'
    // Simulate successful --version probe
    mockSpawnSync.mockImplementation((cmd: string, args: string[]) => {
      if (args.includes('--version')) {
        return { status: 0, stdout: 'v22.12.0\n', stderr: '', error: undefined }
      }
      return { status: 1, stdout: '', stderr: '', error: undefined }
    })
  })
  afterEach(() => {
    delete process.env.SPECRAILS_IS_DESKTOP
    delete process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    vi.clearAllMocks()
  })
})
```

---

## Client Component: `PrerequisitesPanel`

**Location**: `client/src/features/projects/components/PrerequisitesPanel.tsx` (exact path — confirm it exists at this path before editing).

**The `usePrerequisites()` hook** returns `SetupPrerequisitesStatus` as fetched from `GET /api/hub/setup-prerequisites`. The client-side type for `SetupPrerequisite` should already be defined somewhere in the client (likely in a types file or inline in the hook). Add the two new optional fields to the client-side type:

```typescript
interface SetupPrerequisite {
  // ... existing fields ...
  bundled?: boolean
  error?: 'corrupted-bundle'
}
```

**Render change in `PrerequisitesPanel`**: wherever the "More info" link or `onClick={() => openInstallModal(item)}` appears in the JSX for a tool row, wrap it in a conditional:

```tsx
{item.error !== 'corrupted-bundle' && (
  <button onClick={() => openInstallModal(item)}>More info</button>
)}
{item.error === 'corrupted-bundle' && (
  <span className="text-destructive text-sm">
    Bundle corrupted — reinstall the SpecRails Hub app.
  </span>
)}
```

---

## Invariants to Enforce During Implementation

1. **Never check `SPECRAILS_IS_DESKTOP` with loose equality.** Always use `=== '1'` (strict string comparison). The env var is always a string.

2. **`resolveBundledRuntimePath()` must throw, not return empty string.** Callers that ignore the throw would silently try to probe non-existent paths. The throw makes the misconfiguration visible.

3. **Desktop mode does NOT affect non-tool prerequisites.** The `kind === 'provider'` entries (claude, codex) remain probed via `which` in desktop mode. This is correct — provider CLIs are user-installed, not bundled.

4. **Do not remove `formatMissingSetupPrerequisites()` guard.** That function is the last server-side defence in `SetupManager.startInstall()`. It uses `installHint` which is already correctly set to the corrupted-bundle message in desktop mode. No changes needed.

5. **Tauri `.env()` chains are additive.** Calling `.env("SPECRAILS_IS_DESKTOP", "1")` on the sidecar command does not replace the entire sidecar environment — it adds/overrides a single var. All existing env vars (including the macOS login-shell `PATH` set by the `#[cfg]` block) are preserved.

6. **Smoke test PATH scrub must be aggressive.** If the runner's system `node` is on `/usr/local/bin` (common on macOS GitHub Actions runners), a conservative scrub that only removes `nvm`-style paths will leave the system binary on PATH and the smoke test will pass falsely. The grep patterns must cover common locations. When in doubt, prefer scrubbing too broadly (tools like `curl`, `python`, `jq` are always in `/usr/bin` and `/bin` which should not be scrubbed).

7. **Windows `.cmd` wrapper scripts must be probed with `shell: true`.** The `probeVersion` function in `setup-prerequisites.ts` already has this: `shell: isWin` in the `spawnSync` call. This is correct for `npm.cmd` and `npx.cmd`.

---

## Coverage Threshold Reminder

CI enforces: 80% server lines/functions/statements, 70% server branches. The new desktop-mode branches in `path-resolver.ts` and `setup-prerequisites.ts` must be covered by tests or the CI gate will fail. Specifically:
- The `if (process.env.SPECRAILS_IS_DESKTOP === '1')` branch in both `resolveStartupPath()` and `augmentPathFromLoginShell()`.
- The `if (!probe.executed)` (corrupted-bundle) and the success path inside the desktop branch of `getSetupPrerequisitesStatus()`.
- The `if (!p)` throw path in `resolveBundledRuntimePath()`.

Run locally before pushing:
```bash
npm run typecheck
npm test
npm run test:coverage
```
