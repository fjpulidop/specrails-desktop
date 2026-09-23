import { useEffect, useState, useCallback, useRef } from 'react'
import { API_ORIGIN } from '../../../lib/origin'
import {
  defaultBootScope, type ContextScope, type SpecMode,
} from '../types/context-scope'

interface State {
  scope: ContextScope
  loaded: boolean
}

export function useContextScope(
  projectId: string | null,
  mode: SpecMode,
  enabled: boolean,
): {
  scope: ContextScope
  setScope: (updater: ContextScope | ((s: ContextScope) => ContextScope)) => void
  persist: (scope: ContextScope) => Promise<void>
  loaded: boolean
} {
  const [state, setState] = useState<State>({
    scope: defaultBootScope(mode),
    loaded: false,
  })
  const lastLoadKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !projectId) return
    const loadKey = `${projectId}:${mode}`
    if (lastLoadKeyRef.current === loadKey && state.loaded) return
    lastLoadKeyRef.current = loadKey
    let aborted = false
    ;(async () => {
      if (mode === 'quick') {
        if (!aborted) setState({ scope: defaultBootScope('quick'), loaded: true })
        return
      }
      let scope = defaultBootScope(mode)
      try {
        const r = await fetch(`${API_ORIGIN}/api/projects/${projectId}/context-scope-last`)
        if (r.ok) {
          const body = await r.json() as { scope?: ContextScope }
          if (body.scope) scope = { ...defaultBootScope(mode), ...body.scope }
        }
      } catch { /* ignore */ }
      if (!aborted) setState({ scope, loaded: true })
    })()
    return () => { aborted = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, enabled, mode])

  const setScope = useCallback((updater: ContextScope | ((s: ContextScope) => ContextScope)) => {
    setState((prev) => {
      const next = typeof updater === 'function' ? (updater as (s: ContextScope) => ContextScope)(prev.scope) : updater
      return { scope: next, loaded: prev.loaded }
    })
  }, [])

  const persist = useCallback(async (scope: ContextScope) => {
    if (!projectId) return
    try {
      await fetch(`${API_ORIGIN}/api/projects/${projectId}/context-scope-last`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope),
      })
    } catch { /* best-effort */ }
  }, [projectId])

  return { scope: state.scope, setScope, persist, loaded: state.loaded }
}
