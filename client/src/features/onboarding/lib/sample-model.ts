/**
 * Sample-project first run: client model (pure). The server decides readiness
 * and the preset (`GET /api/onboarding/sample`); this file only types and reads
 * that answer and words the cost statement the person sees BEFORE anything runs.
 */

export interface SamplePreset {
  provider: string
  model: string
  local: boolean
  loopId: string
  /** Per-run soft cap in USD; null for a local engine. */
  runCapUsd: number | null
}

export type SampleLaunch =
  | { ready: true; preset: SamplePreset; localPreset: SamplePreset | null; estimate: SampleEstimate; runCapUsd: number }
  | { ready: false; reason: 'no_provider' | 'not_signed_in'; estimate: SampleEstimate; runCapUsd: number }

export interface SampleEstimate {
  minutes: [number, number]
  usd: [number, number]
}

export interface SampleRecordView {
  sampleId: string
  projectId: string
  path: string
  specIds: number[]
}

export interface SampleStatus {
  catalog: Array<{ id: string; name: string; specCount: number }>
  sample: SampleRecordView | null
  defaultParentDir: string
  launch: SampleLaunch
}

const FALLBACK_ESTIMATE: SampleEstimate = { minutes: [3, 5], usd: [0.3, 1] }

function pair(value: unknown, fallback: [number, number]): [number, number] {
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0)) return [value[0], value[1]]
  return fallback
}

function preset(value: unknown): SamplePreset | null {
  if (typeof value !== 'object' || value === null) return null
  const v = value as Record<string, unknown>
  if (typeof v.provider !== 'string' || typeof v.model !== 'string' || typeof v.loopId !== 'string') return null
  return {
    provider: v.provider,
    model: v.model,
    local: v.local === true,
    loopId: v.loopId,
    runCapUsd: typeof v.runCapUsd === 'number' && Number.isFinite(v.runCapUsd) && v.runCapUsd > 0 ? v.runCapUsd : null,
  }
}

/** Tolerant reader: an unreadable answer is "not ready", never a crash. */
export function readSampleStatus(raw: unknown): SampleStatus | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const launchRaw = (typeof r.launch === 'object' && r.launch !== null ? r.launch : {}) as Record<string, unknown>
  const estimateRaw = (typeof launchRaw.estimate === 'object' && launchRaw.estimate !== null ? launchRaw.estimate : {}) as Record<string, unknown>
  const estimate: SampleEstimate = { minutes: pair(estimateRaw.minutes, FALLBACK_ESTIMATE.minutes), usd: pair(estimateRaw.usd, FALLBACK_ESTIMATE.usd) }
  const runCapUsd = typeof launchRaw.runCapUsd === 'number' && launchRaw.runCapUsd > 0 ? launchRaw.runCapUsd : 1
  const main = launchRaw.ready === true ? preset(launchRaw.preset) : null
  const launch: SampleLaunch = main
    ? { ready: true, preset: main, localPreset: preset(launchRaw.localPreset), estimate, runCapUsd }
    : { ready: false, reason: launchRaw.reason === 'not_signed_in' ? 'not_signed_in' : 'no_provider', estimate, runCapUsd }
  const sampleRaw = r.sample
  let sample: SampleRecordView | null = null
  if (typeof sampleRaw === 'object' && sampleRaw !== null) {
    const s = sampleRaw as Record<string, unknown>
    if (typeof s.projectId === 'string' && typeof s.path === 'string') {
      sample = {
        sampleId: typeof s.sampleId === 'string' ? s.sampleId : 'tic-tac-toe',
        projectId: s.projectId,
        path: s.path,
        specIds: Array.isArray(s.specIds) ? s.specIds.filter((id): id is number => typeof id === 'number') : [],
      }
    }
  }
  const catalog = Array.isArray(r.catalog)
    ? r.catalog.flatMap((entry) => {
        const e = entry as Record<string, unknown>
        return typeof e?.id === 'string' && typeof e?.name === 'string' ? [{ id: e.id, name: e.name, specCount: typeof e.specCount === 'number' ? e.specCount : 3 }] : []
      })
    : []
  return { catalog, sample, defaultParentDir: typeof r.defaultParentDir === 'string' ? r.defaultParentDir : '', launch }
}

/** How the run is billed, as far as the machine can tell. Only `metered` licenses a dollar figure. */
export type SampleBilling = 'local' | 'plan' | 'metered' | 'unknown'

export function sampleBilling(preset: SamplePreset, billing: { ready: boolean; plan: boolean; metered: boolean }): SampleBilling {
  if (preset.local) return 'local'
  if (billing.ready && billing.plan) return 'plan'
  if (billing.ready && billing.metered) return 'metered'
  return 'unknown'
}

export const GUIDE_STEPS = ['spec', 'rail', 'review'] as const
export type GuideStep = (typeof GUIDE_STEPS)[number]

/** The default folder shown in the dialog: `<parent>/<sample name>` with the host's separator. */
export function defaultSampleFolder(parentDir: string, name: string): string {
  if (!parentDir) return name
  const sep = parentDir.includes('\\') && !parentDir.includes('/') ? '\\' : '/'
  return parentDir.endsWith(sep) ? parentDir + name : parentDir + sep + name
}
