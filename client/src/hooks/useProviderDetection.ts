import { useContext, useEffect, useState } from 'react'
import { API_ORIGIN } from '../lib/origin'
import { SharedWebSocketContext } from './useSharedWebSocket'

export type ProviderAuthState = 'authenticated' | 'unauthenticated' | 'unknown'

export interface DetectedProviderInfo {
  id: string
  displayName: string
  installed: boolean
  executable: boolean
  version?: string
  authState: ProviderAuthState
  usable: boolean
  error?: string
}

export interface ProviderDetectionState {
  /** Usable provider ids (detected ∩ non-vetoed). Empty while loading. */
  detected: string[]
  providers: Record<string, DetectedProviderInfo>
  loading: boolean
}

/**
 * App-level provider detection snapshot (machine property — see
 * server/provider-detection.ts). Fetches once on mount and converges on the
 * `providers.detected_changed` app-global WS broadcast. Focus-refresh lives in
 * DesktopProvider, so this hook never spawns probe traffic itself.
 */
export function useProviderDetection(): ProviderDetectionState {
  const [state, setState] = useState<ProviderDetectionState>({
    detected: [],
    providers: {},
    loading: true,
  })
  // Optional context: unit tests render selectors without the WS provider —
  // the hook then simply skips live updates instead of throwing.
  const ws = useContext(SharedWebSocketContext)

  useEffect(() => {
    let alive = true
    fetch(`${API_ORIGIN}/api/providers/detected`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { detected?: string[]; providers?: Record<string, DetectedProviderInfo> } | null) => {
        if (!alive || !data) return
        setState({
          detected: Array.isArray(data.detected) ? data.detected : [],
          providers: data.providers ?? {},
          loading: false,
        })
      })
      .catch(() => {
        if (alive) setState((prev) => ({ ...prev, loading: false }))
      })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const handler = (raw: unknown) => {
      const msg = raw as { type?: string; detected?: string[]; providers?: Record<string, DetectedProviderInfo> }
      if (msg.type !== 'providers.detected_changed') return
      setState({
        detected: Array.isArray(msg.detected) ? msg.detected : [],
        providers: msg.providers ?? {},
        loading: false,
      })
    }
    if (!ws) return
    ws.registerHandler('provider-detection', handler)
    return () => ws.unregisterHandler('provider-detection')
  }, [ws])

  return state
}
