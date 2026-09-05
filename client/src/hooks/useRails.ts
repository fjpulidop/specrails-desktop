import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import i18n from '../lib/i18n'
import { getApiBase } from '../lib/api'
import { useSharedWebSocket } from './useSharedWebSocket'
import { useDesktop } from './useDesktop'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RailState {
  railIndex: number
  ticketIds: number[]
  mode: string
}

interface RailWsMessage {
  type: 'rail.job_started' | 'rail.job_stopped' | 'rail.job_completed' | 'desktop.project_recovered'
  projectId?: string
  railIndex: number
  jobId: string
  mode?: string
  status?: string
}

export interface RailJobInfo {
  jobId: string
  mode: string
  status: 'running' | 'stopped' | 'completed' | 'failed'
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useRails() {
  const { activeProjectId } = useDesktop()
  const [rails, setRails] = useState<RailState[]>([
    { railIndex: 0, ticketIds: [], mode: 'implement' },
    { railIndex: 1, ticketIds: [], mode: 'implement' },
    { railIndex: 2, ticketIds: [], mode: 'implement' },
  ])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeRailJobs, setActiveRailJobs] = useState<Map<number, RailJobInfo>>(new Map())

  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // ── Fetch rails from API ──────────────────────────────────────────────────

  const fetchRails = useCallback(async (signal?: AbortSignal): Promise<RailState[]> => {
    const base = getApiBase()
    const res = await fetch(`${base}/rails`, { signal })
    if (!res.ok) throw new Error(i18n.t('dashboard:useRails.fetchFailed', { status: res.status }))
    const data = (await res.json()) as { rails: RailState[] }
    return data.rails
  }, [])

  // ── Refetch ───────────────────────────────────────────────────────────────

  const refetch = useCallback(() => {
    const projectId = activeProjectIdRef.current
    if (!projectId) return
    fetchRails()
      .then((fetched) => {
        if (activeProjectIdRef.current !== projectId) return
        setRails(fetched)
        setError(null)
      })
      .catch((err) => {
        if (activeProjectIdRef.current !== projectId) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError((err as Error).message)
      })
  }, [fetchRails])

  // ── Load on project switch ────────────────────────────────────────────────

  useEffect(() => {
    if (!activeProjectId) {
      setRails([
        { railIndex: 0, ticketIds: [], mode: 'implement' },
        { railIndex: 1, ticketIds: [], mode: 'implement' },
        { railIndex: 2, ticketIds: [], mode: 'implement' },
      ])
      setError(null)
      setActiveRailJobs(new Map())
      return
    }

    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchRails(controller.signal)
      .then((fetched) => { if (!cancelled) setRails(fetched) })
      .catch((err) => {
        if (cancelled) return
        if (err instanceof DOMException && err.name === 'AbortError') return
        setError((err as Error).message)
      })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [activeProjectId, fetchRails])

  // ── WS message handler ────────────────────────────────────────────────────

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as RailWsMessage
    if (!msg || typeof msg.type !== 'string') return

    const currentProjectId = activeProjectIdRef.current
    if (msg.projectId && msg.projectId !== currentProjectId) return
    if (msg.type === 'desktop.project_recovered') {
      if (msg.projectId === currentProjectId) refetch()
      return
    }
    if (!msg.type.startsWith('rail.')) return

    switch (msg.type) {
      case 'rail.job_started':
        setActiveRailJobs((prev) => {
          const next = new Map(prev)
          next.set(msg.railIndex, {
            jobId: msg.jobId,
            mode: msg.mode ?? 'implement',
            status: 'running',
          })
          return next
        })
        break
      case 'rail.job_stopped':
        setActiveRailJobs((prev) => {
          const next = new Map(prev)
          next.delete(msg.railIndex)
          return next
        })
        break
      case 'rail.job_completed':
        setActiveRailJobs((prev) => {
          const next = new Map(prev)
          const existing = next.get(msg.railIndex)
          if (existing && existing.jobId === msg.jobId) {
            if (msg.status === 'canceled') {
              // Canceled — remove from active rails entirely (same as stopped)
              next.delete(msg.railIndex)
            } else {
              next.set(msg.railIndex, {
                ...existing,
                status: msg.status === 'completed' ? 'completed' : 'failed',
              })
            }
          }
          return next
        })
        break
    }
  }, [refetch])

  useLayoutEffect(() => {
    registerHandler('rails', handleMessage)
    return () => unregisterHandler('rails')
  }, [handleMessage, registerHandler, unregisterHandler])

  // ── Mutations ─────────────────────────────────────────────────────────────

  const assignTickets = useCallback(
    async (railIndex: number, ticketIds: number[]): Promise<boolean> => {
      const res = await fetch(`${getApiBase()}/rails/${railIndex}/tickets`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticketIds }),
      })
      if (res.ok) refetch()
      return res.ok
    },
    [refetch]
  )

  const launchRail = useCallback(
    async (railIndex: number, mode: 'implement' | 'batch-implement' | 'freestyle'): Promise<string | null> => {
      const res = await fetch(`${getApiBase()}/rails/${railIndex}/launch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as { jobId: string }
      return data.jobId
    },
    []
  )

  const stopRail = useCallback(
    async (railIndex: number): Promise<boolean> => {
      const res = await fetch(`${getApiBase()}/rails/${railIndex}/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
      return res.ok
    },
    []
  )

  return {
    rails,
    loading,
    error,
    activeRailJobs,
    refetch,
    assignTickets,
    launchRail,
    stopRail,
  }
}
