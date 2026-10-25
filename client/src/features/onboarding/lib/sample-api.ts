import { API_ORIGIN } from '../../../lib/origin'
import { readSampleStatus, type SamplePreset, type SampleRecordView, type SampleStatus } from './sample-model'

const base = `${API_ORIGIN}/api/onboarding/sample`

export class SampleApiError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'SampleApiError'
  }
}

async function failure(res: Response): Promise<SampleApiError> {
  let body: Record<string, unknown> = {}
  try { body = await res.json() as Record<string, unknown> } catch { /* no body */ }
  const code = typeof body.error === 'string' ? body.error : `http_${res.status}`
  const detail = typeof body.detail === 'string' ? body.detail : code
  return new SampleApiError(code, detail)
}

export async function fetchSampleStatus(opts: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<SampleStatus | null> {
  const res = await fetch(`${base}${opts.refresh ? '?refresh=1' : ''}`, { signal: opts.signal })
  if (!res.ok) return null
  return readSampleStatus(await res.json())
}

export interface CreateSampleArgs {
  locale: string
  /** Exact folder; omit to use the default parent folder (the server picks a free name). */
  path?: string
  parentDir?: string
}

export interface CreateSampleOutcome {
  reused: boolean
  project: { id: string; name: string; path: string }
  sample: SampleRecordView
}

export async function createSampleProject(args: CreateSampleArgs): Promise<CreateSampleOutcome> {
  const res = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  if (!res.ok) throw await failure(res)
  return await res.json() as CreateSampleOutcome
}

export async function removeSampleProject(deleteFolder: boolean): Promise<void> {
  const res = await fetch(`${base}${deleteFolder ? '?deleteFolder=1' : ''}`, { method: 'DELETE' })
  if (!res.ok) throw await failure(res)
}

export type LaunchOutcome =
  | { ok: true }
  | { ok: false; code: 'over_budget' | 'rail_busy' | 'failed'; detail?: string }

/**
 * Run the first spec: assign it to a free rail, then launch through the ordinary
 * rail route with the sample preset (Quick SDD, cheapest model or local engine,
 * per-run soft cap). Only the active project's own routes are used.
 */
export async function launchFirstSpec(projectId: string, specId: number, preset: SamplePreset): Promise<LaunchOutcome> {
  const root = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/rails`
  const json = { 'Content-Type': 'application/json' }
  try {
    const listRes = await fetch(root)
    if (!listRes.ok) return { ok: false, code: 'failed' }
    const list = await listRes.json() as { rails?: Array<{ railIndex: number; availability?: string; ticketIds?: number[] }> }
    let rail = (list.rails ?? []).find((r) => r.availability === 'free' && (r.ticketIds ?? []).length === 0) ?? null
    if (!rail) rail = (list.rails ?? []).find((r) => r.availability === 'free') ?? null
    let railIndex = rail?.railIndex
    if (railIndex === undefined) {
      const created = await fetch(root, { method: 'POST', headers: json, body: JSON.stringify({}) })
      if (!created.ok) return { ok: false, code: 'rail_busy' }
      const body = await created.json() as { rail?: { railIndex?: number } }
      railIndex = body.rail?.railIndex
      if (typeof railIndex !== 'number') return { ok: false, code: 'failed' }
    }
    const assign = await fetch(`${root}/${railIndex}/tickets`, { method: 'PUT', headers: json, body: JSON.stringify({ ticketIds: [specId] }) })
    if (!assign.ok) return { ok: false, code: 'failed' }
    const launch = await fetch(`${root}/${railIndex}/launch`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({
        loopId: preset.loopId,
        aiEngine: preset.provider,
        model: preset.model,
        // A cloud run is capped (pause and ask); a local engine has no marginal cost, so no cap.
        ...(preset.runCapUsd !== null ? { runCapUsd: preset.runCapUsd } : {}),
      }),
    })
    if (launch.ok) return { ok: true }
    let body: Record<string, unknown> = {}
    try { body = await launch.json() as Record<string, unknown> } catch { /* no body */ }
    if (body.error === 'daily_budget_exceeded') return { ok: false, code: 'over_budget' }
    return { ok: false, code: 'failed', detail: typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : undefined }
  } catch {
    return { ok: false, code: 'failed' }
  }
}
