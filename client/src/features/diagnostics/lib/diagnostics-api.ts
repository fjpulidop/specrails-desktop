/**
 * Client for `/api/diagnostics/*` (server/modules/diagnostics). App-scoped, so
 * calls use `API_ORIGIN` rather than `getApiBase()`.
 */
import { API_ORIGIN } from '../../../lib/origin'
import { ApiResponseError, requestJson } from '../../../lib/api-response'

export interface ReportFile {
  name: string
  description: string
  content: string
  bytes: number
}

export interface ReportPreview {
  id: string
  createdAtMs: number
  fileName: string
  files: ReportFile[]
}

export type CrashOutcome = 'restarted' | 'stopped'

export interface CrashNotice {
  id: string
  atMs: number
  outcome: CrashOutcome
  exitCode: number | null
  signal: number | null
  uptimeMs: number
  wasReady: boolean
  recentRestarts: number
  maxRestarts: number
}

export interface CrashNoticeList {
  available: boolean
  acknowledgedThroughMs: number
  notices: CrashNotice[]
}

export interface StallRecord {
  atMs: number
  durationMs: number
  operation: string | null
  utilization: number | null
}

export interface StallSnapshot {
  thresholdMs: number
  sampling: boolean
  sinceMs: number
  total: number
  longestMs: number
  recent: StallRecord[]
}

const base = `${API_ORIGIN}/api/diagnostics`

/** Build a redacted report on the server; the preview is what the ZIP will contain. */
export async function buildProblemReport(signal?: AbortSignal): Promise<ReportPreview> {
  const body = await requestJson<ReportPreview | null>(`${base}/report`, { method: 'POST', signal })
  if (!body || typeof body.id !== 'string' || !Array.isArray(body.files)) throw new Error('Invalid report preview')
  return body
}

/** The ZIP of a previewed report, byte for byte. */
export async function downloadProblemReport(id: string): Promise<Uint8Array> {
  const res = await fetch(`${base}/report/${encodeURIComponent(id)}/zip`)
  if (!res.ok) {
    let message: string | undefined
    try { message = ((await res.json()) as { message?: string }).message } catch { /* not JSON */ }
    throw new ApiResponseError(res.status === 404 ? 'report_expired' : 'httpError', res.status, message, undefined, true)
  }
  return new Uint8Array(await res.arrayBuffer())
}

export async function getCrashNotices(signal?: AbortSignal): Promise<CrashNoticeList> {
  const body = await requestJson<CrashNoticeList | null>(`${base}/crashes`, { signal })
  return body && Array.isArray(body.notices) ? body : { available: false, acknowledgedThroughMs: 0, notices: [] }
}

export async function acknowledgeCrashes(throughMs: number): Promise<void> {
  await requestJson(`${base}/crashes/ack`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ throughMs }),
  })
}

export async function getStalls(signal?: AbortSignal): Promise<StallSnapshot> {
  const body = await requestJson<StallSnapshot | null>(`${base}/stalls`, { signal })
  if (!body || !Array.isArray(body.recent)) throw new Error('Invalid stall snapshot')
  return body
}
