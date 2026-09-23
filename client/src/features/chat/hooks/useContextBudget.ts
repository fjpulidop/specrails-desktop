import { useEffect, useState, useRef } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import type { ContextBudget } from '../types/context-scope'

interface State {
  data: ContextBudget | null
  isError: boolean
}

export function useContextBudget(projectId: string | null, enabled: boolean): State {
  const [state, setState] = useState<State>({ data: null, isError: false })
  const lastProjectRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !projectId) return
    if (lastProjectRef.current === projectId && state.data) return
    lastProjectRef.current = projectId
    let aborted = false
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), 5000)
    fetch(`${API_ORIGIN}/api/projects/${projectId}/context-budget`, { signal: ac.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json() as Promise<ContextBudget>
      })
      .then((data) => {
        if (!aborted) setState({ data, isError: false })
      })
      .catch(() => {
        if (!aborted) setState({ data: null, isError: true })
      })
      .finally(() => clearTimeout(timeout))
    return () => {
      aborted = true
      ac.abort()
      clearTimeout(timeout)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled])

  return state
}
