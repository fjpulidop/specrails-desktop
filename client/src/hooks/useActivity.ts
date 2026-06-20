import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import i18n from '../lib/i18n'
import { getApiBase } from '../lib/api'
import { useSharedWebSocket } from './useSharedWebSocket'

export interface ActivityItem {
  id: string
  type: 'job_started' | 'job_completed' | 'job_failed' | 'job_canceled'
  jobId: string
  jobCommand: string
  timestamp: string
  summary: string
  costUsd: number | null
}

interface UseActivityOpts {
  activeProjectId: string | null
  limit?: number
}

interface UseActivityResult {
  items: ActivityItem[]
  loading: boolean
  hasMore: boolean
  loadMore: () => void
}

function dedupeItems(items: ActivityItem[]): ActivityItem[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.type}:${item.jobId}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function useActivity({ activeProjectId, limit = 50 }: UseActivityOpts): UseActivityResult {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)

  // Refs to avoid stale closures in WS handler
  const activeProjectIdRef = useRef(activeProjectId)
  useEffect(() => { activeProjectIdRef.current = activeProjectId }, [activeProjectId])

  const { registerHandler, unregisterHandler } = useSharedWebSocket()

  // Fetch initial page (or refresh on project switch)
  useEffect(() => {
    if (!activeProjectId) {
      setItems([])
      setHasMore(true)
      return
    }

    let cancelled = false
    setLoading(true)
    setItems([])
    setHasMore(true)

    async function fetchActivity() {
      const base = getApiBase()
      try {
        const res = await fetch(`${base}/activity?limit=${limit}`)
        if (!res.ok || cancelled) return
        const data = await res.json() as ActivityItem[]
        if (cancelled) return
        setItems(data)
        setHasMore(data.length === limit)
      } catch {
        // ignore
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    fetchActivity()
    return () => { cancelled = true }
  }, [activeProjectId, limit])

  // Load more (cursor pagination)
  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return
    setLoading(true)
    const base = getApiBase()
    // Pin the project this pagination belongs to; if the user switches before
    // the response lands, drop it so we don't splice project A's items into B.
    const requestProjectId = activeProjectIdRef.current
    try {
      setItems((prev) => {
        const oldest = prev[prev.length - 1]
        if (!oldest) return prev
        const before = encodeURIComponent(oldest.timestamp)

        fetch(`${base}/activity?limit=${limit}&before=${before}`)
          .then((res) => res.json())
          .then((data: ActivityItem[]) => {
            if (activeProjectIdRef.current !== requestProjectId) { setLoading(false); return }
            setItems((cur) => dedupeItems([...cur, ...data]))
            setHasMore(data.length === limit)
            setLoading(false)
          })
          .catch(() => setLoading(false))

        return prev
      })
    } catch {
      setLoading(false)
    }
  }, [loading, hasMore, limit])

  // Real-time updates via WebSocket
  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type?: string; projectId?: string; jobs?: Array<{ id: string; status: string; startedAt?: string | null; command?: string }>; phase?: string; state?: string; timestamp?: string }
    const currentProjectId = activeProjectIdRef.current
    if (!msg || typeof msg.type !== 'string') return
    if (msg.projectId && msg.projectId !== currentProjectId) return

    if (msg.type === 'queue' && Array.isArray(msg.jobs)) {
      // Synthesize activity items from job list changes
      const newItems: ActivityItem[] = []
      for (const job of msg.jobs) {
        const type: ActivityItem['type'] =
          job.status === 'completed' ? 'job_completed'
          : job.status === 'failed' ? 'job_failed'
          : job.status === 'canceled' ? 'job_canceled'
          : 'job_started'
        newItems.push({
          id: `${type}:${job.id}`,
          type,
          jobId: job.id,
          jobCommand: job.command ?? '',
          timestamp: job.startedAt ?? new Date().toISOString(),
          summary: `${type.replace('_', ' ')}: ${job.command ?? ''}`,
          costUsd: null,
        })
      }
      if (newItems.length > 0) {
        setItems((prev) => dedupeItems([...newItems, ...prev]))
      }
    }

    if (msg.type === 'phase' && msg.phase && msg.state && msg.timestamp) {
      const phaseItem: ActivityItem = {
        id: `phase:${msg.phase}:${msg.state}:${msg.timestamp}`,
        type: 'job_started', // phases always map to "started" visual
        jobId: `phase-${msg.phase}`,
        jobCommand: i18n.t('activity:feed.phaseCommand', { phase: msg.phase, state: msg.state }),
        timestamp: msg.timestamp,
        summary: `Phase ${msg.phase} is ${msg.state}`,
        costUsd: null,
      }
      setItems((prev) => dedupeItems([phaseItem, ...prev]))
    }
  }, [])

  useLayoutEffect(() => {
    registerHandler('activity', handleMessage)
    return () => unregisterHandler('activity')
  }, [handleMessage, registerHandler, unregisterHandler])

  return { items, loading, hasMore, loadMore }
}
