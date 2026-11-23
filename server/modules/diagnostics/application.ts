/**
 * Diagnostics use cases: build a problem-report preview that cannot change
 * before it is saved, and list / acknowledge the crashes the interface has not
 * explained yet. Depends only on the domain and its own ports.
 */
import { buildReportFiles, nextAcknowledgement, reportFileName, unacknowledgedCrashes, type CrashNotice, type ReportFile, type TextRedactor } from './domain'
import type { CrashMarkerStore, ReportCollector } from './ports'

export interface ReportPreview {
  id: string
  createdAtMs: number
  fileName: string
  files: ReportFile[]
}

export interface ProblemReports {
  /** Collect, redact and keep a report; the same files are later zipped by id. */
  preview(): Promise<ReportPreview>
  /** A kept preview, or undefined once it expired. */
  get(id: string): ReportPreview | undefined
}

export const REPORT_PREVIEW_TTL_MS = 15 * 60_000
const MAX_KEPT_PREVIEWS = 3

export function createProblemReports(deps: {
  collect: ReportCollector
  redact: TextRedactor
  newId: () => string
  now?: () => number
  ttlMs?: number
}): ProblemReports {
  const now = deps.now ?? Date.now
  const ttl = deps.ttlMs ?? REPORT_PREVIEW_TTL_MS
  // In memory only: a preview is never written to disk by the server.
  const kept = new Map<string, ReportPreview>()
  const prune = () => {
    for (const [id, preview] of kept) if (now() - preview.createdAtMs > ttl) kept.delete(id)
    while (kept.size > MAX_KEPT_PREVIEWS) kept.delete(kept.keys().next().value as string)
  }
  return {
    async preview() {
      const sources = await deps.collect()
      const createdAtMs = now()
      const preview: ReportPreview = {
        id: deps.newId(),
        createdAtMs,
        fileName: reportFileName(createdAtMs),
        files: buildReportFiles({ ...sources, createdAtMs }, deps.redact),
      }
      kept.set(preview.id, preview)
      prune()
      return preview
    },
    get(id) {
      prune()
      return kept.get(id)
    },
  }
}

export interface CrashNotices {
  list(): { available: boolean; acknowledgedThroughMs: number; notices: CrashNotice[] }
  /** Mark every crash up to `throughMs` as explained; never moves backwards. */
  acknowledge(throughMs: unknown): { acknowledgedThroughMs: number }
}

export function createCrashNotices(store: CrashMarkerStore): CrashNotices {
  return {
    list() {
      if (!store.available) return { available: false, acknowledgedThroughMs: 0, notices: [] }
      const through = store.acknowledgedThrough()
      return { available: true, acknowledgedThroughMs: through, notices: unacknowledgedCrashes(store.list(), through) }
    },
    acknowledge(throughMs) {
      if (!store.available) return { acknowledgedThroughMs: 0 }
      const current = store.acknowledgedThrough()
      const next = nextAcknowledgement(current, throughMs, store.list())
      if (next !== current) store.acknowledge(next)
      return { acknowledgedThroughMs: next }
    },
  }
}
