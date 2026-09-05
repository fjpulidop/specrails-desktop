import { useEffect, useRef, useState } from 'react'
import { getDesktopTokenProtocol, refreshDesktopToken } from '../lib/auth'

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000]

export function useWebSocket(
  url: string,
  onMessage: (data: unknown) => void
): { connectionStatus: ConnectionStatus } {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('connecting')
  const onMessageRef = useRef(onMessage)
  onMessageRef.current = onMessage

  useEffect(() => {
    // Keep transport ownership inside this effect generation. A token refresh
    // completing after unmount, StrictMode cleanup or a URL change must never
    // recreate the old connection or replace the new generation's socket.
    let disposed = false
    let refreshing = false
    let current: WebSocket | null = null
    let retries = 0
    let retryTimeout: ReturnType<typeof setTimeout> | null = null

    async function reconnect() {
      if (disposed || refreshing || current) return
      refreshing = true
      try { await refreshDesktopToken() } catch { /* transient auth failure: socket retry remains recoverable */ }
      finally { refreshing = false }
      if (!disposed && !current) connect()
    }

    function scheduleReconnect() {
      if (disposed) return
      if (retryTimeout !== null) clearTimeout(retryTimeout)
      setConnectionStatus('connecting')
      const delay = BACKOFF_DELAYS[retries++] ?? 30000
      retryTimeout = setTimeout(() => {
        retryTimeout = null
        void reconnect()
      }, delay)
    }

    function connect() {
      if (disposed || current) return
      const protocol = getDesktopTokenProtocol()
      let ws: WebSocket
      try {
        ws = protocol ? new WebSocket(url, ['specrails-desktop', protocol]) : new WebSocket(url)
      } catch {
        scheduleReconnect()
        return
      }
      current = ws
      setConnectionStatus('connecting')

      ws.onopen = () => {
        if (disposed || current !== ws) return
        retries = 0
        setConnectionStatus('connected')
      }

      ws.onmessage = (event) => {
        if (disposed || current !== ws) return
        try {
          onMessageRef.current(JSON.parse(event.data as string))
        } catch {
          // Ignore malformed messages without breaking the connection.
        }
      }

      ws.onclose = () => {
        if (disposed || current !== ws) return
        current = null
        scheduleReconnect()
      }
    }

    const wake = () => {
      if (disposed || current) return
      if (retryTimeout !== null) clearTimeout(retryTimeout)
      retryTimeout = null
      void reconnect()
    }
    window.addEventListener('online', wake)
    window.addEventListener('focus', wake)
    connect()
    return () => {
      disposed = true
      window.removeEventListener('online', wake)
      window.removeEventListener('focus', wake)
      if (retryTimeout !== null) clearTimeout(retryTimeout)
      const ws = current
      current = null
      if (ws) {
        // B24: detach handlers BEFORE close(). Otherwise this intentional close
        // fires ws.onclose, which schedules a setTimeout(connect) reconnect after
        // the component has unmounted — a leaked ghost socket. StrictMode's
        // mount→unmount→mount double-invoke triggers this on every mount.
        ws.onopen = null
        ws.onmessage = null
        ws.onclose = null
        ws.onerror = null
        try { ws.close() } catch { /* already closed by the browser */ }
      }
    }
  }, [url])

  return { connectionStatus }
}
