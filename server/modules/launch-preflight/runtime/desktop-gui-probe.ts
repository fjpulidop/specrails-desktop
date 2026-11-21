/**
 * Does the project build a desktop GUI app, and do its launcher or tests honour
 * `SPECRAILS_HEADLESS`? Read-only and bounded: the root manifest, three marker
 * files and a capped walk of source files (no dependencies, build output or
 * dot folders) looking for the variable's name. Never writes to the repository.
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { DESKTOP_GUI_MARKER_FILES, desktopGuiFramework, type DesktopGuiFramework } from '../domain'

// Dependencies, build output and every dot folder (VCS, provider and Specrails files).
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'coverage', 'vendor'])
const SOURCE = /\.(?:[cm]?[jt]sx?|rs|go|json|toml)$/i
export const MAX_SCANNED_FILES = 2_000
const MAX_FILE_BYTES = 512 * 1024
const MARKER = 'SPECRAILS_HEADLESS'

async function readJson(file: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown> } catch { return null }
}

async function exists(file: string): Promise<boolean> {
  try { return (await fs.stat(file)).isFile() } catch { return false }
}

/** True when a scanned source file names `SPECRAILS_HEADLESS`. */
export async function honoursHeadless(root: string, limit = MAX_SCANNED_FILES): Promise<boolean> {
  const queue = [root]
  let scanned = 0
  while (queue.length > 0 && scanned < limit) {
    const dir = queue.shift()!
    let entries: import('node:fs').Dirent[]
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full); continue }
      if (!entry.isFile() || !SOURCE.test(entry.name) || scanned >= limit) continue
      scanned++
      try {
        if ((await fs.stat(full)).size > MAX_FILE_BYTES) continue
        if ((await fs.readFile(full, 'utf8')).includes(MARKER)) return true
      } catch { /* unreadable: skip */ }
    }
  }
  return false
}

/** The project's desktop GUI toolkit and whether it honours the headless contract, or null. */
export async function probeDesktopGui(root: string): Promise<{ framework: DesktopGuiFramework; honoured: boolean } | null> {
  const manifest = await readJson(path.join(root, 'package.json'))
  const dependencies = ['dependencies', 'devDependencies', 'optionalDependencies'].flatMap((key) => {
    const value = manifest?.[key]
    return value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : []
  })
  const files: string[] = []
  for (const marker of DESKTOP_GUI_MARKER_FILES) if (await exists(path.join(root, marker))) files.push(marker)
  const framework = desktopGuiFramework({ dependencies, files })
  if (!framework) return null
  return { framework, honoured: await honoursHeadless(root) }
}
