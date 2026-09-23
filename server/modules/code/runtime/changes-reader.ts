import fs from 'fs'
import path from 'path'

export type FunnelPhase = 'exploring' | 'designing' | 'ready' | 'building' | 'shipped'

export interface ChangeInfo {
  id: string
  name: string
  phase: FunnelPhase
  artifacts: {
    proposal: boolean
    design: boolean
    tasks: boolean
  }
  createdAt: string | null
  isArchived: boolean
  archivedAt: string | null
}

interface OpenSpecMeta {
  created?: string
  archived?: string
}

/** Parse simple flat key: value YAML (no nesting needed for .openspec.yaml) */
function readOpenSpecYaml(changeDir: string): OpenSpecMeta {
  const yamlPath = path.join(changeDir, '.openspec.yaml')
  if (!fs.existsSync(yamlPath)) return {}
  try {
    const text = fs.readFileSync(yamlPath, 'utf-8')
    const meta: OpenSpecMeta = {}
    for (const line of text.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/)
      if (!m) continue
      if (m[1] === 'created') meta.created = m[2].trim()
      if (m[1] === 'archived') meta.archived = m[2].trim()
    }
    return meta
  } catch {
    return {}
  }
}

function hasFile(dir: string, filename: string): boolean {
  return fs.existsSync(path.join(dir, filename))
}

function mtimeIso(dir: string): string | null {
  try {
    return fs.statSync(dir).mtime.toISOString()
  } catch {
    return null
  }
}

function classifyPhase(
  artifacts: ChangeInfo['artifacts'],
  isArchived: boolean,
  activeCommandNames: Set<string>,
  changeId: string
): FunnelPhase {
  if (isArchived) return 'shipped'
  if (artifacts.tasks && activeCommandNames.has(changeId)) return 'building'
  if (artifacts.tasks) return 'ready'
  if (artifacts.design) return 'designing'
  return 'exploring'
}

function slugToName(id: string): string {
  // Strip leading ticket prefix like "spea-123-" and convert to title case
  return id
    .replace(/^[a-z]+-\d+-/, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

function readChangesFromDir(
  changesDir: string,
  isArchived: boolean,
  activeCommandNames: Set<string>
): ChangeInfo[] {
  if (!fs.existsSync(changesDir)) return []

  let entries: string[]
  try {
    entries = fs.readdirSync(changesDir)
  } catch {
    return []
  }

  return entries
    .filter((entry) => {
      try {
        return fs.statSync(path.join(changesDir, entry)).isDirectory()
      } catch {
        return false
      }
    })
    .map((entry) => {
      const changeDir = path.join(changesDir, entry)
      const meta = readOpenSpecYaml(changeDir)
      const artifacts = {
        proposal: hasFile(changeDir, 'proposal.md'),
        design: hasFile(changeDir, 'design.md'),
        tasks: hasFile(changeDir, 'tasks.md'),
      }
      const archivedAt = isArchived
        ? (meta.archived as string | undefined) ?? mtimeIso(changeDir)
        : null

      const phase = classifyPhase(artifacts, isArchived, activeCommandNames, entry)

      return {
        id: entry,
        name: slugToName(entry),
        phase,
        artifacts,
        createdAt: (meta.created as string | undefined) ?? null,
        isArchived,
        archivedAt,
      }
    })
}

/**
 * Read all OpenSpec changes for a given project path.
 * @param projectPath - absolute path to the project root
 * @param activeJobCommands - list of currently active job commands (to detect "building" phase)
 */
export function readChanges(projectPath: string, activeJobCommands: string[] = []): ChangeInfo[] {
  const changesRoot = path.join(projectPath, 'openspec', 'changes')
  const archiveDir = path.join(changesRoot, 'archive')

  // Build a set of change IDs that appear in active job commands
  const activeCommandNames = new Set<string>(
    activeJobCommands.flatMap((cmd) => {
      // Match change IDs by looking for opsx:* commands referencing change names
      const match = cmd.match(/opsx:[a-z-]+\s+(\S+)/)
      return match ? [match[1]] : []
    })
  )

  const active = readChangesFromDir(changesRoot, false, activeCommandNames).filter(
    (c) => c.id !== 'archive'
  )
  const archived = readChangesFromDir(archiveDir, true, activeCommandNames)

  return [...active, ...archived]
}
