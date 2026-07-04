import { useEffect, useState, useCallback } from 'react'
import { API_ORIGIN } from '../lib/origin'

export type Platform = 'darwin' | 'win32' | 'linux'

export interface SetupPrerequisite {
  /** node/npm/npx/git/gh for tools; the adapter id for provider CLIs. */
  key: string
  /** 'tool' (node/npm/npx/git/gh/uv) vs 'provider' (claude/codex/gemini). */
  kind?: 'tool' | 'provider'
  label: string
  command: string
  required: boolean
  installed: boolean
  /** True when `installed` AND `<command> --version` exits 0. Server adds this in the broken-symlink fix. */
  executable?: boolean
  version?: string
  /** Absolute path returned by `which`, when found. Optional — server may omit. */
  resolvedPath?: string
  /** Raw spawn failure detail when `installed && !executable`. */
  executionError?: string
  minVersion?: string
  meetsMinimum: boolean
  installUrl: string
  installHint: string
  /** True when this tool is provided by the bundled runtime (desktop mode only). */
  bundled?: true
  /** Desktop mode: 'corrupted-bundle' when the bundled binary fails --version probe. */
  error?: 'corrupted-bundle'
  /** gh only: whether `gh auth token` found a credential (offline check). */
  authenticated?: boolean
}

export interface SetupPrerequisitesStatus {
  ok: boolean
  platform: Platform
  prerequisites: SetupPrerequisite[]
  missingRequired: SetupPrerequisite[]
}

interface UsePrerequisitesResult {
  status: SetupPrerequisitesStatus | null
  isLoading: boolean
  error: Error | null
  recheck: () => Promise<void>
}

const CACHE_TTL_MS = 60_000

interface CacheState {
  data: SetupPrerequisitesStatus | null
  fetchedAt: number
  inFlight: Promise<SetupPrerequisitesStatus> | null
  error: Error | null
}

const cache: CacheState = {
  data: null,
  fetchedAt: 0,
  inFlight: null,
  error: null,
}

const subscribers = new Set<() => void>()

function notifySubscribers(): void {
  subscribers.forEach((fn) => {
    try { fn() } catch { /* ignore */ }
  })
}

function isFresh(): boolean {
  return cache.data !== null && Date.now() - cache.fetchedAt < CACHE_TTL_MS
}

async function fetchPrerequisites(signal?: AbortSignal): Promise<SetupPrerequisitesStatus> {
  if (cache.inFlight) return cache.inFlight

  const promise = (async () => {
    const res = await fetch(`${API_ORIGIN}/api/setup-prerequisites`, { signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json() as Partial<SetupPrerequisitesStatus>
    if (typeof data?.ok !== 'boolean' || !Array.isArray(data?.prerequisites) || !Array.isArray(data?.missingRequired)) {
      throw new Error('Malformed prerequisites response')
    }
    cache.data = data as SetupPrerequisitesStatus
    cache.fetchedAt = Date.now()
    cache.error = null
    cache.inFlight = null
    notifySubscribers()
    return cache.data
  })().catch((err) => {
    cache.inFlight = null
    if (signal?.aborted) {
      // Aborted — don't store as error; another subscriber might still be pending.
      throw err
    }
    cache.error = err instanceof Error ? err : new Error(String(err))
    notifySubscribers()
    throw cache.error
  })

  cache.inFlight = promise
  return promise
}

let focusListenerInstalled = false

function ensureFocusListener(): void {
  if (focusListenerInstalled) return
  if (typeof window === 'undefined') return
  window.addEventListener('focus', () => {
    cache.fetchedAt = 0
    cache.data = null
    void fetchPrerequisites().catch(() => { /* surfaced via subscribers */ })
  })
  focusListenerInstalled = true
}

/** Test-only: reset module state. Not exported through the package surface. */
export function __resetPrerequisitesCacheForTest(): void {
  cache.data = null
  cache.fetchedAt = 0
  cache.inFlight = null
  cache.error = null
  subscribers.clear()
}

export function usePrerequisites(): UsePrerequisitesResult {
  const [, forceRender] = useState(0)
  const [isLoading, setIsLoading] = useState(() => !isFresh())
  const [error, setError] = useState<Error | null>(cache.error)

  useEffect(() => {
    ensureFocusListener()

    const subscription = () => {
      forceRender((n) => n + 1)
      setError(cache.error)
      setIsLoading(false)
    }
    subscribers.add(subscription)

    const controller = new AbortController()

    if (!isFresh() && !cache.inFlight) {
      setIsLoading(true)
      fetchPrerequisites(controller.signal)
        .catch((err) => {
          if (controller.signal.aborted) return
          setError(err instanceof Error ? err : new Error(String(err)))
        })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false)
        })
    } else if (cache.inFlight) {
      cache.inFlight
        .catch(() => { /* error reflected via subscribers */ })
        .finally(() => {
          if (!controller.signal.aborted) setIsLoading(false)
        })
    }

    return () => {
      controller.abort()
      subscribers.delete(subscription)
    }
  }, [])

  const recheck = useCallback(async () => {
    cache.fetchedAt = 0
    cache.data = null
    cache.error = null
    setIsLoading(true)
    try {
      await fetchPrerequisites()
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setIsLoading(false)
    }
  }, [])

  return {
    status: cache.data,
    isLoading,
    error,
    recheck,
  }
}
