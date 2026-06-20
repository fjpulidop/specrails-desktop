import fs from 'fs'
import path from 'path'

import { stripWindowsVerbatimPrefix } from './util/win-spawn'

/**
 * Bundled `@fission-ai/openspec` resolution.
 *
 * The Tauri host (src-tauri/src/lib.rs) sets `SPECRAILS_BUNDLED_OPENSPEC_PATH` to
 * `<resource_dir>/openspec` — but ONLY when the openspec CLI entry actually
 * exists on disk (existence-gated, mirroring `SPECRAILS_BUNDLED_CORE_PATH`).
 * When the env is absent (a build that shipped no openspec, a partial
 * extraction, or any non-desktop mode like `npm run dev:server`) these helpers
 * return null and the bundled-core init falls back to the legacy
 * `npx @fission-ai/openspec` path — byte-identical to today.
 *
 * openspec is bundled as a `npm install`ed tree (it has runtime deps), so the
 * CLI lives at:
 *   <openspec>/node_modules/@fission-ai/openspec/bin/openspec.js
 *
 * This is the single chokepoint: do NOT read `SPECRAILS_BUNDLED_OPENSPEC_PATH`
 * anywhere else; resolve through `getBundledOpenspecCli()`.
 */

/** Relative path (from the bundle root) to the openspec CLI node entry. */
const OPENSPEC_CLI_REL = path.join(
  'node_modules',
  '@fission-ai',
  'openspec',
  'bin',
  'openspec.js',
)

/** The bundled openspec root (`<resource_dir>/openspec`) or null when absent. */
function getBundledOpenspecRoot(): string | null {
  // Strip any `\\?\` verbatim prefix (Tauri resource_dir) so `node openspec.js`
  // resolves its entry without the realpathSync EISDIR-on-'C:' crash.
  const p = stripWindowsVerbatimPrefix(process.env.SPECRAILS_BUNDLED_OPENSPEC_PATH ?? '')
  if (!p || p.length === 0) return null
  // Existence-gate (defence-in-depth — lib.rs already gates, but a stale env
  // from a partial uninstall must never make us point at a missing file).
  if (!fs.existsSync(p)) return null
  return p
}

/**
 * Absolute path to the bundled openspec CLI node entry
 * (`<openspec>/node_modules/@fission-ai/openspec/bin/openspec.js`), or null when
 * no bundled openspec is present (→ bundled-core init falls back to npx openspec).
 */
export function getBundledOpenspecCli(): string | null {
  const root = getBundledOpenspecRoot()
  if (!root) return null
  const cli = path.join(root, OPENSPEC_CLI_REL)
  if (!fs.existsSync(cli)) return null
  return cli
}

/** True when a usable bundled openspec (env + CLI on disk) is present. */
export function hasBundledOpenspec(): boolean {
  return getBundledOpenspecCli() !== null
}
