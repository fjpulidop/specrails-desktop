import { API_ORIGIN } from './origin'
import type { BackgroundProcess, BackgroundProcessStatus } from '../types'

export const BACKGROUND_PROCESS_REQUEST_TIMEOUT_MS = 10_000

export interface BackgroundProcessLogLine {
  at: number
  source: 'stdout' | 'stderr'
  line: string
  sequence: number
  partial?: boolean
}

export interface BackgroundProcessLogsSnapshot {
  process: BackgroundProcess
  lines: BackgroundProcessLogLine[]
  truncated: boolean
  droppedLines: number
  maxLines: number
  maxLineChars: number
  retentionMs: number
  nextSequence: number
}

export function backgroundProcessKey(process: BackgroundProcess): string {
  return JSON.stringify([process.projectId, process.chatId, process.processId ?? [process.pid, process.startedAt]])
}

const base = (projectId: string) => `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/background-processes`
const target = (process: BackgroundProcess) => {
  const query = new URLSearchParams({ chatId: process.chatId })
  if (process.processId) query.set('processId', process.processId)
  return { url: `${base(process.projectId)}/${encodeURIComponent(String(process.pid))}`, query }
}

async function responseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`)
  return body as T
}

async function requestJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort()
  if (init.signal?.aborted) abort()
  else init.signal?.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(() => { timedOut = true; abort() }, BACKGROUND_PROCESS_REQUEST_TIMEOUT_MS)
  try {
    return await responseJson<T>(await fetch(url, { ...init, signal: controller.signal }))
  } catch (error) {
    if (timedOut) throw new Error('The background process request timed out. Check its status and retry.')
    throw error
  } finally {
    window.clearTimeout(timer)
    init.signal?.removeEventListener('abort', abort)
  }
}

export async function listBackgroundProcesses(projectId: string, chatId: string, signal?: AbortSignal): Promise<BackgroundProcess[]> {
  const query = new URLSearchParams({ chatId, includeFinished: 'true' })
  const data = await requestJson<{ processes: BackgroundProcess[] }>(`${base(projectId)}?${query}`, { signal })
  if (!Array.isArray(data?.processes)) throw new Error('Invalid background process snapshot')
  return data.processes
}

export async function stopBackgroundProcess(process: BackgroundProcess, signal?: AbortSignal): Promise<{ ok: boolean; process?: BackgroundProcess; status?: BackgroundProcessStatus }> {
  const { url, query } = target(process)
  const result = await requestJson<{ ok: boolean; process?: BackgroundProcess; status?: BackgroundProcessStatus }>(`${url}?${query}`, { method: 'DELETE', signal })
  if (!result?.ok) throw new Error('The server did not confirm the stop request')
  if (result.process && backgroundProcessKey(result.process) !== backgroundProcessKey(process)) throw new Error('The stop response belongs to another process')
  return result
}

export async function getBackgroundProcessLogs(process: BackgroundProcess, options: { limit?: number; signal?: AbortSignal } = {}): Promise<BackgroundProcessLogsSnapshot> {
  const { url, query } = target(process)
  const limit = Number.isFinite(options.limit) ? options.limit! : 2000
  query.set('limit', String(Math.max(1, Math.min(2000, Math.trunc(limit)))))
  const result = await requestJson<BackgroundProcessLogsSnapshot>(`${url}/logs?${query}`, { signal: options.signal })
  if (!result?.process || !Array.isArray(result.lines) || backgroundProcessKey(result.process) !== backgroundProcessKey(process)) throw new Error('Invalid background process log snapshot')
  return result
}
