import { useState, useEffect, useRef, useCallback } from 'react'

/**
 * Per-project data cache with stale-while-revalidate pattern.
 *
 * On project switch:
 * 1. Instantly returns cached data for the new project (no flicker)
 * 2. Fetches fresh data in the background
 * 3. Silently updates when fresh data arrives
 *
 * First visit to a project shows the initial value briefly, then data.
 */

// Global cache store — survives component unmounts, shared across instances with same key
const globalCache = new Map<string, unknown>()

function cacheKey(projectId: string, namespace: string): string {
  return `${projectId}:${namespace}`
}

function requestErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : error == null
      ? ''
      : String(error)
  return message.trim() || 'Request failed'
}

/**
 * Purge all cached entries for a project (every `${projectId}:<namespace>` key).
 *
 * The module-level `globalCache` is keyed by `projectId` to prevent cross-project
 * bleed, but it has no automatic deletion path — a long session that adds/removes
 * many projects would grow it unbounded, and a reused project id would briefly
 * flash the previous occupant's stale data (stale-while-revalidate). Callers MUST
 * invoke this on project removal (BUG-CLIENT-03).
 */
export function purgeProjectCache(projectId: string): void {
  if (!projectId) return
  const prefix = `${projectId}:`
  for (const cachedKey of globalCache.keys()) {
    if (cachedKey.startsWith(prefix)) globalCache.delete(cachedKey)
  }
}

interface UseProjectCacheOptions<T> {
  /** Unique namespace for this cache (e.g., 'commands', 'jobs', 'analytics') */
  namespace: string
  /** Active project ID — cache switches when this changes */
  projectId: string | null
  /** Initial value when no cache exists */
  initialValue: T
  /** Fetch function — receives the immutable project owner + cancellation signal
   *  for this request. Callers may ignore the argument when they are not
   *  project-scoped. */
  fetcher: (context: { projectId: string; signal: AbortSignal }) => Promise<T>
  /** Poll interval in ms (0 = no polling) */
  pollInterval?: number
}

interface UseProjectCacheReturn<T> {
  data: T
  isLoading: boolean
  /** True only on first load (no cache exists). False when showing cached data. */
  isFirstLoad: boolean
  /** Last request error. Cached/previous data remains available when set. */
  error: string | null
  refresh: () => Promise<void>
}

export function useProjectCache<T>({
  namespace,
  projectId,
  initialValue,
  fetcher,
  pollInterval = 0,
}: UseProjectCacheOptions<T>): UseProjectCacheReturn<T> {
  const key = projectId ? cacheKey(projectId, namespace) : null

  // Initialize from cache or initial value
  const [data, setData] = useState<T>(() => {
    if (key && globalCache.has(key)) return globalCache.get(key) as T
    return initialValue
  })

  const [isFirstLoad, setIsFirstLoad] = useState(() => {
    return key ? !globalCache.has(key) : true
  })

  const [isLoading, setIsLoading] = useState(isFirstLoad)
  const [error, setError] = useState<string | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const initialValueRef = useRef(initialValue)
  initialValueRef.current = initialValue
  // The key, generation and AbortController jointly enforce latest-request
  // ownership even when a fetch implementation ignores AbortSignal.
  const keyRef = useRef(key)
  keyRef.current = key
  const requestGenerationRef = useRef(0)
  const activeControllerRef = useRef<AbortController | null>(null)

  const runFetch = useCallback(async (
    requestKey: string,
    ownerProjectId: string,
    showLoading: boolean,
  ): Promise<void> => {
    const generation = ++requestGenerationRef.current
    activeControllerRef.current?.abort()
    const controller = new AbortController()
    activeControllerRef.current = controller

    if (showLoading && keyRef.current === requestKey) {
      setIsLoading(true)
      setError(null)
    }

    try {
      const fresh = await fetcherRef.current({ projectId: ownerProjectId, signal: controller.signal })
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      globalCache.set(requestKey, fresh)
      if (keyRef.current === requestKey) {
        setData(fresh)
        setError(null)
      }
    } catch (err) {
      if (controller.signal.aborted || generation !== requestGenerationRef.current) return
      if (keyRef.current === requestKey) {
        setError(requestErrorMessage(err))
      }
    } finally {
      if (generation === requestGenerationRef.current) {
        if (activeControllerRef.current === controller) activeControllerRef.current = null
        if (keyRef.current === requestKey) {
          setIsLoading(false)
          setIsFirstLoad(false)
        }
      }
    }
  }, [])

  // On project switch: restore from cache instantly, then refresh
  useEffect(() => {
    requestGenerationRef.current += 1
    activeControllerRef.current?.abort()
    activeControllerRef.current = null
    setError(null)
    if (!key || !projectId) {
      setData(initialValueRef.current)
      setIsFirstLoad(true)
      setIsLoading(false)
      return
    }

    const hasCached = globalCache.has(key)
    if (hasCached) {
      setData(globalCache.get(key) as T)
      setIsFirstLoad(false)
      setIsLoading(false)
    } else {
      setData(initialValueRef.current)
      setIsFirstLoad(true)
      setIsLoading(true)
    }

    void runFetch(key, projectId, !hasCached)

    // Polling
    let interval: ReturnType<typeof setInterval> | undefined
    if (pollInterval > 0) {
      interval = setInterval(() => { void runFetch(key, projectId, false) }, pollInterval)
    }

    return () => {
      requestGenerationRef.current += 1
      activeControllerRef.current?.abort()
      activeControllerRef.current = null
      if (interval) clearInterval(interval)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, projectId, pollInterval, runFetch])

  const refresh = useCallback(async () => {
    if (!key || !projectId) return
    await runFetch(key, projectId, true)
  }, [key, projectId, runFetch])

  return { data, isLoading, isFirstLoad, error, refresh }
}
