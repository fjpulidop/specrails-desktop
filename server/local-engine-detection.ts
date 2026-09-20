// Local (OpenAI-compatible) engine detection.
//
// A local connection has no binary to probe: reachability is decided by a
// bounded `GET <baseUrl>/models`. The result feeds the app-level provider
// detection singleton (provider-detection.ts) AND the local adapter's dynamic
// model catalog (modelCatalog() reads `getCachedModels(id)`).
//
// Mapping (design D4):
//   2xx + `data[]`         → installed + executable, authenticated, models
//   401 / 403              → installed + executable, unauthenticated, []
//   anything else / error  → installed: false (unreachable)
//
// Spec: openspec/changes/local-ai-engines/specs/provider-auto-detection/spec.md

// 3 s was too tight for an endpoint on the LAN (or a server that loads a model
// before answering /models): a timed-out probe drops the engine from the usable
// set for that cycle, which flickers it out of provider selectors.
export const LOCAL_PROBE_TIMEOUT_MS = 8000

export interface LocalProbeInput {
  baseUrl: string
  apiKeyEnv?: string
}

export interface LocalProbeResult {
  reachable: boolean
  installed: boolean
  executable: boolean
  authState: 'authenticated' | 'unauthenticated' | 'unknown'
  models: string[]
  latencyMs: number
  error?: string
  /** `apiKeyEnv` was set but the variable is empty/unset in this process. */
  apiKeyEnvMissing?: boolean
}

export interface ProbeOptions {
  timeoutMs?: number
  fetch?: typeof fetch
  /** Env to read the API key from (test seam; defaults to process.env). */
  env?: NodeJS.ProcessEnv
}

function modelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/models`
}

function extractModelIds(body: unknown): string[] | null {
  if (!body || typeof body !== 'object') return null
  const data = (body as { data?: unknown }).data
  if (!Array.isArray(data)) return null
  const ids: string[] = []
  for (const entry of data) {
    if (entry && typeof entry === 'object' && typeof (entry as { id?: unknown }).id === 'string') {
      ids.push((entry as { id: string }).id)
    }
  }
  return ids
}

/** Bounded, never-throwing reachability + models probe of one connection. */
export async function probeConnection(
  conn: LocalProbeInput,
  opts: ProbeOptions = {},
): Promise<LocalProbeResult> {
  const timeoutMs = opts.timeoutMs ?? LOCAL_PROBE_TIMEOUT_MS
  const doFetch = opts.fetch ?? fetch
  const env = opts.env ?? process.env
  const startedAt = Date.now()
  const latency = () => Date.now() - startedAt

  const headers: Record<string, string> = { accept: 'application/json' }
  let apiKeyEnvMissing = false
  if (conn.apiKeyEnv) {
    const key = env[conn.apiKeyEnv]
    if (key && key.length > 0) headers.authorization = `Bearer ${key}`
    else apiKeyEnvMissing = true
  }
  const extra = apiKeyEnvMissing ? { apiKeyEnvMissing: true as const } : {}

  const unreachable = (error: string): LocalProbeResult => ({
    reachable: false, installed: false, executable: false, authState: 'unknown',
    models: [], latencyMs: latency(), error, ...extra,
  })

  let res: Response
  try {
    res = await doFetch(modelsUrl(conn.baseUrl), {
      method: 'GET',
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
    return unreachable(timedOut ? `timed out after ${timeoutMs} ms` : message)
  }

  if (res.status === 401 || res.status === 403) {
    return {
      reachable: true, installed: true, executable: true, authState: 'unauthenticated',
      models: [], latencyMs: latency(), error: `endpoint answered HTTP ${res.status} (not authorized)`, ...extra,
    }
  }
  if (res.status < 200 || res.status >= 300) {
    return unreachable(`endpoint answered HTTP ${res.status}`)
  }
  let body: unknown
  try {
    body = await res.json()
  } catch {
    return unreachable('endpoint did not return JSON')
  }
  const models = extractModelIds(body)
  if (models === null) return unreachable('endpoint response has no `data` array')
  return {
    reachable: true, installed: true, executable: true, authState: 'authenticated',
    models, latencyMs: latency(), ...extra,
  }
}

// ─── Module cache (per connection id) ────────────────────────────────────────

const _cache = new Map<string, LocalProbeResult>()

export function setCachedProbe(id: string, result: LocalProbeResult): void {
  _cache.set(id, result)
}

export function getCachedProbe(id: string): LocalProbeResult | null {
  return _cache.get(id) ?? null
}

/** Models discovered by the most recent SUCCESSFUL probe of `id` (else []). */
export function getCachedModels(id: string): string[] {
  const cached = _cache.get(id)
  return cached && cached.authState === 'authenticated' ? [...cached.models] : []
}

export function clearCachedProbe(id: string): void {
  _cache.delete(id)
}

export function _resetForTests(): void {
  _cache.clear()
}
