import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from 'react'
import { getDesktopTokenProtocol, refreshDesktopToken } from '../lib/auth'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000]

interface SharedWebSocketContextValue {
  registerHandler: (id: string, fn: (msg: unknown) => void) => void
  unregisterHandler: (id: string) => void
  connectionStatus: ConnectionStatus
  // Desktop-level message types (desktop.*) are fanned out to ALL registered handlers.
  // Handlers that only care about project-scoped messages should filter by
  // msg.projectId to ignore cross-project messages.
}

export const SharedWebSocketContext = createContext<SharedWebSocketContextValue | null>(null)

export function SharedWebSocketProvider({ url, children }: { url: string; children: ReactNode }) {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const handlers = useRef(new Map<string, (msg: unknown) => void>())
  const wsRef = useRef<WebSocket | null>(null)
  const retryCountRef = useRef(0)
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let disposed = false
    let refreshing = false

    async function reconnect() {
      if (disposed || refreshing || wsRef.current) return
      refreshing = true
      // The sidecar may have started after bootstrap timed out or restarted
      // with a different credential. Never retry a cached missing/stale token
      // forever while the local API has already become healthy.
      try { await refreshDesktopToken() } finally { refreshing = false }
      if (!disposed && !wsRef.current) connect()
    }

    function scheduleReconnect() {
      if (disposed) return
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      const attempt = retryCountRef.current++
      setConnectionStatus('connecting')
      retryTimeoutRef.current = setTimeout(() => { void reconnect() }, BACKOFF_DELAYS[attempt] ?? 30000)
    }

    function connect() {
      if (disposed) return
      const protocol = getDesktopTokenProtocol()
      let ws: WebSocket
      try {
        ws = protocol ? new WebSocket(url, ['specrails-desktop', protocol]) : new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      wsRef.current = ws
      setConnectionStatus('connecting')

      ws.onopen = () => {
        if (disposed) { ws.close(); return }
        if (wsRef.current !== ws) return
        // Reset retry count on successful connection
        retryCountRef.current = 0
        setConnectionStatus('connected')
      }

      ws.onmessage = (event) => {
        if (disposed || wsRef.current !== ws) return
        let parsed: unknown
        try {
          parsed = JSON.parse(event.data as string)
        } catch {
          return
        }
        // Fan-out to all registered handlers. Each invocation is isolated in a
        // try/catch so one throwing handler never starves the later-registered
        // ones (the Map is insertion-ordered) — see BUG-CLIENT-01.
        for (const handler of handlers.current.values()) {
          try {
            handler(parsed)
          } catch (err) {
            console.error('[useSharedWebSocket] handler threw while processing message', err)
          }
        }
      }

      ws.onclose = () => {
        if (disposed || wsRef.current !== ws) return
        wsRef.current = null
        scheduleReconnect()
      }
    }

    const wake = () => {
      if (wsRef.current) return
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      void reconnect()
    }
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    connect()
    return () => {
      disposed = true
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current)
      const ws = wsRef.current
      wsRef.current = null
      if (!ws) return
      // Detach handlers so this (now-orphaned) socket stays silent — important
      // under React StrictMode's mount→unmount→mount cycle in dev.
      ws.onmessage = null
      ws.onclose = null
      ws.onerror = null
      if (ws.readyState === WebSocket.CONNECTING) {
        // Calling close() on a CONNECTING socket logs the noisy
        // "WebSocket is closed before the connection is established" warning.
        // Instead, close it cleanly once it finishes opening.
        ws.onopen = () => { try { ws.close() } catch { /* ignore */ } }
      } else {
        ws.onopen = null
        try { ws.close() } catch { /* ignore */ }
      }
    }
  }, [url])

  const registerHandler = useCallback((id: string, fn: (msg: unknown) => void) => {
    handlers.current.set(id, fn)
  }, [])

  const unregisterHandler = useCallback((id: string) => {
    handlers.current.delete(id)
  }, [])

  // Memoise the context value so consumers don't re-render every time the
  // provider re-renders — only when `connectionStatus` actually changes
  // (registerHandler / unregisterHandler are already stable via useCallback).
  const value = useMemo(
    () => ({ registerHandler, unregisterHandler, connectionStatus }),
    [registerHandler, unregisterHandler, connectionStatus],
  )

  return (
    <SharedWebSocketContext.Provider value={value}>
      {children}
    </SharedWebSocketContext.Provider>
  )
}

export function useSharedWebSocket(): SharedWebSocketContextValue {
  const ctx = useContext(SharedWebSocketContext)
  if (!ctx) throw new Error('useSharedWebSocket must be used within SharedWebSocketProvider')
  return ctx
}
