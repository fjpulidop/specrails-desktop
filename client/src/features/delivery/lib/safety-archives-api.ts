import { API_ORIGIN } from '../../../lib/origin'
import { requestJson } from '../../../lib/api-response'

/**
 * Safety archives: folders release left beside a run's worktree
 * (`<worktree>.specrails-overlay-quarantine-XXXXXX`) holding files it could
 * not prove were Specrails's own unchanged kit, so they did not go into the PR
 * and were not deleted. Server: `/api/worktrees/quarantines*`.
 */
export interface SafetyArchiveFile {
  path: string
  kind: 'file' | 'link' | 'other'
  bytes: number
}

export interface SafetyArchive {
  projectId: string
  projectName?: string
  path: string
  worktreeName: string
  createdAt: number
  fileCount: number
  bytes: number
  files: SafetyArchiveFile[]
  truncated: boolean
}

export interface SafetyArchiveRef { projectId: string; path: string }

export interface SafetyArchivesSnapshot {
  generatedAt: string
  projects: Array<{ projectId: string; projectName: string; error?: string }>
  items: SafetyArchive[]
}

export type SafetyArchiveInspection = SafetyArchiveRef & (
  | { status: 'present'; quarantine: Omit<SafetyArchive, 'projectId' | 'projectName'> }
  | { status: 'missing' | 'refused'; reason?: string }
)

export interface SafetyArchiveDeletion extends SafetyArchiveRef {
  status: 'deleted' | 'refused' | 'failed'
  fileCount?: number
  bytes?: number
  reason?: string
  error?: string
}

const BASE = `${API_ORIGIN}/api/worktrees/quarantines`

export async function getSafetyArchives(signal?: AbortSignal): Promise<SafetyArchivesSnapshot> {
  const body = await requestJson<SafetyArchivesSnapshot | null>(BASE, { signal })
  if (!body || !Array.isArray(body.items) || !Array.isArray(body.projects)) throw new Error('Invalid safety archive listing')
  return body
}

export async function inspectSafetyArchives(items: SafetyArchiveRef[], signal?: AbortSignal): Promise<SafetyArchiveInspection[]> {
  if (items.length === 0) return []
  const body = await requestJson<{ items?: SafetyArchiveInspection[] } | null>(`${BASE}/inspect`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }), signal,
  })
  return Array.isArray(body?.items) ? body!.items : []
}

export async function removeSafetyArchives(items: SafetyArchiveRef[]): Promise<SafetyArchiveDeletion[]> {
  const body = await requestJson<{ results?: SafetyArchiveDeletion[] } | null>(`${BASE}/remove`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }),
  })
  return Array.isArray(body?.results) ? body!.results : []
}

/** The archive folder's own name (`ticket-14.specrails-overlay-quarantine-3VqEp0`). */
export function safetyArchiveFolderName(archivePath: string): string {
  return archivePath.split(/[\\/]/).filter(Boolean).pop() ?? archivePath
}

/** Human byte size (`512 B`, `1.5 KB`, `3.0 MB`). */
export function formatArchiveBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++ }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`
}

const DISMISSED_KEY = 'specrails.safetyArchives.dismissed'
const DISMISSED_CAP = 200

function readDismissed(): string[] {
  try {
    const raw = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]') as unknown
    return Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

/** "Dismiss" hides the notice in this browser only; the files stay on disk. */
export function isSafetyArchiveDismissed(archivePath: string): boolean {
  return readDismissed().includes(archivePath)
}

export function dismissSafetyArchives(paths: readonly string[]): void {
  try {
    const next = [...new Set([...readDismissed(), ...paths])].slice(-DISMISSED_CAP)
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
  } catch { /* storage unavailable: the notice simply shows again next time */ }
}
