import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
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
  const [records, setRecords] = useState<BackgroundProcess[]>([])

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as Partial<BackgroundWsMessage>
    if (msg.type === 'background_process.started' && msg.process) {
      setRecords((prev) => (
        prev.some((p) => p.pid === msg.process!.pid) ? prev : [...prev, msg.process!]
      ))
      return
    }
    if (msg.type === 'background_process.exited' && msg.process) {
      setRecords((prev) => prev.map((p) => (p.pid === msg.process!.pid ? msg.process! : p)))
    }
  }, [])

  useEffect(() => {
    registerHandler('background-processes', handleMessage)
    return () => unregisterHandler('background-processes')
  }, [handleMessage, registerHandler, unregisterHandler])

  const processes = useMemo(
    () => records.filter((p) => (
      p.projectId === projectId &&
      p.chatId === chatId &&
      !terminal.has(p.status)
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
