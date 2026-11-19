/**
 * The run browser tool on disk: the bundled script and its launcher under
 * `<specrails home>/.specrails/browser-tool/`, exported to every run process as
 * `$SPECRAILS_BROWSE` (see `withRunPortEnv`). Agents call it to look at the UI
 * they build (screenshots, console errors, page text) instead of giving up on a
 * visual check. Effectful and best-effort: a failure leaves runs without the
 * variable, never breaks startup.
 */
import fs from 'fs'
import path from 'path'
import { resolveBundledNodeExe } from '../../../path-resolver'
import { resolveSpecrailsHome } from '../../../util/specrails-home'
import { BROWSE_TOOL_SOURCE, BROWSE_TOOL_VERSION } from '../tool/browse-tool-bundle.generated'

export const BROWSE_TOOL_NAME = 'specrails-browse'

export function browseToolDir(specrailsHome: string = resolveSpecrailsHome()): string {
  return path.join(specrailsHome, '.specrails', 'browser-tool')
}

/** Playwright's Chromium for the tool when the app ships none: Specrails-owned, never the global cache. */
export function browseBrowsersDir(specrailsHome: string = resolveSpecrailsHome()): string {
  return path.join(specrailsHome, '.specrails', 'browsers')
}

/** The real directory of the Playwright package the app's own browser uses (never inside the pkg snapshot). */
export function resolvePlaywrightDir(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string | null {
  const candidates: string[] = []
  if (env.SPECRAILS_PLAYWRIGHT_DIR) candidates.push(env.SPECRAILS_PLAYWRIGHT_DIR)
  try { candidates.push(path.dirname(require.resolve('playwright/package.json'))) } catch { /* packaged: probe the copied package */ }
  const execDir = path.dirname(execPath)
  candidates.push(path.join(execDir, 'node_modules', 'playwright'), path.resolve(execDir, '..', 'Resources', 'binaries', 'node_modules', 'playwright'))
  for (const candidate of candidates) {
    if (candidate.startsWith('/snapshot') || candidate.startsWith('C:\\snapshot')) continue
    try { if (fs.statSync(path.join(candidate, 'package.json')).isFile()) return candidate } catch { /* next */ }
  }
  return null
}

const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export interface BrowseLauncherInput {
  node: string
  script: string
  playwrightDir: string
  browsersDir: string
  chromium: string | null
}

/** The launcher text: the tool's own environment is set here, never exported to the run. */
export function renderBrowseLauncher(input: BrowseLauncherInput, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return ['@echo off', 'rem Specrails run browser tool launcher (generated; do not edit).',
      `set "SPECRAILS_BROWSE_PLAYWRIGHT=${input.playwrightDir}"`, `set "SPECRAILS_BROWSE_CHROMIUM=${input.chromium ?? ''}"`, `set "PLAYWRIGHT_BROWSERS_PATH=${input.browsersDir}"`,
      `"${input.node}" "${input.script}" %*`, ''].join('\r\n')
  }
  return ['#!/bin/sh', '# Specrails run browser tool launcher (generated; do not edit).',
    `SPECRAILS_BROWSE_PLAYWRIGHT=${shQuote(input.playwrightDir)} SPECRAILS_BROWSE_CHROMIUM=${shQuote(input.chromium ?? '')} PLAYWRIGHT_BROWSERS_PATH=${shQuote(input.browsersDir)} \\`,
    `  exec ${shQuote(input.node)} ${shQuote(input.script)} "$@"`, ''].join('\n')
}

function writeIfChanged(file: string, body: string, mode: number): void {
  let current: string | null = null
  try { current = fs.readFileSync(file, 'utf8') } catch { /* absent */ }
  if (current === body) { try { fs.chmodSync(file, mode) } catch { /* best-effort */ } return }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, body, { mode })
  fs.renameSync(tmp, file)
}

let installedLauncher: string | null = null

export interface EnsureBrowseToolOptions {
  specrailsHome?: string
  /** The app's bundled Chromium, when it ships one. */
  chromium?: string | null
  playwrightDir?: string | null
  /** Where Playwright's Chromium lives for the tool (default: the Specrails cache). */
  browsersDir?: string
  node?: string
  platform?: NodeJS.Platform
}

/** Write the script and launcher when missing or stale. Returns the launcher path, or null when unavailable. */
export function ensureBrowseTool(options: EnsureBrowseToolOptions = {}): string | null {
  try {
    const home = options.specrailsHome ?? resolveSpecrailsHome()
    const playwrightDir = options.playwrightDir === undefined ? resolvePlaywrightDir() : options.playwrightDir
    if (!playwrightDir) {
      console.warn('[browser-tool] Playwright is not available; runs get no $SPECRAILS_BROWSE')
      installedLauncher = null
      return null
    }
    const platform = options.platform ?? process.platform
    const dir = browseToolDir(home)
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const script = path.join(dir, `${BROWSE_TOOL_NAME}-${BROWSE_TOOL_VERSION}.cjs`)
    writeIfChanged(script, BROWSE_TOOL_SOURCE, 0o600)
    const launcher = path.join(dir, platform === 'win32' ? `${BROWSE_TOOL_NAME}.cmd` : BROWSE_TOOL_NAME)
    // The packaged server is not a Node binary: the bundled Node runs the script there.
    const node = options.node ?? resolveBundledNodeExe() ?? (path.basename(process.execPath).toLowerCase().startsWith('node') ? process.execPath : 'node')
    writeIfChanged(launcher, renderBrowseLauncher({ node, script, playwrightDir, browsersDir: options.browsersDir ?? browseBrowsersDir(home), chromium: options.chromium ?? null }, platform), 0o700)
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(`${BROWSE_TOOL_NAME}-`) && name.endsWith('.cjs') && path.join(dir, name) !== script) {
        try { fs.unlinkSync(path.join(dir, name)) } catch { /* in use: removed next start */ }
      }
    }
    installedLauncher = launcher
    return launcher
  } catch (error) {
    console.warn(`[browser-tool] could not install the run browser tool: ${(error as Error).message}`)
    installedLauncher = null
    return null
  }
}

/** Env a run process receives: the launcher, when installed. Empty otherwise. */
/** Where a run's browser captures land: inside its checkout, never committed (see PR_NEVER_STAGE_PATHS). */
export const BROWSE_EVIDENCE_DIR = '.specrails/browser-evidence'

export function runBrowseToolEnv(worktreePath?: string | null): Record<string, string> {
  if (!installedLauncher) return {}
  return { SPECRAILS_BROWSE: installedLauncher, ...(worktreePath ? { SPECRAILS_BROWSE_EVIDENCE: path.join(worktreePath, BROWSE_EVIDENCE_DIR) } : {}) }
}

/** Test seam: forget the installed launcher. */
export function resetBrowseToolForTests(launcher: string | null = null): void {
  installedLauncher = launcher
}
