import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type Context } from 'react'
import { useProjectCache } from './useProjectCache'
import * as sharedWs from './useSharedWebSocket'

type WsContextValue = { registerHandler: (id: string, fn: (msg: unknown) => void) => void; unregisterHandler: (id: string) => void } | null

// Many suites mock the WS module with only `useSharedWebSocket` exported, and a
// vitest strict mock THROWS on access to a missing export — so the context is
// resolved defensively: no export ⇒ an inert context ⇒ no live tap, never a crash.
const NO_WS_CONTEXT = createContext<WsContextValue>(null)
function resolveWsContext(): Context<WsContextValue> {
  try {
    const ctx = (sharedWs as { SharedWebSocketContext?: Context<WsContextValue> }).SharedWebSocketContext
    return ctx ?? NO_WS_CONTEXT
  } catch {
    return NO_WS_CONTEXT
  }
}
const wsContext = resolveWsContext()
import { coerceBlueprint, type Blueprint } from '../lib/blueprint-draft'
import { coerceMilestoneProgress, stackedHeadDeliveryIds, type MilestoneProgress } from '../lib/milestone-progress'

// Live milestone progress for one project (premium-milestone-progress D5):
// the server-derived model from `GET /blueprint`, kept live by the
// `blueprint.milestone_progress` broadcast (filtered by projectId through a
// ref — never a stale closure). Cached per project (stale-while-revalidate)
// so a project switch paints the last known progress instantly.

export interface MilestoneProgressData {
  blueprint: Blueprint | null
  progress: MilestoneProgress[]
}

export interface UseMilestoneProgressResult {
  blueprint: Blueprint | null
  progress: MilestoneProgress[]
  /** null while unknown (first load), false = the project has no blueprint. */
  hasBlueprint: boolean | null
  loading: boolean
  refresh: () => Promise<void>
}

let handlerSeq = 0

export function useMilestoneProgress(projectId: string | null): UseMilestoneProgressResult {
  // Null-safe: the decision surfaces (rail strip, agent card, review packet)
  // read the stacked-head set from here and some of them render outside the
  // shared WS provider (tests, isolated mounts) — no provider ⇒ no live tap.
  const ws = useContext(wsContext)
  const { data, isLoading, refresh } = useProjectCache<MilestoneProgressData | null>({
    namespace: 'milestone-progress',
    projectId,
    initialValue: null,
    fetcher: async ({ projectId: id, signal }) => {
      const res = await fetch(`/api/projects/${id}/blueprint`, { cache: 'no-store', signal })
      if (res.status === 404) return { blueprint: null, progress: [] }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { blueprint?: unknown; progress?: unknown }
      return { blueprint: coerceBlueprint(body.blueprint), progress: coerceMilestoneProgress(body.progress) }
    },
  })

  // Live overlay from the broadcast — reset whenever the project changes so a
  // previous project's frame can never paint over the new one.
  const [live, setLive] = useState<{ projectId: string; progress: MilestoneProgress[] } | null>(null)
  const projectIdRef = useRef(projectId)
  useEffect(() => { projectIdRef.current = projectId; setLive(null) }, [projectId])

  useEffect(() => {
    if (!ws) return
    const { registerHandler, unregisterHandler } = ws
    const id = `milestone-progress:${++handlerSeq}`
    registerHandler(id, (raw: unknown) => {
      const msg = raw as { type?: string; projectId?: string; progress?: unknown } | null
      if (!msg || msg.type !== 'blueprint.milestone_progress') return
      if (!msg.projectId || msg.projectId !== projectIdRef.current) return
      setLive({ projectId: msg.projectId, progress: coerceMilestoneProgress(msg.progress) })
    })
    return () => unregisterHandler(id)
  }, [ws])

  const progress = useMemo(() => {
    if (live && live.projectId === projectId) return live.progress
    return data?.progress ?? []
  }, [live, projectId, data])

  const hasBlueprint: boolean | null = data === null ? null : data.blueprint !== null

  const doRefresh = useCallback(async () => { setLive(null); await refresh() }, [refresh])

  return { blueprint: data?.blueprint ?? null, progress, hasBlueprint, loading: isLoading, refresh: doRefresh }
}

/** Delivery ids a later sequential chunk was stacked on — the decision
 *  surfaces warn before discarding one of these (its chain pauses). */
export function useStackedHeadDeliveryIds(projectId: string | null): Set<string> {
  const { progress } = useMilestoneProgress(projectId)
  return useMemo(() => stackedHeadDeliveryIds(progress), [progress])
}
