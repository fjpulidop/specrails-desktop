import {
  getBackgroundProcessLogs,
  listBackgroundProcesses,
  type BackgroundProcess,
  type BackgroundProcessLogSnapshot,
} from '../../../transient-children'
import { previewOrigin, previewTargetsFromLines, withoutReservedPorts } from '../domain/preview-origins'

/** Background-process statuses whose announced URLs are still served. */
const LIVE_STATUSES = new Set<BackgroundProcess['status']>(['starting', 'running'])
/** Dev servers announce their URL in the first lines; a long-running process
 *  can still re-announce after a restart, so scan the full retained tail. */
const SCAN_LIMIT = 2000

export interface PreviewTarget {
  processId: string
  chatId: string
  urls: string[]
}

export interface PreviewTargetSource {
  /** Running mission processes of the project with at least one announced URL. */
  list(projectId: string): PreviewTarget[]
  /** Announced URLs of one running process (empty when it is not running). */
  forProcess(projectId: string, processId: string): PreviewTarget | null
  /** Comparable origins (`previewOrigin`) announced by running processes. */
  announcedOrigins(projectId: string): Set<string>
}

interface ProcessReader {
  list(projectId: string): BackgroundProcess[]
  logs(process: BackgroundProcess): BackgroundProcessLogSnapshot | null
}

const defaultReader: ProcessReader = {
  list: (projectId) => listBackgroundProcesses({ projectId }),
  logs: (process) => getBackgroundProcessLogs(process.pid, { projectId: process.projectId, processId: process.processId, limit: SCAN_LIMIT }),
}

/**
 * Derives preview targets from mission background-process logs on demand.
 * Targets are derived state: nothing is persisted, an exited process simply
 * stops contributing, and a process recovered after a restart (`interrupted`,
 * OS state unknown) never does. A per-process memo keyed on the log tail keeps
 * the per-request navigation guard cheap. URLs on `reservedPorts` (Specrails'
 * own listeners) are never targets, whatever a process prints.
 */
export function createPreviewTargetSource(
  reader: ProcessReader = defaultReader,
  reservedPorts: () => Iterable<number> = () => [],
): PreviewTargetSource {
  const memo = new Map<string, { projectId: string; key: string; urls: string[] }>()

  const announcedUrls = (process: BackgroundProcess): string[] => {
    let snapshot: BackgroundProcessLogSnapshot | null = null
    try { snapshot = reader.logs(process) } catch { return [] }
    if (!snapshot) return []
    const last = snapshot.lines[snapshot.lines.length - 1]
    const key = `${snapshot.nextSequence}:${last?.sequence ?? 0}:${last?.line.length ?? 0}`
    const cached = memo.get(process.processId)
    if (cached?.key === key) return cached.urls
    const urls = previewTargetsFromLines(snapshot.lines.map((line) => line.line))
    memo.set(process.processId, { projectId: process.projectId, key, urls })
    return urls
  }

  const urlsFor = (process: BackgroundProcess): string[] => {
    const urls = announcedUrls(process)
    let reserved: Set<number>
    // Fail closed: if the reserved ports are unknown, preview nothing.
    try { reserved = new Set(reservedPorts()) } catch { return [] }
    return withoutReservedPorts(urls, reserved)
  }

  const live = (projectId: string): BackgroundProcess[] => {
    let processes: BackgroundProcess[] = []
    try { processes = reader.list(projectId) } catch { return [] }
    const running = processes.filter((process) => process.projectId === projectId && LIVE_STATUSES.has(process.status))
    // Drop memo entries of processes that are no longer live so the cache is
    // bounded by the running set of the projects being previewed.
    const ids = new Set(running.map((process) => process.processId))
    for (const [processId, entry] of memo) {
      if (entry.projectId === projectId && !ids.has(processId)) memo.delete(processId)
    }
    return running
  }

  const target = (process: BackgroundProcess): PreviewTarget => ({ processId: process.processId, chatId: process.chatId, urls: urlsFor(process) })

  return {
    list: (projectId) => live(projectId).map(target).filter((entry) => entry.urls.length > 0),
    forProcess: (projectId, processId) => {
      const process = live(projectId).find((candidate) => candidate.processId === processId)
      return process ? target(process) : null
    },
    announcedOrigins: (projectId) => {
      const origins = new Set<string>()
      for (const process of live(projectId)) {
        for (const url of urlsFor(process)) {
          const origin = previewOrigin(url)
          if (origin) origins.add(origin)
        }
      }
      return origins
    },
  }
}
