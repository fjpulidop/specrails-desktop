import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import type { BackgroundProcess } from '../types'
import { backgroundProcessKey, listBackgroundProcesses, stopBackgroundProcess } from '../lib/background-processes-api'
import { useAgentChat } from './AgentChatContext'
import { useDesktop } from '../hooks/useDesktop'

export interface BackgroundProcessView extends BackgroundProcess { stopError?: string }
interface BackgroundProcessesContextValue {
  processes: BackgroundProcessView[]
  history: BackgroundProcessView[]
  historyLoading: boolean
  historyError: string | null
  refreshHistory: () => Promise<void>
  /** Prefer the snapshot so a reused PID cannot target another execution. */
  kill: (process: BackgroundProcess | number) => Promise<void>
}
const BackgroundProcessesContext = createContext<BackgroundProcessesContextValue | null>(null)
const terminal = new Set(['exited', 'killed', 'failed', 'interrupted'])
export const BACKGROUND_TERMINAL_RETENTION_MS = 120_000
export const BACKGROUND_STOP_CONFIRMATION_MS = 15_000
type ProcessRecord = BackgroundProcessView & { completedAt?: number }

export function BackgroundProcessesProvider({ children }: { children: ReactNode }) {
  const { registerHandler, unregisterHandler, connectionStatus } = useSharedWebSocket()
  const { active, draftPinnedProjectId } = useAgentChat()
  const { activeProjectId } = useDesktop()
  const projectId = active?.pinned_project_id ?? draftPinnedProjectId ?? activeProjectId
  const chatId = active?.id ?? null
  const [records, setRecords] = useState<ProcessRecord[]>([])
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const recordsRef = useRef<ProcessRecord[]>([])
  const mounted = useRef(true)
  const removalTimers = useRef(new Map<string, number>())
  const revision = useRef(0)
  const changedAt = useRef(new Map<string, number>())
  const stopping = useRef(new Map<string, Promise<void>>())
  const stopControllers = useRef(new Map<string, AbortController>())
  const stopConfirmationStarted = useRef(new Map<string, number>())
  const stopConfirmationExpired = useRef(new Set<string>())
  const [stopAttempt, setStopAttempt] = useState(0)
  const hydrationSequence = useRef(0)
  const hydrationRequest = useRef<{ projectId: string; chatId: string; signal?: AbortSignal; sequence: number } | null>(null)

  const commitRecords = useCallback((updater: (previous: ProcessRecord[]) => ProcessRecord[]) => {
    if (!mounted.current) return
    const next = updater(recordsRef.current)
    recordsRef.current = next
    setRecords(next)
  }, [])
  const mergeProcess = useCallback((previous: ProcessRecord | undefined, process: BackgroundProcess): ProcessRecord => {
    if (previous && terminal.has(previous.status) && !terminal.has(process.status)) return previous
    return { ...process,
      ...(terminal.has(process.status) ? { completedAt: process.endedAt ?? process.recoveredAt ?? previous?.completedAt ?? Date.now() }
        : previous?.stopError ? { stopError: previous.stopError } : {}),
    }
  }, [])
  const handleMessage = useCallback((data: unknown) => {
    if (!data || typeof data !== 'object') return
    const message = data as { type?: string; projectId?: string; process?: BackgroundProcess }
    if (!['background_process.started', 'background_process.updated', 'background_process.exited'].includes(message.type ?? '') || !message.process) return
    const process = message.process
    if (!process.projectId || !process.chatId || !Number.isFinite(process.pid) || (message.projectId && message.projectId !== process.projectId)) return
    const key = backgroundProcessKey(process)
    const current = recordsRef.current.find(item => backgroundProcessKey(item) === key)
    // A delayed startup event is older than an in-flight Stop. Do not let it
    // drop the stopping state or invalidate the eventual HTTP confirmation.
    if (stopping.current.has(key) && current?.status === 'stopping'
      && !terminal.has(process.status) && process.status !== 'stopping' && !process.error) return
    changedAt.current.set(key, ++revision.current)
    commitRecords(previous => {
      const existing = previous.find(item => backgroundProcessKey(item) === key)
      const updated = mergeProcess(existing, process)
      return existing ? previous.map(item => backgroundProcessKey(item) === key ? updated : item) : [...previous, updated]
    })
  }, [commitRecords, mergeProcess])
  useEffect(() => {
    registerHandler('background-processes', handleMessage)
    return () => unregisterHandler('background-processes')
  }, [handleMessage, registerHandler, unregisterHandler])

  const hydrate = useCallback(async (signal?: AbortSignal) => {
    if (!projectId || !chatId) return
    const pending = hydrationRequest.current
    if (pending?.projectId === projectId && pending.chatId === chatId && !pending.signal?.aborted) return
    const sequence = ++hydrationSequence.current
    hydrationRequest.current = { projectId, chatId, signal, sequence }
    setHistoryLoading(true)
    setHistoryError(null)
    const atStart = revision.current
    try {
      const snapshot = await listBackgroundProcesses(projectId, chatId, signal)
      if (signal?.aborted || sequence !== hydrationSequence.current || !mounted.current) return
      const incoming = new Map(snapshot.filter(process => process.projectId === projectId && process.chatId === chatId).map(process => [backgroundProcessKey(process), process]))
      commitRecords(previous => {
        const next: ProcessRecord[] = []
        for (const existing of previous) {
          const key = backgroundProcessKey(existing)
          if (existing.projectId !== projectId || existing.chatId !== chatId || (changedAt.current.get(key) ?? 0) > atStart) {
            next.push(existing)
            incoming.delete(key)
            continue
          }
          const process = incoming.get(key)
          if (process) {
            // A list read can finish before the in-flight stop has reached the
            // server. It cannot undo that pending request's visible state.
            next.push(stopping.current.has(key) && !terminal.has(process.status)
              ? existing : mergeProcess(existing, process))
            incoming.delete(key)
          } else if (stopping.current.has(key)) next.push(existing)
          // A successful full snapshot also removes pruned durable history.
          // Selected log modals retain their own snapshot independently.
        }
        for (const process of incoming.values()) next.push(mergeProcess(undefined, process))
        return next
      })
    } catch (error) {
      // Offline/failed reads cannot prove the process stopped. Focus and WS
      // reconnection retry this snapshot without discarding its visible state.
      if (!signal?.aborted && sequence === hydrationSequence.current && mounted.current) setHistoryError(error instanceof Error ? error.message : 'Could not load process history')
    } finally {
      if (hydrationRequest.current?.sequence === sequence) hydrationRequest.current = null
      if (sequence === hydrationSequence.current && mounted.current) setHistoryLoading(false)
    }
  }, [projectId, chatId, commitRecords, mergeProcess])
  useEffect(() => {
    const controller = new AbortController()
    void hydrate(controller.signal)
    const focus = () => { void hydrate(controller.signal) }
    const visible = () => { if (document.visibilityState === 'visible') focus() }
    window.addEventListener('focus', focus)
    document.addEventListener('visibilitychange', visible)
    return () => {
      controller.abort()
      hydrationSequence.current += 1
      window.removeEventListener('focus', focus)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [hydrate, connectionStatus])

  useEffect(() => {
    for (const process of records) {
      if (process.completedAt === undefined) continue
      const key = backgroundProcessKey(process)
      if (removalTimers.current.has(key)) continue
      const remaining = Math.max(0, process.completedAt + BACKGROUND_TERMINAL_RETENTION_MS - Date.now())
      if (!remaining) continue
      removalTimers.current.set(key, window.setTimeout(() => {
        // Only retire the compact chip. Its durable history entry and logs
        // remain accessible after this presentation window expires.
        commitRecords(previous => [...previous])
      }, remaining))
    }
  }, [records, commitRecords])
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const timer of removalTimers.current.values()) window.clearTimeout(timer)
      removalTimers.current.clear()
      for (const controller of stopControllers.current.values()) controller.abort()
      stopControllers.current.clear()
    }
  }, [])

  const history = useMemo(() => records.filter(process => process.projectId === projectId && process.chatId === chatId), [records, projectId, chatId])
  const processes = useMemo(() => history.filter(process => process.completedAt === undefined || process.completedAt + BACKGROUND_TERMINAL_RETENTION_MS > Date.now()), [history])
  const confirmationScope = JSON.stringify(processes.filter(process => !terminal.has(process.status) && (process.status === 'stopping' || process.stopError)).map(backgroundProcessKey))
  useEffect(() => {
    const keys = JSON.parse(confirmationScope) as string[]
    if (!keys.length) return
    const controller = new AbortController()
    let timer: number | undefined
    for (const key of keys) if (!stopConfirmationStarted.current.has(key)) stopConfirmationStarted.current.set(key, Date.now())
    const schedule = () => {
      const pending = keys.filter(key => !stopConfirmationExpired.current.has(key))
      if (!pending.length) return
      const remaining = Math.min(...pending.map(key => stopConfirmationStarted.current.get(key)! + BACKGROUND_STOP_CONFIRMATION_MS - Date.now()))
      timer = window.setTimeout(tick, Math.max(0, Math.min(2000, remaining)))
    }
    const tick = () => {
      const expired = keys.filter(key => !stopConfirmationExpired.current.has(key)
        && Date.now() >= stopConfirmationStarted.current.get(key)! + BACKGROUND_STOP_CONFIRMATION_MS)
      for (const key of expired) stopConfirmationExpired.current.add(key)
      if (expired.length) commitRecords(previous => previous.map(process => expired.includes(backgroundProcessKey(process)) && !terminal.has(process.status)
        ? { ...process, stopError: process.stopError ?? 'The process has not confirmed that it stopped. You can retry.' } : process))
      if (keys.some(key => !stopConfirmationExpired.current.has(key))) void hydrate(controller.signal)
      schedule()
    }
    schedule()
    return () => { controller.abort(); if (timer !== undefined) window.clearTimeout(timer) }
  }, [confirmationScope, stopAttempt, hydrate, commitRecords])
  const kill = useCallback((target: BackgroundProcess | number): Promise<void> => {
    const matches = typeof target === 'number' ? recordsRef.current.filter(process => process.pid === target && process.projectId === projectId && process.chatId === chatId && !terminal.has(process.status)) : [target]
    if (matches.length !== 1) return Promise.reject(new Error('The process is no longer available. Refresh its status before retrying.'))
    const process = matches[0]
    const key = backgroundProcessKey(process)
    const current = recordsRef.current.find(item => backgroundProcessKey(item) === key)
    if (terminal.has(current?.status ?? process.status)) return Promise.resolve()
    const existingRequest = stopping.current.get(key)
    if (existingRequest) return existingRequest
    const before = current ?? process
    stopConfirmationStarted.current.set(key, Date.now())
    stopConfirmationExpired.current.delete(key)
    setStopAttempt(attempt => attempt + 1)
    const requestRevision = ++revision.current
    changedAt.current.set(key, requestRevision)
    commitRecords(previous => previous.map(item => backgroundProcessKey(item) === key ? { ...item, status: 'stopping', stopError: undefined } : item))
    const controller = new AbortController()
    stopControllers.current.set(key, controller)
    const request = (async () => {
      try {
        const response = await stopBackgroundProcess(process, controller.signal)
        if (!mounted.current || (changedAt.current.get(key) ?? 0) > requestRevision) return
        changedAt.current.set(key, ++revision.current)
        if (response.process) commitRecords(previous => previous.map(item => backgroundProcessKey(item) === key ? mergeProcess(item, response.process!) : item))
        // Legacy success lacks lifecycle evidence: keep stopping until WS or
        // reconciliation confirms termination, never hide it on HTTP 200 alone.
      } catch (cause) {
        const error = controller.signal.aborted ? new Error('The stop request could not be confirmed. Check its status and retry.') : cause
        if (mounted.current) {
          const newer = (changedAt.current.get(key) ?? 0) > requestRevision
          changedAt.current.set(key, ++revision.current)
          commitRecords(previous => previous.map(item => backgroundProcessKey(item) !== key || terminal.has(item.status) ? item
            : { ...item, status: newer ? item.status : before.status, stopError: error instanceof Error ? error.message : 'Could not stop the process' }))
        }
        throw error
      } finally {
        stopControllers.current.delete(key)
        stopping.current.delete(key)
      }
    })()
    stopping.current.set(key, request)
    return request
  }, [projectId, chatId, commitRecords, mergeProcess])
  const value = useMemo(() => ({ processes, history, historyLoading: !!projectId && !!chatId && historyLoading, historyError: projectId && chatId ? historyError : null, refreshHistory: hydrate, kill }), [processes, history, historyLoading, historyError, projectId, chatId, hydrate, kill])
  return <BackgroundProcessesContext.Provider value={value}>{children}</BackgroundProcessesContext.Provider>
}

export function useBackgroundProcesses(): BackgroundProcessesContextValue {
  return useContext(BackgroundProcessesContext) ?? { processes: [], history: [], historyLoading: false, historyError: null, refreshHistory: async () => undefined, kill: async () => undefined }
}
