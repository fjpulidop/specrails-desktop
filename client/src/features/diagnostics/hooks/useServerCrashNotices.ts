import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { isTauri } from '../../../lib/tauri-shell'
import { acknowledgeCrashes, getCrashNotices, type CrashNotice } from '../lib/diagnostics-api'
import { startupQueue } from '../../../lib/startup-queue'

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

const RESTARTING_TOAST = 'local-server-restarting'

/**
 * Crashes of the local server the interface has not explained yet. Read when
 * the app starts and every time the shared WebSocket reconnects, which is when
 * a relaunched server is back. In the desktop app the host's
 * `specrails:backend-restarting` event shows a "restarting" toast meanwhile.
 */
export function useServerCrashNotices(connectionStatus: ConnectionStatus) {
  const { t } = useTranslation('diagnostics')
  const [notices, setNotices] = useState<CrashNotice[]>([])
  const request = useRef(0)
  const reported = useRef(false)

  const refresh = useCallback(() => {
    const id = ++request.current
    getCrashNotices()
      .then(list => {
        if (request.current !== id) return
        setNotices(list.notices)
        // The launch's first answer decides the startup queue (a later acknowledge must not un-defer the tour).
        if (!reported.current) { reported.current = true; startupQueue.report('crash', list.notices.length > 0) }
      })
      .catch(() => { /* the server is still coming back; the next reconnect retries */ })
  }, [])

  useEffect(() => {
    if (connectionStatus !== 'connected') return
    toast.dismiss(RESTARTING_TOAST)
    refresh()
  }, [connectionStatus, refresh])

  useEffect(() => {
    if (!isTauri()) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('specrails:backend-restarting', () => {
        toast.loading(t('restarting'), { id: RESTARTING_TOAST })
      }))
      .then(stop => { if (disposed) stop(); else unlisten = stop })
      .catch(() => { /* events unavailable: the status bar still shows the reconnect */ })
    return () => { disposed = true; unlisten?.() }
  }, [t])

  /** Mark every listed crash as explained (also hides it in other windows on their next read). */
  const acknowledge = useCallback(() => {
    const through = notices.reduce((max, notice) => Math.max(max, notice.atMs), 0)
    setNotices([])
    if (through > 0) void acknowledgeCrashes(through).catch(() => { /* shown again next start */ })
  }, [notices])

  return { notices, acknowledge }
}
