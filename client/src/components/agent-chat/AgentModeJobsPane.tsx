import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'
import { Maximize2, Minimize2, X, Loader2, Briefcase } from 'lucide-react'
import { getApiBase } from '../../lib/api'
import { getDateFnsLocale } from '../../lib/i18n'
import { cn } from '../../lib/utils'
import { useAgentWorkspace } from '../../context/AgentWorkspaceContext'
import { useProjectCache } from '../../hooks/useProjectCache'
import { useSharedWebSocket } from '../../hooks/useSharedWebSocket'
import { useDesktop } from '../../hooks/useDesktop'
import { formatCommandForProvider } from '../../lib/format-command'
import { Badge } from '../ui/badge'
import { JobDetailModal } from '../JobDetailModal'
import type { JobSummary } from '../../types'

const MIN_PANE = 360
const DEFAULT_PANE = 480

type BadgeVariant = 'success' | 'running' | 'queued' | 'failed' | 'canceled'
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  running: 'running',
  completed: 'success',
  failed: 'failed',
  canceled: 'canceled',
  queued: 'queued',
}

/**
 * Agent-Mode inline Jobs pane (same split chrome as `AgentModeCodePane`): the
 * project's executions listed live beside the conversation. Clicking a job
 * opens the near-fullscreen `JobDetailModal` with the streaming execution.
 */
export function AgentModeJobsPane({ projectId }: { projectId: string }) {
  const { t } = useTranslation('agent')
  const { t: tJobs } = useTranslation('jobs')
  const { closeJobsPane } = useAgentWorkspace()
  const { projects } = useDesktop()
  const provider = projects.find((p) => p.id === projectId)?.provider
  const [width, setWidth] = useState(DEFAULT_PANE)
  const [maximized, setMaximized] = useState(false)
  const [detailJobId, setDetailJobId] = useState<string | null>(null)

  const { data: jobs, isFirstLoad, refresh } = useProjectCache<JobSummary[]>({
    namespace: 'agent-jobs',
    projectId,
    initialValue: [],
    fetcher: async () => {
      const res = await fetch(`${getApiBase()}/jobs?limit=50`)
      if (!res.ok) return []
      const data = await res.json() as { jobs: JobSummary[] }
      return data.jobs
    },
    pollInterval: 5_000,
  })

  // Live status flips (queued→running→completed) ride the shared queue WS
  // broadcast — refresh immediately instead of waiting out the poll.
  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    const handler = (raw: unknown): void => {
      const msg = raw as { type?: string; projectId?: string }
      if (msg.type !== 'queue') return
      if (msg.projectId && msg.projectId !== projectIdRef.current) return
      refreshRef.current()
    }
    registerHandler('agent-jobs-pane', handler)
    return () => unregisterHandler('agent-jobs-pane')
  }, [registerHandler, unregisterHandler])

  const beginResize = useCallback((e: React.PointerEvent) => {
    const startX = e.clientX
    const startWidth = width
    const maxWidth = window.innerWidth - MIN_PANE
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
    const onMove = (ev: PointerEvent) => {
      const next = Math.min(Math.max(startWidth + (startX - ev.clientX), MIN_PANE), maxWidth)
      setWidth(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [width])

  return (
    // Maximized = REALLY maximized: cover the whole Agent-Mode surface
    // (absolute over the relative surface root), not just grow in the flex row.
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden border-l border-border bg-background',
        maximized && 'absolute inset-0 z-30 border-l-0',
      )}
      style={maximized ? undefined : { width, flexShrink: 0 }}
    >
      <div className="relative flex items-center">
        {!maximized && (
          <div
            role="separator"
            aria-orientation="vertical"
            onPointerDown={beginResize}
            className="absolute left-0 top-0 h-full w-1.5 -translate-x-full cursor-col-resize select-none touch-none hover:bg-accent-primary/20"
            title={t('workspace.resizeJobs')}
          />
        )}
      </div>
      <div className="flex items-center gap-2 border-b border-border/60 bg-surface/40 px-3 py-1.5">
        <span className="text-xs font-medium text-foreground/70">{t('workspace.jobs')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
            className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={closeJobsPane}
            aria-label={t('workspace.closeJobs')}
            title={t('workspace.closeJobs')}
            className="rounded-md p-1 text-foreground/60 hover:bg-surface hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isFirstLoad ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : jobs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <Briefcase className="h-6 w-6 opacity-40" />
            <p className="text-xs">{t('workspace.noJobs')}</p>
          </div>
        ) : (
          <ul className="space-y-1">
            {jobs.map((job) => (
              <li key={job.id}>
                <button
                  type="button"
                  onClick={() => setDetailJobId(job.id)}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-lg border border-border/50 bg-surface/30 px-2.5 py-2 text-left transition-colors',
                    'hover:border-accent-primary/40 hover:bg-surface/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Badge variant={STATUS_VARIANT[job.status] ?? 'queued'}>
                      {tJobs(`statusLabel.${job.status in STATUS_VARIANT ? job.status : 'queued'}`)}
                    </Badge>
                    {job.status === 'running' && <Loader2 className="h-3 w-3 animate-spin text-accent-primary" />}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {formatDistanceToNow(new Date(job.started_at), { addSuffix: true, locale: getDateFnsLocale() })}
                    </span>
                  </div>
                  <code className="truncate font-mono text-xs text-foreground/85">
                    {formatCommandForProvider(job.command, provider)}
                  </code>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {detailJobId && (
        <JobDetailModal jobId={detailJobId} onClose={() => setDetailJobId(null)} />
      )}
    </div>
  )
}
