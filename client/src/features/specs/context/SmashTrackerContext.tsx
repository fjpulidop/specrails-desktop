/**
 * SPECs SMASH WS tracker.
 *
 * Listens for `smash.started|progress|completed|failed|undone` events and:
 *   - Exposes per-ticket "inflight" state for the modal pills via
 *     `useSmashInflight(ticketId)`.
 *   - Surfaces success toast with `Deshacer` action + failure toast with
 *     `Reintentar` action.
 *
 * Mounted at App root, sibling of `ContractRefineTrackerProvider`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'

import i18n from '../../../lib/i18n'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { API_ORIGIN } from '../../../lib/origin'

export type SmashStage = 'analyzing' | 'identifying' | 'ordering'

const STAGE_LABEL_KEY: Record<SmashStage, string> = {
  analyzing: 'activity:smash.stage.analyzing',
  identifying: 'activity:smash.stage.identifying',
  ordering: 'activity:smash.stage.ordering',
}

export interface SmashInflight {
  ticketId: number
  runId: string
  stage: SmashStage
  startedAt: string
  ticketTitle?: string
}

interface SmashTrackerContextValue {
  inflight: Record<number, SmashInflight>
}

const SmashTrackerContext = createContext<SmashTrackerContextValue | null>(null)

function toastIdFor(ticketId: number | string): string {
  return `smash:${ticketId}`
}

async function fireRetry(projectId: string, ticketId: number): Promise<void> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ticketId}/smash`, {
      method: 'POST',
    })
    if (res.ok) {
      toast.loading(i18n.t('activity:smash.retrying'), { id: toastIdFor(ticketId) })
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string; reason?: string }
      toast.error(
        body.reason
          ? i18n.t('activity:smash.couldNotRetryWithReason', { reason: body.reason })
          : i18n.t('activity:smash.couldNotRetry'),
        { id: toastIdFor(ticketId) },
      )
    }
  } catch (err) {
    toast.error(i18n.t('activity:smash.retryFailed', { message: (err as Error).message }), { id: toastIdFor(ticketId) })
  }
}

async function fireUndo(
  projectId: string,
  ticketId: number,
  smashedAt: string,
): Promise<void> {
  try {
    const res = await fetch(`${API_ORIGIN}/api/projects/${projectId}/tickets/${ticketId}/smash/undo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smashedAt }),
    })
    if (res.ok) {
      toast.success(i18n.t('activity:smash.undone'), { id: toastIdFor(ticketId), duration: 3000 })
    } else {
      const body = await res.json().catch(() => ({})) as { error?: string; reason?: string }
      toast.error(
        body.reason
          ? i18n.t('activity:smash.undoFailedWithReason', { reason: body.reason })
          : i18n.t('activity:smash.undoFailed'),
        { id: toastIdFor(ticketId) },
      )
    }
  } catch (err) {
    toast.error(i18n.t('activity:smash.undoFailedWithReason', { reason: (err as Error).message }), { id: toastIdFor(ticketId) })
  }
}

export function SmashTrackerProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const [inflight, setInflight] = useState<Record<number, SmashInflight>>({})
  const projectByTicketRef = useRef<Map<number, string>>(new Map())
  const smashedAtByRunRef = useRef<Map<string, string>>(new Map())

  const handleStarted = useCallback((raw: unknown) => {
    const m = raw as Record<string, unknown>
    if (!m || m.type !== 'smash.started') return
    const ticketId = m.ticketId as number | undefined
    const runId = m.runId as string | undefined
    const projectId = m.projectId as string | undefined
    const ts = m.timestamp as string | undefined
    const ticketTitle = m.ticketTitle as string | undefined
    if (typeof ticketId !== 'number' || !runId || !projectId) return
    projectByTicketRef.current.set(ticketId, projectId)
    setInflight((s) => ({
      ...s,
      [ticketId]: { ticketId, runId, stage: 'analyzing', startedAt: ts ?? new Date().toISOString(), ticketTitle },
    }))
    toast.loading(i18n.t(STAGE_LABEL_KEY.analyzing), {
      id: toastIdFor(ticketId),
      description: ticketTitle
        ? i18n.t('activity:smash.onTitled', { title: ticketTitle })
        : i18n.t('activity:smash.onThisSpec'),
    })
  }, [])

  const handleProgress = useCallback((raw: unknown) => {
    const m = raw as Record<string, unknown>
    if (!m || m.type !== 'smash.progress') return
    const ticketId = m.ticketId as number | undefined
    const stage = m.stage as SmashStage | undefined
    if (typeof ticketId !== 'number' || !stage) return
    let title: string | undefined
    setInflight((s) => {
      const cur = s[ticketId]
      if (!cur) return s
      title = cur.ticketTitle
      return { ...s, [ticketId]: { ...cur, stage } }
    })
    toast.loading(i18n.t(STAGE_LABEL_KEY[stage]), {
      id: toastIdFor(ticketId),
      description: title
        ? i18n.t('activity:smash.onTitled', { title })
        : i18n.t('activity:smash.onThisSpec'),
    })
  }, [])

  const handleCompleted = useCallback((raw: unknown) => {
    const m = raw as Record<string, unknown>
    if (!m || m.type !== 'smash.completed') return
    const ticketId = m.ticketId as number | undefined
    const runId = m.runId as string | undefined
    const projectId = m.projectId as string | undefined
    const smashedAt = m.smashedAt as string | undefined
    const childrenIds = m.childrenIds as number[] | undefined
    if (typeof ticketId !== 'number' || !runId || !projectId || !smashedAt || !childrenIds) return
    smashedAtByRunRef.current.set(runId, smashedAt)
    setInflight((s) => {
      const next = { ...s }
      delete next[ticketId]
      return next
    })
    toast.success(i18n.t('activity:smash.split', { count: childrenIds.length }), {
      id: toastIdFor(ticketId),
      duration: 10_000,
      action: {
        label: i18n.t('activity:smash.undoAction'),
        onClick: () => void fireUndo(projectId, ticketId, smashedAt),
      },
    })
  }, [])

  const handleFailed = useCallback((raw: unknown) => {
    const m = raw as Record<string, unknown>
    if (!m || m.type !== 'smash.failed') return
    const ticketId = m.ticketId as number | undefined
    const projectId = m.projectId as string | undefined
    const reason = (m.reason as string | undefined) ?? 'unknown'
    if (typeof ticketId !== 'number' || !projectId) return
    projectByTicketRef.current.set(ticketId, projectId)
    setInflight((s) => {
      const next = { ...s }
      delete next[ticketId]
      return next
    })
    const human =
      reason === 'invalid-output' ? i18n.t('activity:smash.failReason.invalidOutput') :
      reason === 'timeout' ? i18n.t('activity:smash.failReason.timeout') :
      reason === 'model_error' ? i18n.t('activity:smash.failReason.modelError') :
      reason === 'crashed' ? i18n.t('activity:smash.failReason.crashed') :
      i18n.t('activity:smash.failReason.generic', { reason })
    toast.error(i18n.t('activity:smash.couldNotComplete'), {
      id: toastIdFor(ticketId),
      description: human,
      action: {
        label: i18n.t('common:actions.retry'),
        onClick: () => void fireRetry(projectId, ticketId),
      },
      duration: 15_000,
    })
  }, [])

  const handleUndone = useCallback((raw: unknown) => {
    const m = raw as Record<string, unknown>
    if (!m || m.type !== 'smash.undone') return
    const ticketId = m.ticketId as number | undefined
    if (typeof ticketId !== 'number') return
    toast.dismiss(toastIdFor(ticketId))
    toast.success(i18n.t('activity:smash.undone'), { id: toastIdFor(ticketId), duration: 3000 })
  }, [])

  useLayoutEffect(() => {
    registerHandler('_smash_started', handleStarted)
    registerHandler('_smash_progress', handleProgress)
    registerHandler('_smash_completed', handleCompleted)
    registerHandler('_smash_failed', handleFailed)
    registerHandler('_smash_undone', handleUndone)
    return () => {
      unregisterHandler('_smash_started')
      unregisterHandler('_smash_progress')
      unregisterHandler('_smash_completed')
      unregisterHandler('_smash_failed')
      unregisterHandler('_smash_undone')
    }
  }, [registerHandler, unregisterHandler, handleStarted, handleProgress, handleCompleted, handleFailed, handleUndone])

  useEffect(() => () => {
    projectByTicketRef.current.clear()
    smashedAtByRunRef.current.clear()
  }, [])

  const value = useMemo(() => ({ inflight }), [inflight])

  return <SmashTrackerContext.Provider value={value}>{children}</SmashTrackerContext.Provider>
}

export function useSmashInflight(ticketId: number | null | undefined): SmashInflight | null {
  const ctx = useContext(SmashTrackerContext)
  if (!ctx || ticketId == null) return null
  return ctx.inflight[ticketId] ?? null
}

export function useIsSmashing(ticketId: number | null | undefined): boolean {
  return useSmashInflight(ticketId) !== null
}
