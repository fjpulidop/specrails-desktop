import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { SIDE_PANE_FIT } from '../lib/mission-side-pane'
import { RailTrack } from '../../../components/brand/RailTrack'
import { useTranslation } from 'react-i18next'
import { formatDistanceToNow } from 'date-fns'
import { Maximize2, Minimize2, X, Briefcase } from 'lucide-react'
import { repositoryApiBase } from '../../projects/lib/project-repositories'
import { getDateFnsLocale } from '../../../lib/i18n'
import { cn } from '../../../lib/utils'
import { useAgentWorkspace } from '../context/AgentWorkspaceContext'
import { usePlaceParam } from '../../../hooks/usePlaceParam'
import { JOB_PARAM } from '../../../lib/places'
import { useProjectCache } from '../../../hooks/useProjectCache'
import { useSharedWebSocket } from '../../../hooks/useSharedWebSocket'
import { useDesktop } from '../../../hooks/useDesktop'
import { formatCommandForProvider } from '../../../lib/format-command'
import { jobActivityTimestamp, parseJobTimestamp } from '../../jobs/lib/job-time'
import { RunStatePill } from '../../../components/ui/run-state/run-state-pill'
import { jobStatusLook } from '../../jobs/lib/job-run-state'
import type { JobSummary } from '../../../types'

// Loads with the first opened job, like the mission cards' run-log chips:
// the log explorer stack (highlighting, runtime graph) stays out of the shell.
const JobDetailModal = lazy(() =>
  import('../../jobs/components/JobDetailModal').then((m) => ({ default: m.JobDetailModal })),
)

const MIN_PANE = 360
const DEFAULT_PANE = 480

/**
 * Agent-Mode inline Jobs pane (same split chrome as `AgentModeCodePane`): the
 * project's executions listed live beside the conversation. Clicking a job
 * opens the near-fullscreen `JobDetailModal` with the streaming execution.
 */
export function AgentModeJobsPane({ projectId }: { projectId: string }) {
  const { t } = useTranslation('agent')
  const { t: tJobs } = useTranslation('jobs')
  const { closeJobsPane, requestedJobId, clearRequestedJob } = useAgentWorkspace()
  const { projects } = useDesktop()
  const provider = projects.find((p) => p.id === projectId)?.provider
  const [width, setWidth] = useState(DEFAULT_PANE)
  const [maximized, setMaximized] = useState(false)
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { resizeCleanup.current?.() }, [maximized])
  // The open job is a place: `?job=<id>` (Back closes it, a link reopens it).
  const jobParam = usePlaceParam(JOB_PARAM)
  const detailJobId = jobParam.value
  const { open: openJobParam, close: closeJobParam } = jobParam
  // A Mission-mode notification click asked for a run (mission-rail-cards):
  // open it here instead of leaving the mission for the routed jobs page.
  useEffect(() => {
    if (!requestedJobId) return
    openJobParam(requestedJobId)
    clearRequestedJob()
  }, [requestedJobId, clearRequestedJob, openJobParam])

  const { data: jobs, isFirstLoad, refresh } = useProjectCache<JobSummary[]>({
    namespace: 'agent-jobs',
    projectId,
    initialValue: [],
    fetcher: async () => {
      const res = await fetch(`${repositoryApiBase(projectId)}/jobs?limit=50`)
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
    if (e.button !== 0) return
    e.preventDefault()
    resizeCleanup.current?.()
    const startX = e.clientX
    const startWidth = width
    const maxWidth = window.innerWidth - MIN_PANE
    const pointerId = e.pointerId
    const target = e.currentTarget
    const previousSelect = document.body.style.userSelect
    const previousCursor = document.body.style.cursor
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const preventSelection = (event: Event) => event.preventDefault()
    document.addEventListener('selectstart', preventSelection)
    try { target.setPointerCapture(pointerId) } catch { /* optional in webviews */ }
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return
      setWidth(Math.min(Math.max(startWidth + startX - ev.clientX, MIN_PANE), maxWidth))
    }
    const finish = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      window.removeEventListener('blur', finish)
      target.removeEventListener('lostpointercapture', finish)
      document.removeEventListener('selectstart', preventSelection)
      document.body.style.userSelect = previousSelect
      document.body.style.cursor = previousCursor
      try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId) } catch { /* already released */ }
      resizeCleanup.current = null
    }
    const onUp = (ev: PointerEvent) => { if (ev.pointerId === pointerId) finish() }
    resizeCleanup.current = finish
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    window.addEventListener('blur', finish)
    target.addEventListener('lostpointercapture', finish)
  }, [width])

  return (
    // Maximized = REALLY maximized: cover the whole Agent-Mode surface
    // (absolute over the relative surface root), not just grow in the flex row.
    <div data-area="jobs"
      className={cn(
        'area-surface flex h-full flex-col overflow-hidden border-l border-border bg-background',
        maximized ? 'absolute inset-0 z-30 border-l-0' : cn('relative', SIDE_PANE_FIT),
      )}
      style={maximized ? undefined : { width, flexShrink: 0 }}
    >
      {!maximized && (
        <div
          role="separator"
          aria-orientation="vertical"
          onPointerDown={beginResize}
          className="absolute inset-y-0 left-0 z-20 w-1.5 cursor-col-resize select-none touch-none hover:bg-accent-primary/20"
          title={t('workspace.resizeJobs')}
        />
      )}
      <div className="area-header flex h-12 shrink-0 items-center gap-2 border-b border-border bg-surface/40 px-3">
        <span className="text-label text-muted-foreground">{t('workspace.jobs')}</span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setMaximized((m) => !m)}
            aria-label={maximized ? t('restore') : t('maximize')}
            title={maximized ? t('restore') : t('maximize')}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={() => { closeJobParam(); closeJobsPane() }}
            aria-label={t('workspace.closeJobs')}
            title={t('workspace.closeJobs')}
            className="rounded-md p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {isFirstLoad ? (
          <div className="flex h-24 items-center justify-center text-muted-foreground">
            <RailTrack running className="w-16 shrink-0" />
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
                  onClick={() => openJobParam(job.id)}
                  className={cn(
                    'flex w-full flex-col gap-1 rounded-lg border border-border/50 bg-surface/30 px-2.5 py-2 text-left transition-colors',
                    'hover:border-accent-primary/40 hover:bg-surface/60',
                  )}
                >
                  <div className="flex items-center gap-2">
                    {(() => {
                      const look = jobStatusLook(job.status)
                      return <RunStatePill state={look.state} label={tJobs(look.labelKey)} data-testid="agent-job-status" />
                    })()}
                    {/* A continued run is its chain's one row; it names its attempt. */}
                    {job.attempt && job.attempt.number > 1 && (
                      <span className="text-caption text-muted-foreground num" data-testid="agent-job-attempt">{tJobs('recent.attempt', { number: job.attempt.number })}</span>
                    )}
                    <span className="ml-auto text-caption text-muted-foreground">
                      {(() => {
                        const timestamp = parseJobTimestamp(jobActivityTimestamp(job))
                        return timestamp
                          ? formatDistanceToNow(timestamp, { addSuffix: true, locale: getDateFnsLocale() })
                          : '—'
                      })()}
                    </span>
                  </div>
                  <code className="truncate font-mono text-xs text-foreground">
                    {formatCommandForProvider(job.command, provider)}
                  </code>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {detailJobId && (
        <Suspense fallback={null}>
          <JobDetailModal jobId={detailJobId} projectId={projectId} onClose={closeJobParam} />
        </Suspense>
      )}
    </div>
  )
}
