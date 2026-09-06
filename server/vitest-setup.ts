import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'

/**
 * Test safety net: NEVER let a test write the relocation registry into the
 * developer's real `$HOME/.specrails/registry.json`.
 *
 * `ProjectRegistry.loadAll()` runs `reconcileFromProjects`, and `addProject`
 * runs `mirrorProjectEntry`; both resolve the registry path from
 * `resolveHome()`, which falls back to `os.homedir()` when neither a `home`
 * arg nor `SPECRAILS_REGISTRY_HOME` is set. A test that constructs a
 * `ProjectRegistry` without pinning a tmp home would then pollute the real
 * registry. This setup file (run once per test file by vitest `setupFiles`)
 * points `SPECRAILS_REGISTRY_HOME` at a throwaway tmp dir unless the test has
 * already set its own, so the real home is unreachable from tests by
 * construction. Tests that need a specific home still override it per-test.
 */
if (!process.env.SPECRAILS_REGISTRY_HOME) {
  process.env.SPECRAILS_REGISTRY_HOME = mkdtempSync(path.join(os.tmpdir(), 'specrails-desktop-test-home-'))
}

/**
 * Hermetic env: a test run must NEVER inherit relocation / desktop-mode env
 * vars from the host process. When the suite runs INSIDE a Specrails rail spawn
 * (e.g. a `/specrails:implement` job running the verification step), that parent
 * process exports `SPECRAILS_REPO_DIR` etc., which leak straight through the
 * legacy (non-relocated) spawn path — the managers spread `process.env` into the
 * child env — and break the "LEGACY: no relocation env" assertions in
 * chat-manager / queue-manager tests. No test relies on ambient inheritance: the
 * relocated-branch tests activate relocation via the registry + populated
 * workspace gate, and the path-resolver / setup-prerequisites tests set their
 * own vars per-case in `beforeEach` (which run AFTER this file), so a
 * blanket-delete here is safe and any per-case setter still wins. Only
 * `SPECRAILS_REPO_DIR` breaks a test today; the rest are defense-in-depth (they
 * would leak identically the moment a future test asserts on them). Do NOT
 * delete `SPECRAILS_REGISTRY_HOME` — the block above sets it intentionally.
 */
for (const k of [
  'SPECRAILS_REPO_DIR',
  'SPECRAILS_IS_DESKTOP',
  'SPECRAILS_BUNDLED_RUNTIMES_PATH',
  'SPECRAILS_TICKETS_PATH',
  'SPECRAILS_BACKLOG_CONFIG_PATH',
  'SPECRAILS_WORKSPACE_DIR',
  'SPECRAILS_PROFILES_DIR',
  'SPECRAILS_STATE_DIR',
  'SPECRAILS_EXECUTION_CONTEXT',
  'SPECRAILS_PIPELINE_RUNTIME',
]) {
  delete process.env[k]
}
