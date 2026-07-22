import { useCallback, useContext, useEffect, useState } from 'react'
import { API_ORIGIN } from '../lib/origin'
import { SharedWebSocketContext } from './useSharedWebSocket'

export type AssembleStatus = 'assembling' | 'failed' | 'ready'

interface ProjectAssembleState {
  running: Set<string>
  failed: Set<string>
}

export interface AssembleProgressState {
  /** Aggregated status per project id. Absent = never observed = ready. */
  statusFor: (projectId: string) => AssembleStatus
  /** Re-run the assemble for the failed providers of a project. */
  retry: (projectId: string) => Promise<void>
}

/**
 * Tracks the silent-add `project.assemble_progress` WS events
 * ({projectId, provider, status}) and aggregates them per project for the
 * project card's subtle indicator (silent-project-add spec). No polling —
 * a project with no observed events reads as 'ready'.
 */
export function useAssembleProgress(): AssembleProgressState {
  const [byProject, setByProject] = useState<Map<string, ProjectAssembleState>>(new Map())
  const ws = useContext(SharedWebSocketContext)

  useEffect(() => {
    if (!ws) return
    const handler = (raw: unknown) => {
      const msg = raw as { type?: string; projectId?: string; provider?: string; status?: string }
      if (msg.type !== 'project.assemble_progress') return
      if (typeof msg.projectId !== 'string' || typeof msg.provider !== 'string') return
      const { projectId, provider, status } = msg
      setByProject((prev) => {
        const next = new Map(prev)
        const entry: ProjectAssembleState = next.get(projectId)
          ? { running: new Set(next.get(projectId)!.running), failed: new Set(next.get(projectId)!.failed) }
          : { running: new Set(), failed: new Set() }
        if (status === 'running') {
          entry.running.add(provider)
          entry.failed.delete(provider)
        } else if (status === 'done') {
          entry.running.delete(provider)
          entry.failed.delete(provider)
        } else if (status === 'failed') {
          entry.running.delete(provider)
          entry.failed.add(provider)
        }
        next.set(projectId, entry)
        return next
      })
    }
    ws.registerHandler('assemble-progress', handler)
    return () => ws.unregisterHandler('assemble-progress')
  }, [ws])

  const statusFor = useCallback((projectId: string): AssembleStatus => {
    const entry = byProject.get(projectId)
    if (!entry) return 'ready'
    if (entry.running.size > 0) return 'assembling'
    if (entry.failed.size > 0) return 'failed'
    return 'ready'
  }, [byProject])

  const retry = useCallback(async (projectId: string): Promise<void> => {
    await fetch(`${API_ORIGIN}/api/projects/${projectId}/assemble-retry`, { method: 'POST' })
  }, [])

  return { statusFor, retry }
}
