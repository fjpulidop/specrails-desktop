import fs from 'fs'
import path from 'path'

import { stripWindowsVerbatimPrefix } from './util/win-spawn'

/**
 * Bundled specrails-core resolution.
 *
 * The Tauri host (src-tauri/src/lib.rs) sets `SPECRAILS_BUNDLED_CORE_PATH` to
 * `<resource_dir>/core` — but ONLY when the compiled CLI actually exists on disk
 * (existence-gated, mirroring `SPECRAILS_BUNDLED_RUNTIMES_PATH`). When the env is
 * absent (a build that shipped no core, a partial extraction, or any non-desktop
 * mode like `npm run dev:server`) these helpers return null and EVERY caller
 * falls back to the legacy `npx specrails-core` path — byte-identical to today.
 *
 * This is the single chokepoint: do NOT read `SPECRAILS_BUNDLED_CORE_PATH`
 * anywhere else; resolve through `getBundledCoreCli()` / `getBundledCoreRoot()`.
 */

/** The bundled core package root (`<resource_dir>/core`) or null when absent. */
export function getBundledCoreRoot(): string | null {
  // Strip any `\\?\` verbatim prefix (Tauri resource_dir) — Node's module loader
  // realpathSync chokes on it when running cli.js (EISDIR lstat 'C:').
  const p = stripWindowsVerbatimPrefix(process.env.SPECRAILS_BUNDLED_CORE_PATH ?? '')
  if (!p || p.length === 0) return null
  // Existence-gate (defence-in-depth — lib.rs already gates, but a stale env
  // from a partial uninstall must never make us shell out to a missing file).
  if (!fs.existsSync(p)) return null
  return p
}

/**
 * Absolute path to the bundled core CLI entry
 * (`<core>/dist/installer/cli.js`), or null when no bundled core is present (→
 * caller falls back to `npx specrails-core`).
 */
export function getBundledCoreCli(): string | null {
  const root = getBundledCoreRoot()
  if (!root) return null
  const cli = path.join(root, 'dist', 'installer', 'cli.js')
  if (!fs.existsSync(cli)) return null
  return cli
}

/**
 * The version of the bundled core (from `<core>/package.json`), or null when no
 * bundled core / unreadable. FrameworkManager.versionCheck compares this against
 * the materialized `framework/current` to decide whether to re-materialize.
 */
export function getBundledCoreVersion(): string | null {
  const root = getBundledCoreRoot()
  if (!root) return null
  const pkgPath = path.join(root, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
    const v = pkg.version?.trim()
    return v && v.length > 0 ? v : null
  } catch {
    return null
  }
}

/** True when a usable bundled core (env + CLI on disk) is present. */
export function hasBundledCore(): boolean {
  return getBundledCoreCli() !== null
}
