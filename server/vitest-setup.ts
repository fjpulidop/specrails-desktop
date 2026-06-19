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
