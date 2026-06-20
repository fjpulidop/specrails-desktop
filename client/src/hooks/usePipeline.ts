import { useState, useCallback, useLayoutEffect, useRef, useEffect } from 'react'
import { useSharedWebSocket } from './useSharedWebSocket'
import type { JobSummary, PhaseDefinition, JobPriority } from '../types'
import { getApiBase } from '../lib/api'

export type PhaseState = 'idle' | 'running' | 'done' | 'error'
export type PhaseMap = Record<string, PhaseState>

export interface LogLine {
  source: 'stdout' | 'stderr'
  line: string
  timestamp: string
  processId: string
}

export interface QueueJob {
  id: string
  command: string
  status: 'queued' | 'running' | 'completed' | 'failed' | 'canceled' | 'zombie_terminated' | 'skipped'
  queuePosition: number | null
  priority: JobPriority
  startedAt: string | null
  finishedAt: string | null
  exitCode: number | null
  dependsOnJobId: string | null
  pipelineId: string | null
  skipReason: string | null
}

export interface QueueState {
  jobs: QueueJob[]
  activeJobId: string | null
  paused: boolean
}

const INITIAL_QUEUE: QueueState = {
  jobs: [],
  activeJobId: null,
  paused: false,
}

export function usePipeline(activeProjectId?: string | null) {
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [projectName, setProjectName] = useState('')
  const [logLines, setLogLines] = useState<LogLine[]>([])
  const [recentJobs, setRecentJobs] = useState<JobSummary[]>([])
  const [queueState, setQueueState] = useState<QueueState>(INITIAL_QUEUE)

  // Keep a ref to activeProjectId so the WS handler always sees the latest value
  const activeProjectRef = useRef(activeProjectId)
  activeProjectRef.current = activeProjectId

  // Per-project cache to avoid flicker on tab switch
  interface PipelineSnapshot {
    phaseDefinitions: PhaseDefinition[]
    phases: PhaseMap
    projectName: string
    recentJobs: JobSummary[]
    queueState: QueueState
  }
  const cacheRef = useRef<Map<string, PipelineSnapshot>>(new Map())
  const prevProjectRef = useRef<string | null | undefined>(undefined)

  // On project switch: save outgoing, restore incoming
  useEffect(() => {
    // Save outgoing project state
    if (prevProjectRef.current && prevProjectRef.current !== activeProjectId) {
      // We can't read state directly in useEffect, so we save on each update instead (see below)
    }
    prevProjectRef.current = activeProjectId

    // Restore incoming project state from cache
    if (activeProjectId) {
      const cached = cacheRef.current.get(activeProjectId)
      if (cached) {
        setPhaseDefinitions(cached.phaseDefinitions)
        setPhases(cached.phases)
        setProjectName(cached.projectName)
        setRecentJobs(cached.recentJobs)
        setQueueState(cached.queueState)
      } else {
        setPhaseDefinitions([])
        setPhases({})
        setProjectName('')
        setRecentJobs([])
        setQueueState(INITIAL_QUEUE)
      }
    }
    // Always clear logs on switch (too large to cache)
    setLogLines([])
  }, [activeProjectId])

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string; projectId?: string } & Record<string, unknown>

    // Filter: only process messages for the active project
    const currentProjectId = activeProjectRef.current
    if (currentProjectId && msg.projectId && msg.projectId !== currentProjectId) {
      return
    }

    if (msg.type === 'init') {
      const name = (msg.projectName as string) ?? ''
      const defs = (msg.phaseDefinitions ?? []) as PhaseDefinition[]
      const initialPhases: PhaseMap = {}
      for (const def of defs) {
        initialPhases[def.key] = ((msg.phases as Record<string, PhaseState>)?.[def.key]) ?? 'idle'
      }
      const jobs = (msg.recentJobs as JobSummary[]) ?? []
      const q = (msg.queue as QueueState) ?? INITIAL_QUEUE

      setProjectName(name)
      setPhaseDefinitions(defs)
      setPhases(initialPhases)
      setLogLines((msg.logBuffer as LogLine[]) ?? [])
      setRecentJobs(jobs)
      setQueueState(q)

      // Cache for instant restore on tab switch
      if (currentProjectId) {
        cacheRef.current.set(currentProjectId, {
          phaseDefinitions: defs, phases: initialPhases,
          projectName: name, recentJobs: jobs, queueState: q,
        })
      }
    } else if (msg.type === 'phase') {
      setPhases((prev) => ({
        ...prev,
        [msg.phase as string]: msg.state as PhaseState,
      }))
    } else if (msg.type === 'log') {
      setLogLines((prev) => [
        ...prev,
        {
          source: msg.source as 'stdout' | 'stderr',
          line: msg.line as string,
          timestamp: msg.timestamp as string,
          processId: msg.processId as string,
        },
      ])
    } else if (msg.type === 'queue') {
      setQueueState({
        jobs: (msg.jobs as QueueJob[]) ?? [],
        activeJobId: (msg.activeJobId as string | null) ?? null,
        paused: (msg.paused as boolean) ?? false,
      })
    }
  }, [])

  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()

  useLayoutEffect(() => {
    registerHandler('pipeline', handleMessage)
    return () => unregisterHandler('pipeline')
  }, [handleMessage, registerHandler, unregisterHandler])

  // Fetch initial state for this project via REST (WS init only fires on connect)
  useEffect(() => {
    if (!activeProjectId) return
    // Guard against a project switch resolving an in-flight fetch into the wrong
    // project: A's /state could land after the user switched to B and overwrite
    // B's live state. Bail on resolve if this effect was cleaned up.
    let cancelled = false
    async function fetchState() {
      try {
        const res = await fetch(`${getApiBase()}/state`)
        if (cancelled || !res.ok) return
        const msg = await res.json()
        if (cancelled) return
        if (msg.projectName) setProjectName(msg.projectName)
        if (msg.phaseDefinitions) {
          setPhaseDefinitions(msg.phaseDefinitions)
          const initialPhases: PhaseMap = {}
          for (const def of msg.phaseDefinitions as PhaseDefinition[]) {
            initialPhases[def.key] = msg.phases?.[def.key] ?? 'idle'
          }
          setPhases(initialPhases)
        }
        if (msg.recentJobs) setRecentJobs(msg.recentJobs)
        if (msg.queue) setQueueState(msg.queue)
      } catch {
        // ignore — state endpoint may not exist in Super mode
      }
    }
    fetchState()
    return () => { cancelled = true }
  }, [activeProjectId])

  return { phases, phaseDefinitions, projectName, logLines, connectionStatus, recentJobs, queueState }
}
