import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isCodeExplorerEnabled } from './feature-flags'
import { getProjectRepositories, type RepositoryProject } from './project-repositories'
import { listAllEntries, rankFindMatches, readBoundedSource, resolveSafePath, isDeniedRelPath, gitIgnoredSet } from './code-explorer-router'

export interface ProjectCodeDiscoveryInput {
  kind: 'find' | 'search'
  query: string
  limit?: number
  path?: string
  caseSensitive?: boolean
}

/** One project-wide budget, shared across all members. Every hit carries its
 * address; unavailable/partially scanned members cannot be mistaken for empty. */
export async function discoverProjectCode(project: RepositoryProject, input: ProjectCodeDiscoveryInput) {
  if (!isCodeExplorerEnabled()) throw new Error('code_explorer_disabled')
  const { kind, query } = input
  if (!['find', 'search'].includes(kind) || !query.trim() || query.length > 256 || /[\r\n]/.test(query)) {
    throw new Error('invalid_discovery_query')
  }
  if (input.path && (path.isAbsolute(input.path) || input.path.split(/[\\/]/).includes('..') || isDeniedRelPath(input.path))) {
    throw new Error('invalid_discovery_path')
  }
  const limit = Math.min(input.limit ?? (kind === 'find' ? 20 : 30), kind === 'find' ? 50 : 100)
  if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid_discovery_limit')
  const maxEntries = 20_000, maxFiles = 1_000, maxBytes = 8 * 1024 * 1024, maxDurationMs = 3_000, maxRepositories = 20
  const started = Date.now()
  let visitedEntries = 0, scannedFiles = 0, bytesRead = 0
  const repositories = getProjectRepositories(project)
  const matches: Array<Record<string, unknown>> = []
  const scans: Array<Record<string, unknown>> = []
  const reasons = new Set<string>()
  const needle = input.caseSensitive ? query : query.toLowerCase()
  for (let index = 0; index < repositories.length; index++) {
    const repository = repositories[index]
    const timeLeft = maxDurationMs - (Date.now() - started)
    if (index >= maxRepositories || timeLeft <= 0 || visitedEntries >= maxEntries || (kind === 'search' && (matches.length >= limit || scannedFiles >= maxFiles || bytesRead >= maxBytes))) {
      reasons.add(index >= maxRepositories ? 'repository-limit' : timeLeft <= 0 ? 'time-limit' : matches.length >= limit ? 'match-limit' : 'scan-limit')
      break
    }
    const identity = { repositoryId: repository.id, repositoryName: repository.name }
    try {
      if (!fs.statSync(repository.path).isDirectory()) throw new Error('unavailable')
      const relativeRoot = input.path && !['.', './'].includes(input.path) ? input.path.replace(/\\/g, '/') : ''
      const root = relativeRoot ? resolveSafePath(repository.path, relativeRoot) : repository.path
      if (!root) throw new Error('unsafe_path')
      let stat: fs.Stats
      try { stat = fs.statSync(root) } catch {
        scans.push({ ...identity, status: 'path-not-found' })
        continue
      }
      if (stat.isFile() && (await gitIgnoredSet(repository.path, [relativeRoot], Math.max(1, maxDurationMs - (Date.now() - started)))).has(relativeRoot)) {
        scans.push({ ...identity, status: 'path-excluded' })
        continue
      }
      const entriesLeft = maxEntries - visitedEntries
      const membersLeft = Math.min(repositories.length, maxRepositories) - index
      const scan = stat.isFile()
        ? { entries: [{ rel: relativeRoot, isDir: false, size: stat.size, mtime: stat.mtimeMs }], visited: 1, truncated: false, reason: null }
        : await listAllEntries(root, { maxEntries: Math.max(1, Math.floor(entriesLeft / membersLeft)), maxDurationMs: Math.max(1, Math.floor(timeLeft / membersLeft)) })
      const entries = relativeRoot && !stat.isFile()
        ? scan.entries.map(entry => ({ ...entry, rel: `${relativeRoot}/${entry.rel}` })) : scan.entries
      visitedEntries += scan.visited
      if (scan.truncated) reasons.add(`tree-${scan.reason}`)
      scans.push({ ...identity, status: scan.truncated ? 'partial' : 'ok', visited: scan.visited, truncationReason: scan.reason })
      if (kind === 'find') {
        matches.push(...rankFindMatches(entries, query).slice(0, limit + 1).map(match => ({ ...identity, path: match.rel, sizeBytes: match.size, match: match.match })))
        continue
      }
      for (const entry of entries) {
        if (entry.isDir) continue
        if (matches.length >= limit || scannedFiles >= maxFiles || bytesRead >= maxBytes || Date.now() - started >= maxDurationMs) {
          reasons.add(matches.length >= limit ? 'match-limit' : 'scan-limit')
          break
        }
        scannedFiles++
        const absolute = resolveSafePath(repository.path, entry.rel)
        if (!absolute || isDeniedRelPath(entry.rel)) continue
        try {
          const data = await readBoundedSource(absolute, Math.min(2 * 1024 * 1024, maxBytes - bytesRead))
          if (typeof data === 'string') { reasons.add('unreadable-or-oversized-files'); continue }
          bytesRead += data.length
          if (data.includes(0)) continue
          const lines = data.toString('utf8').split('\n')
          let fileHash: string | undefined
          for (let line = 0; line < lines.length; line++) {
            if (matches.length >= limit) { reasons.add('match-limit'); break }
            if (line % 128 === 0 && Date.now() - started >= maxDurationMs) { reasons.add('time-limit'); break }
            const text = lines[line].replace(/\r$/, '')
            const column = (input.caseSensitive ? text : text.toLowerCase()).indexOf(needle)
            if (column < 0) continue
            const from = Math.max(0, column - 80), to = Math.min(text.length, from + 320)
            fileHash ??= createHash('sha256').update(data).digest('hex')
            matches.push({ ...identity, path: entry.rel, lineNumber: line + 1, column: column + 1, snippet: text.slice(from, to), snippetTruncated: from > 0 || to < text.length, fileHash })
          }
        } catch { reasons.add('unreadable-files') }
      }
    } catch {
      scans.push({ ...identity, status: 'unavailable' })
      reasons.add('repository-unavailable')
    }
  }
  if (kind === 'find') {
    const rank: Record<string, number> = { exact: 0, suffix: 1, basename: 2, substring: 3 }
    matches.sort((a, b) => rank[String(a.match)] - rank[String(b.match)] || String(a.path).length - String(b.path).length || String(a.path).localeCompare(String(b.path)))
  }
  if (matches.length > limit) reasons.add('match-limit')
  if (scans.length < repositories.length) reasons.add('unscanned-repositories')
  return {
    projectId: project.id, kind, query, matches: matches.slice(0, limit),
    truncated: reasons.size > 0, truncationReasons: [...reasons], repositories: scans,
    scan: { visitedEntries, scannedFiles, bytesRead, durationMs: Date.now() - started, maxEntries, maxFiles, maxBytes, maxDurationMs, maxRepositories, unscannedRepositories: repositories.length - scans.length },
    hint: 'Use repositoryId and path from a match for scoped reads. Partial or unavailable scans never prove absence. Discovery grants no implementation write access.',
  }
}
