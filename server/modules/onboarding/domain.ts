/**
 * Sample-project first run: pure vocabulary and rules.
 *
 * The sample is a tiny bundled repository the person can try before pointing
 * Specrails at their own code. Nothing here touches the filesystem, git, SQLite
 * or a provider: those effects live behind {@link ./ports} and the adapters.
 */

export const SAMPLE_LOCALES = ['en', 'es', 'fr', 'de', 'pt', 'it', 'zh', 'ja'] as const
export type SampleLocale = (typeof SAMPLE_LOCALES)[number]

export function normalizeSampleLocale(raw: unknown): SampleLocale {
  if (typeof raw !== 'string') return 'en'
  const base = raw.toLowerCase().split('-')[0].trim()
  return (SAMPLE_LOCALES as readonly string[]).includes(base) ? (base as SampleLocale) : 'en'
}

export interface SampleSpecText {
  title: string
  summary: string
  description: string
}

export interface SampleSpecDefinition {
  /** Stable key ("restart-button"); never shown. */
  key: string
  priority: 'high' | 'medium' | 'low'
  labels: string[]
  effort: 'small' | 'medium'
  text: Record<SampleLocale, SampleSpecText>
}

export interface SampleDefinition {
  id: string
  /** Folder / project name. */
  name: string
  commitMessage: string
  /** Relative POSIX path -> file content. */
  files: Record<string, string>
  specs: readonly SampleSpecDefinition[]
}

/** The workflow the first run uses: Quick SDD, the shortest factory pipeline. */
export const SAMPLE_LOOP_ID = 'factory:sdd-quick-openspec'
/** Soft cap (USD): the run pauses and asks at this provider-reported cost. */
export const SAMPLE_RUN_CAP_USD = 1
/** Honest, static envelope for the cost statement (an estimate, never a bill). */
export const SAMPLE_ESTIMATE = { minutes: [3, 5] as const, usd: [0.3, 1] as const }
/** Settings key (desktop_settings) holding the {@link SampleRecord} JSON. */
export const SAMPLE_SETTING_KEY = 'onboarding.sample'
/** Folder, under the home directory, where samples are created by default. */
export const SAMPLE_PARENT_DIR_NAME = 'Specrails Samples'

export interface SampleRecord {
  sampleId: string
  projectId: string
  /** Absolute path of the created repository. */
  path: string
  /** Ticket ids of the installed specs, in catalog order. */
  specIds: number[]
  createdAt: string
}

// ─── Launch preset ───────────────────────────────────────────────────────────

export interface PresetModelCandidate {
  value: string
  /** USD per million tokens (input + output, from the rate card); null when unpriced. */
  priceUsdPer1M: number | null
}

export interface PresetProviderCandidate {
  id: string
  local: boolean
  /** Installed, executable, version floor met, not vetoed. */
  usable: boolean
  authState: 'authenticated' | 'unauthenticated' | 'unknown'
  defaultModel: string
  models: readonly PresetModelCandidate[]
}

export interface SamplePreset {
  provider: string
  model: string
  local: boolean
  loopId: string
  /** Per-run soft cap (USD); null for a local engine (no marginal cost). */
  runCapUsd: number | null
}

export type SampleLaunchReadiness =
  | { ready: true; preset: SamplePreset; localPreset: SamplePreset | null }
  | { ready: false; reason: 'no_provider' | 'not_signed_in'; preset: null; localPreset: null }

function isReady(p: PresetProviderCandidate): boolean {
  return p.usable && p.authState !== 'unauthenticated'
}

/** The cheapest PRICED model; falls back to the provider default when none is priced. */
export function cheapestModel(provider: PresetProviderCandidate): string {
  let best: PresetModelCandidate | null = null
  for (const model of provider.models) {
    if (model.priceUsdPer1M === null || !Number.isFinite(model.priceUsdPer1M)) continue
    if (best === null || model.priceUsdPer1M < (best.priceUsdPer1M as number)) best = model
  }
  return best?.value ?? provider.defaultModel
}

/**
 * Decide the first-run configuration: Quick SDD, the cheapest available model
 * of the cheapest ready cloud provider, a per-run soft cap, or a configured
 * local engine (no cap, no dollars). `localPreset` is offered alongside when
 * both exist. Returns a not-ready verdict, with the reason, when nothing can
 * run, so the caller offers the recorded run instead of a run that would fail.
 */
export function chooseSamplePreset(providers: readonly PresetProviderCandidate[]): SampleLaunchReadiness {
  const ready = providers.filter(isReady)
  if (ready.length === 0) {
    const signedOut = providers.some((p) => p.usable && p.authState === 'unauthenticated')
    return { ready: false, reason: signedOut ? 'not_signed_in' : 'no_provider', preset: null, localPreset: null }
  }
  const price = (p: PresetProviderCandidate): number => {
    const model = cheapestModel(p)
    return p.models.find((m) => m.value === model)?.priceUsdPer1M ?? Number.POSITIVE_INFINITY
  }
  const cloud = ready.filter((p) => !p.local).sort((a, b) => price(a) - price(b))[0] ?? null
  const local = ready.find((p) => p.local) ?? null
  const cloudPreset: SamplePreset | null = cloud
    ? { provider: cloud.id, model: cheapestModel(cloud), local: false, loopId: SAMPLE_LOOP_ID, runCapUsd: SAMPLE_RUN_CAP_USD }
    : null
  const localPreset: SamplePreset | null = local
    ? { provider: local.id, model: local.models[0]?.value ?? local.defaultModel, local: true, loopId: SAMPLE_LOOP_ID, runCapUsd: null }
    : null
  // The default is the cloud choice; a machine with only a local engine runs on it.
  return { ready: true, preset: (cloudPreset ?? localPreset) as SamplePreset, localPreset: cloudPreset ? localPreset : null }
}

// ─── Target directory ────────────────────────────────────────────────────────

/** `name`, then `name-2`, `name-3`… the first one `taken` does not claim. */
export function firstFreeName(name: string, taken: (candidate: string) => boolean, limit = 50): string | null {
  if (!taken(name)) return name
  for (let n = 2; n <= limit; n += 1) {
    const candidate = `${name}-${n}`
    if (!taken(candidate)) return candidate
  }
  return null
}

/** True when `child` is strictly inside `parent` (both absolute, already normalized). */
export function isStrictlyInside(parent: string, child: string, sep: string): boolean {
  const prefix = parent.endsWith(sep) ? parent : parent + sep
  return child.length > prefix.length && child.startsWith(prefix)
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type SampleErrorCode =
  | 'unknown_sample'
  | 'outside_home'
  | 'path_exists'
  | 'no_free_name'
  | 'git_failed'
  | 'write_failed'
  | 'register_failed'
  | 'not_found'
  | 'unsafe_delete'

export class SampleError extends Error {
  constructor(readonly code: SampleErrorCode, message: string, readonly status: number = 400) {
    super(message)
    this.name = 'SampleError'
  }
}
