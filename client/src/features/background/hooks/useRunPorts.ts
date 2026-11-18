import { useCallback, useEffect, useRef, useState } from 'react'
import { getRunPorts, type RunPortsSnapshot } from '../lib/run-ports-api'

/** A port scan costs a couple of system calls: refresh slower than the resources table, and only while open. */
export const RUN_PORTS_POLL_MS = 5000

/** Listening ports of run worktrees, read only while the Resources popover is open. */
export function useRunPorts(open: boolean) {
  const [snapshot, setSnapshot] = useState<RunPortsSnapshot | null>(null)
  const controller = useRef<AbortController | null>(null)

  const refresh = useCallback(async () => {
    if (typeof document !== 'undefined' && document.hidden) return
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    try {
      const next = await getRunPorts(current.signal)
      if (!current.signal.aborted) setSnapshot(next)
    } catch {
      // Ports are a secondary view: a failed read keeps the last snapshot.
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, RUN_PORTS_POLL_MS)
    return () => { window.clearInterval(timer); controller.current?.abort() }
  }, [open, refresh])

  return { snapshot, refresh }
}
