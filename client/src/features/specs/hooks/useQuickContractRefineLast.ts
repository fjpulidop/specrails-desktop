import { useCallback, useEffect, useState } from 'react'
import { API_ORIGIN } from '../../../lib/origin'

export function useQuickContractRefineLast(
  projectId: string | null,
  enabled: boolean,
): {
  value: boolean
  setValue: (next: boolean) => void
  loaded: boolean
  persist: (next: boolean) => Promise<void>
} {
  const [value, setValue] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!enabled || !projectId) return
    let aborted = false
    ;(async () => {
      let next = false
      try {
        const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/add-spec-quick-contract-refine-last`)
        if (res.ok) {
          const body = await res.json() as { enabled?: boolean; configured?: boolean }
          if (body.configured === true || body.configured === undefined) next = body.enabled === true
        }
      } catch { /* best effort */ }

      if (!aborted) {
        setValue(next)
        setLoaded(true)
      }
    })()
    return () => { aborted = true }
  }, [projectId, enabled])

  const persist = useCallback(async (next: boolean) => {
    if (!projectId) return
    await fetch(`${API_ORIGIN}/api/projects/${projectId}/add-spec-quick-contract-refine-last`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    })
  }, [projectId])

  return { value, setValue, loaded, persist }
}
