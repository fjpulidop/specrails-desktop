import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import { API_ORIGIN } from '../lib/origin'
import type { BackgroundProcess } from '../types'
import { useAgentChat } from './AgentChatContext'
import { useDesktop } from '../hooks/useDesktop'

interface BackgroundProcessesContextValue {
  processes: BackgroundProcess[]
  kill: (pid: number) => Promise<void>
}

const BackgroundProcessesContext = createContext<BackgroundProcessesContextValue | null>(null)

type BackgroundWsMessage =
  | { type: 'background_process.started'; projectId: string; process: BackgroundProcess }
  | { type: 'background_process.exited'; projectId: string; process: BackgroundProcess }
  | { type: 'background_process.output'; projectId: string; chatId: string; pid: number; source: 'stdout' | 'stderr'; line: string }

const terminal = new Set(['exited', 'killed', 'failed'])
const TERMINAL_RETENTION_MS = 8000
type BackgroundProcessRecord = BackgroundProcess & { completedAt?: number }

export function BackgroundProcessesProvider({
  children,
}: {
  children: ReactNode
}) {
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const { active, draftPinnedProjectId } = useAgentChat()
  const { activeProjectId } = useDesktop()
  const projectId = active?.pinned_project_id ?? draftPinnedProjectId ?? activeProjectId
  const chatId = active?.id ?? null
  const [records, setRecords] = useState<BackgroundProcessRecord[]>([])
  const removalTimers = useRef(new Map<number, number>())

  const clearRemovalTimer = useCallback((pid: number) => {
    const timer = removalTimers.current.get(pid)
    if (timer) window.clearTimeout(timer)
    removalTimers.current.delete(pid)
  }, [])

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as Partial<BackgroundWsMessage>
    if (msg.type === 'background_process.started' && msg.process) {
      clearRemovalTimer(msg.process.pid)
      setRecords((prev) => (
        prev.some((p) => p.pid === msg.process!.pid) ? prev : [...prev, msg.process!]
      ))
      return
    }
    if (msg.type === 'background_process.exited' && msg.process) {
      const process = msg.process
      clearRemovalTimer(process.pid)
      if (process.status === 'killed') {
        setRecords((prev) => prev.filter((p) => p.pid !== process.pid))
        return
      }
      const completed = { ...process, completedAt: Date.now() }
      setRecords((prev) => (
        prev.some((p) => p.pid === process.pid)
          ? prev.map((p) => (p.pid === process.pid ? completed : p))
          : [...prev, completed]
      ))
      const timer = window.setTimeout(() => {
        setRecords((prev) => prev.filter((p) => p.pid !== process.pid))
        removalTimers.current.delete(process.pid)
      }, TERMINAL_RETENTION_MS)
      removalTimers.current.set(process.pid, timer)
    }
  }, [clearRemovalTimer])

  useEffect(() => {
    registerHandler('background-processes', handleMessage)
    return () => unregisterHandler('background-processes')
  }, [handleMessage, registerHandler, unregisterHandler])

  useEffect(() => {
    if (!projectId || !chatId) return
    let alive = true
    const hydrate = async (): Promise<void> => {
      try {
        const qs = new URLSearchParams({ chatId })
        const res = await fetch(`${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/background-processes?${qs.toString()}`)
        if (!res.ok) return
        const data = await res.json() as { processes?: BackgroundProcess[] }
        if (!alive || !Array.isArray(data.processes)) return
        if (data.processes.length === 0) return
        setRecords((prev) => {
          const byPid = new Map(prev.map((process) => [process.pid, process]))
          for (const process of data.processes ?? []) {
            byPid.set(process.pid, process)
          }
          return Array.from(byPid.values())
        })
      } catch {
        // Best-effort hydration: websocket events keep the live path working.
      }
    }
    void hydrate()
    return () => { alive = false }
  }, [chatId, projectId])

  useEffect(() => () => {
    for (const timer of removalTimers.current.values()) window.clearTimeout(timer)
    removalTimers.current.clear()
  }, [])

  const processes = useMemo(
    () => records.filter((p) => (
      p.projectId === projectId &&
      p.chatId === chatId &&
      (!terminal.has(p.status) || (p.status !== 'killed' && p.completedAt !== undefined))
    )),
    [records, projectId, chatId],
  )

  const kill = useCallback(async (pid: number): Promise<void> => {
    if (!projectId || !chatId) return
    await fetch(
      `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}/background-processes/${encodeURIComponent(String(pid))}?chatId=${encodeURIComponent(chatId)}`,
      { method: 'DELETE' },
    )
  }, [chatId, projectId])

  const value = useMemo(() => ({ processes, kill }), [processes, kill])
  return <BackgroundProcessesContext.Provider value={value}>{children}</BackgroundProcessesContext.Provider>
}

export function useBackgroundProcesses(): BackgroundProcessesContextValue {
  const ctx = useContext(BackgroundProcessesContext)
  if (!ctx) return { processes: [], kill: async () => undefined }
  return ctx
}
