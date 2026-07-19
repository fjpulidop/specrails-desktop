import fs from 'fs'
import path from 'path'
import { atomicWriteFileSync, withFileLock } from './json-mutation'

/**
 * Plugins contribute named sections to the project's provider-native
 * instructions path (`CLAUDE.md` for Claude, `AGENTS.md` for Codex,
 * `.kimi-code/AGENTS.md` for Kimi, and the adapter-declared path for future
 * providers) so the agent's global
 * context includes per-plugin usage hints (e.g. "prefer Serena tools over
 * raw Read/Grep when locating symbols"). Each plugin owns one named block
 * delimited by HTML-comment markers; multiple plugins coexist without
 * stomping each other.
 *
 *   <!-- specrails-desktop-managed:<plugin>:start -->
 *   ...content...
 *   <!-- specrails-desktop-managed:<plugin>:end -->
 *
 * Operations are surgical, atomic (temp+rename), and serialized via the
 * shared in-process file mutex.
 *
 * The `filename` parameter on every function defaults to `'CLAUDE.md'` so
 * existing callsites compile unchanged during the multi-provider migration.
 * Callers that know the resolved provider pass `adapter.instructionsFilename`
 * explicitly.
 */

function startMarker(pluginName: string): string {
  return `<!-- specrails-desktop-managed:${pluginName}:start -->`
}
function endMarker(pluginName: string): string {
  return `<!-- specrails-desktop-managed:${pluginName}:end -->`
}

// Legacy marker compat — blocks written by pre-rebrand "Specrails Hub"
// installs used the `specrails-hub-managed` namespace. We still locate (and
// therefore replace/remove) those blocks so existing user files never end up
// with orphaned managed sections. New writes always use the new markers.
function legacyStartMarker(pluginName: string): string {
  return `<!-- specrails-hub-managed:${pluginName}:start -->`
}
function legacyEndMarker(pluginName: string): string {
  return `<!-- specrails-hub-managed:${pluginName}:end -->`
}

function instructionsMdPath(projectPath: string, filename: string): string {
  return path.join(projectPath, filename)
}

/** Backwards-compat alias for callers that haven't been threaded the
 *  adapter-driven filename yet. */
function claudeMdPath(projectPath: string): string {
  return instructionsMdPath(projectPath, 'CLAUDE.md')
}

interface BlockMatch {
  start: number
  end: number
  /** Content between markers, trimmed of surrounding blank lines. */
  content: string
}

function locateBlockWithMarkers(text: string, start: string, end: string): BlockMatch | null {
  const sIdx = text.indexOf(start)
  if (sIdx < 0) return null
  const eIdx = text.indexOf(end, sIdx + start.length)
  if (eIdx < 0) return null
  const innerStart = sIdx + start.length
  const innerEnd = eIdx
  return {
    start: sIdx,
    end: eIdx + end.length,
    content: text.slice(innerStart, innerEnd).replace(/^\n+|\n+$/g, ''),
  }
}

function locateBlock(text: string, pluginName: string): BlockMatch | null {
  return (
    locateBlockWithMarkers(text, startMarker(pluginName), endMarker(pluginName)) ??
    // Fall back to the legacy pre-rebrand markers (see legacyStartMarker).
    locateBlockWithMarkers(text, legacyStartMarker(pluginName), legacyEndMarker(pluginName))
  )
}

/** Returns the current managed-block content for `pluginName`, or null if absent. */
export function getBlockContent(projectPath: string, pluginName: string, filename: string = 'CLAUDE.md'): string | null {
  const file = instructionsMdPath(projectPath, filename)
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  const match = locateBlock(text, pluginName)
  return match ? match.content : null
}

/**
 * Insert or replace the managed block for `pluginName`. If the instructions
 * file does not exist, it is created with just the block. If it exists
 * without our block, the block is appended at the end (separated by a blank
 * line). The filename defaults to `CLAUDE.md` for backwards compatibility;
 * other providers pass their adapter-declared relative path.
 */
export async function upsertBlock(
  projectPath: string,
  pluginName: string,
  content: string,
  filename: string = 'CLAUDE.md',
): Promise<void> {
  const file = instructionsMdPath(projectPath, filename)
  const block = `${startMarker(pluginName)}\n${content.trim()}\n${endMarker(pluginName)}`
  await withFileLock(file, async () => {
    let next: string
    if (!fs.existsSync(file)) {
      next = block + '\n'
    } else {
      const cur = fs.readFileSync(file, 'utf8')
      const match = locateBlock(cur, pluginName)
      if (match) {
        next = cur.slice(0, match.start) + block + cur.slice(match.end)
      } else {
        const sep = cur.endsWith('\n\n') ? '' : cur.endsWith('\n') ? '\n' : '\n\n'
        next = cur + sep + block + '\n'
      }
    }
    atomicWriteFileSync(file, next)
  })
}

/**
 * Remove the managed block for `pluginName`. No-op when the instructions
 * file is missing or the block is absent. Surrounding user content is
 * preserved byte-identical.
 *
 * If removing the block leaves the file empty (the managed block was the
 * only content), the file is deleted — this restores the pre-install state
 * for projects that didn't have an instructions file before any plugin
 * install. The filename defaults to `CLAUDE.md`.
 */
export async function removeBlock(
  projectPath: string,
  pluginName: string,
  filename: string = 'CLAUDE.md',
): Promise<void> {
  const file = instructionsMdPath(projectPath, filename)
  if (!fs.existsSync(file)) return
  await withFileLock(file, async () => {
    const cur = fs.readFileSync(file, 'utf8')
    const match = locateBlock(cur, pluginName)
    if (!match) return
    // Strip the block plus a single trailing newline if present, so we don't
    // leave a stray blank line behind.
    let next = cur.slice(0, match.start) + cur.slice(match.end)
    next = next.replace(/\n{3,}$/, '\n').replace(/^\n+/, '')
    if (next.trim() === '') {
      fs.unlinkSync(file)
      return
    }
    atomicWriteFileSync(file, next)
  })
}

// Suppress unused-warning for the legacy alias — kept for API ergonomics.
void claudeMdPath
