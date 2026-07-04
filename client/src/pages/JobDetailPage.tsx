import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { getApiBase } from '../lib/api'
import { cancelJob } from '../lib/cancel-job'
import { formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { getDateFnsLocale } from '../lib/i18n'
import { ChevronRight, Home, RotateCcw, Download } from 'lucide-react'
import { Badge } from '../components/ui/badge'
import { Button } from '../components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../components/ui/tooltip'
import { PipelineProgress } from '../components/PipelineProgress'
import { JobStatusPanel } from '../components/JobStatusPanel'
import { JobTicketHeader } from '../components/JobTicketHeader'
import { InteractiveJobComposer } from '../components/InteractiveJobComposer'
import { useTicketDetailModal } from '../context/TicketDetailModalContext'
import { cn } from '../lib/utils'
import { LogViewer } from '../components/LogViewer'
import { LoopStepExplorer } from '../components/loop-log/LoopStepExplorer'
import { useSharedWebSocket } from '../hooks/useSharedWebSocket'
import type { JobSummary, EventRow, PhaseDefinition } from '../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'
import { useDesktop } from '../hooks/useDesktop'
import { formatCommandForProvider } from '../lib/format-command'

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<string, { variant: BadgeVariant; labelKey: string; tooltipKey: string }> = {
  running: { variant: 'running', labelKey: 'statusLabel.running', tooltipKey: 'statusTooltip.running' },
  completed: { variant: 'success', labelKey: 'statusLabel.completed', tooltipKey: 'statusTooltip.completed' },
  failed: { variant: 'failed', labelKey: 'statusLabel.failed', tooltipKey: 'statusTooltip.failed' },
  canceled: { variant: 'canceled', labelKey: 'statusLabel.canceled', tooltipKey: 'statusTooltip.canceled' },
  queued: { variant: 'queued', labelKey: 'statusLabel.queued', tooltipKey: 'statusTooltip.queued' },
}

export default function JobDetailPage() {
  const { t } = useTranslation('jobs')
  const { id } = useParams<{ id: string }>()
  const { activeProjectId, projects } = useDesktop()
  const activeProvider = projects.find((p) => p.id === activeProjectId)?.provider
  const navigate = useNavigate()
  const { openTicketDetail } = useTicketDetailModal()
  const [job, setJob] = useState<JobSummary | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [pipelineJobs, setPipelineJobs] = useState<JobSummary[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)

  // Reset and re-fetch when project or job id changes
  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    setJob(null)
    setEvents([])
    setPhaseDefinitions([])
    setPhases({})
    setIsLoading(true)
    setNotFound(false)

    async function loadJob() {
      try {
        const res = await fetch(`${getApiBase()}/jobs/${id}`, { signal: controller.signal })
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        if (!res.ok) throw new Error('Failed to fetch job')
        const data = await res.json() as { job: JobSummary; events: EventRow[] }
        setJob(data.job)
        setEvents(data.events)
      } catch (err) {
        if ((err as DOMException).name === 'AbortError') return
        setNotFound(true)
      } finally {
        if (!controller.signal.aborted) {
          setIsLoading(false)
        }
      }
    }
    loadJob()
    return () => controller.abort()
  }, [id, activeProjectId])

  // Fetch sibling jobs when this job belongs to a pipeline
  useEffect(() => {
    if (!job?.pipeline_id) { setPipelineJobs([]); return }
    const pipelineId = job.pipeline_id
    fetch(`${getApiBase()}/pipelines/${pipelineId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data: { jobs: JobSummary[] } | null) => {
        if (data?.jobs) setPipelineJobs(data.jobs)
      })
      .catch(() => {})
  }, [job?.pipeline_id, job?.status])

  // Subscribe to live WebSocket updates for this job
  const activeProjectRef = useRef(activeProjectId)
  activeProjectRef.current = activeProjectId

  // Last KNOWN job status (ref, not state — the WS handler must read it without
  // re-subscribing). Gates the queued→running refetch below to the actual flip.
  const jobStatusRef = useRef<JobSummary['status'] | null>(null)
  jobStatusRef.current = job?.status ?? null

  // ── Batched event accumulation (flush via rAF → max ~60 updates/sec) ────
  const pendingEventsRef = useRef<EventRow[]>([])
  const rafIdRef = useRef<number | null>(null)

  const flushEvents = useCallback(() => {
    rafIdRef.current = null
    const batch = pendingEventsRef.current
    if (batch.length === 0) return
    pendingEventsRef.current = []
    setEvents((prev) => {
      const next = [...prev, ...batch]
      return next.length > 10000 ? next.slice(next.length - 8000) : next
    })
  }, [])

  // Queue an event for the next rAF flush. Caps the pending queue at push time:
  // while the surface is hidden (rAF paused) it would otherwise grow unbounded.
  const enqueuePending = useCallback((ev: EventRow) => {
    const q = pendingEventsRef.current
    q.push(ev)
    if (q.length > 10000) pendingEventsRef.current = q.slice(-8000)
    if (!rafIdRef.current) rafIdRef.current = requestAnimationFrame(flushEvents)
  }, [flushEvents])

  useEffect(() => () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current) }, [])

  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string; projectId?: string } & Record<string, unknown>

    // Filter by active project
    if (activeProjectRef.current && msg.projectId && msg.projectId !== activeProjectRef.current) {
      return
    }

    if (msg.type === 'init') {
      const defs = (msg.phaseDefinitions ?? []) as PhaseDefinition[]
      setPhaseDefinitions(defs)
      const initPhases: PhaseMap = {}
      for (const def of defs) {
        initPhases[def.key] = ((msg.phases as Record<string, string>)?.[def.key] as PhaseState) ?? 'idle'
      }
      setPhases(initPhases)
    } else if (msg.type === 'event' && msg.jobId === id) {
      // Live stream frames (assistant / item.completed / turn.completed …). The
      // server broadcasts every parsed JSONL line here; the JobStatusPanel
      // activity signal is built from them. Without this branch the panel froze
      // at the open-time snapshot. Mirrors JobDetailModal's handler.
      const eventRow: EventRow = {
        id: Date.now(),
        job_id: id ?? '',
        seq: (msg.seq as number) ?? 0,
        event_type: msg.event_type as string,
        source: msg.source as string,
        payload: msg.payload as string,
        timestamp: msg.timestamp as string,
      }
      enqueuePending(eventRow)
    } else if (msg.type === 'log' && msg.processId === id) {
      const syntheticEvent: EventRow = {
        id: Date.now(),
        job_id: id ?? '',
        seq: 0,
        event_type: 'log',
        source: msg.source as string,
        payload: JSON.stringify({ line: msg.line }),
        timestamp: msg.timestamp as string,
      }
      enqueuePending(syntheticEvent)
    } else if (msg.type === 'job.finalized' && msg.jobId === id) {
      // The interactive session settled (turn totals live in the composer,
      // which owns the job.turn_* stream) — refetch the authoritative row.
      fetch(`${getApiBase()}/jobs/${id}`)
        .then((r) => r.json())
        .then((data: { job: JobSummary }) => setJob(data.job))
        .catch(() => {})
    } else if (msg.type === 'phase') {
      const phaseName = msg.phase as string
      const phaseState = msg.state as PhaseState
      setPhases((prev) => ({ ...prev, [phaseName]: phaseState }))
    } else if (msg.type === 'queue') {
      const jobs = msg.jobs as Array<{ id: string; status: string }> | undefined
      const matchingJob = jobs?.find((j) => j.id === id)
      if (matchingJob) {
        const newStatus = matchingJob.status as JobSummary['status']
        const prevStatus = jobStatusRef.current
        setJob((prev) => prev ? { ...prev, status: newStatus } : prev)
        if (newStatus === 'completed' || newStatus === 'failed' || newStatus === 'canceled') {
          fetch(`${getApiBase()}/jobs/${id}`)
            .then((r) => r.json())
            .then((data: { job: JobSummary }) => setJob(data.job))
            .catch(() => {})
        } else if (newStatus === 'running' && prevStatus !== 'running') {
          // Queued→running flip: refetch so the interactive surface fields
          // (interactive / interactiveSettleMode / interactiveAcceptingTurns)
          // arrive and the composer can mount without a manual refresh.
          fetch(`${getApiBase()}/jobs/${id}`)
            .then((r) => r.json())
            .then((data: { job: JobSummary }) => setJob(data.job))
            .catch(() => {})
        }
      }
    }
  }, [id, enqueuePending])

  const { registerHandler, unregisterHandler } = useSharedWebSocket()
  useEffect(() => {
    registerHandler(`job-detail-${id}`, handleMessage)
    return () => unregisterHandler(`job-detail-${id}`)
  }, [id, handleMessage, registerHandler, unregisterHandler])

  // While a running job has no telemetry yet, poll every 8s to detect when
  // the first OTLP payload arrives so the Export diagnostic button appears
  // without a manual refresh. Stops as soon as hasTelemetry flips or status
  // leaves 'running'.
  useEffect(() => {
    if (!id) return
    if (!job || job.status !== 'running' || job.hasTelemetry) return
    const iv = setInterval(() => {
      fetch(`${getApiBase()}/jobs/${id}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data: { job: JobSummary } | null) => {
          if (data?.job?.hasTelemetry) {
            setJob((prev) => prev ? { ...prev, hasTelemetry: true } : prev)
          }
        })
        .catch(() => {})
    }, 8000)
    return () => clearInterval(iv)
  }, [id, job?.status, job?.hasTelemetry])

  async function handleCancel() {
    if (!id) return
    // Shared manager-aware helper (same one JobDetailModal uses): DELETE
    // /jobs/:id — the server dispatches to LoopRunManager or QueueManager by
    // owner. projectId=null → active project via getApiBase() (board mode).
    const outcome = await cancelJob({ projectId: null, jobId: id })
    if (outcome.ok) {
      if (outcome.status === 'deleted') {
        toast.success(t('detail.toast.jobDeleted'))
        navigate('/jobs')
      } else {
        toast.success(t('detail.toast.cancelSignalSent'), { description: t('detail.toast.cancelSignalSentDescription') })
      }
    } else if (outcome.httpStatus === null) {
      // Transport-level failure — same toast the old try/catch produced.
      toast.error(t('detail.toast.networkError'))
    } else {
      toast.error(t('detail.toast.failed'), { description: outcome.error })
    }
  }

  async function handleExportDiagnostic() {
    if (!job) return
    try {
      // Use fetch so the global auth interceptor attaches X-Desktop-Token;
      // a plain <a download> would bypass JS and get a 401 from the API.
      const res = await fetch(`${getApiBase()}/jobs/${job.id}/diagnostic`)
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(data.error ?? t('detail.toast.exportFailedHttp', { status: res.status }))
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const date = new Date().toISOString().slice(0, 10)
      const a = document.createElement('a')
      a.href = url
      a.download = `specrails-diagnostic-${job.id}-${date}.zip`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(t('detail.toast.exportFailed'), { description: (err as Error).message })
    }
  }

  async function handleRerun() {
    if (!job) return
    try {
      const res = await fetch(`${getApiBase()}/spawn`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: job.command }),
      })
      const data = await res.json() as { jobId?: string; error?: string }
      if (!res.ok) throw new Error(data.error ?? t('detail.toast.spawnFailed'))
      toast.success(t('detail.toast.jobRequeued'))
      navigate(`/jobs/${data.jobId}`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  if (isLoading) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6">
        <div className="space-y-3">
          <div className="h-4 w-48 bg-muted/30 rounded animate-pulse" />
          <div className="h-20 bg-muted/30 rounded-lg animate-pulse" />
          <div className="h-64 bg-muted/30 rounded-lg animate-pulse" />
        </div>
      </div>
    )
  }

  if (notFound || !job) {
    return (
      <div className="max-w-5xl mx-auto px-4 py-6 flex flex-col items-center gap-3 mt-12">
        <p className="text-lg font-semibold">{t('detail.notFound')}</p>
        <p className="text-sm text-muted-foreground">{t('detail.notFoundDescription', { id })}</p>
        <Button asChild variant="outline" size="sm">
          <Link to="/">
            <Home className="w-3.5 h-3.5 mr-1.5" />
            {t('detail.backToDashboard')}
          </Link>
        </Button>
      </div>
    )
  }

  const statusInfo = STATUS_BADGE[job.status] ?? STATUS_BADGE.queued
  const isRunning = job.status === 'running'
  const isFinished = job.status === 'completed' || job.status === 'failed'
  // An interactive ultracode session that is still resident: the user converses
  // and must Finalize (no auto-terminate). FEATURE-gated via the server flag —
  // job.interactive is only ever set when the feature is on.
  const isInteractive = !!job.interactive
  const isInteractiveRunning = isInteractive && isRunning
  const hasTicketHeader = (job.tickets?.length ?? 0) > 0
  // Loop runs get the step-grouped explorer; every other job keeps the legacy
  // LogViewer byte-identical. Same discriminator as the composer `kind` below.
  const isLoopJob = job.command.startsWith('loop:')

  const pipelineTotals = pipelineJobs.length > 1 ? {
    totalCostUsd: pipelineJobs.reduce((s, j) => s + (j.total_cost_usd ?? 0), 0),
    // A phase whose cost is null (killed before its result event, provider gap)
    // contributes $0 to the sum with no signal — flag it so the panel shows a
    // "≥" incomplete indicator instead of a falsely-precise total (HIGH-10).
    hasNullCost: pipelineJobs.some((j) => j.total_cost_usd == null),
    // Preserve the estimated marker when any constituent phase's cost came from
    // the pricing-table fallback.
    costEstimated: pipelineJobs.some((j) => !!j.total_cost_usd_estimated),
    nullCostCount: pipelineJobs.filter((j) => j.total_cost_usd == null).length,
    totalTokensIn: pipelineJobs.reduce((s, j) => s + (j.tokens_in ?? 0), 0),
    totalTokensOut: pipelineJobs.reduce((s, j) => s + (j.tokens_out ?? 0), 0),
    totalTokensCacheRead: pipelineJobs.reduce((s, j) => s + (j.tokens_cache_read ?? 0), 0),
    totalTokensCacheCreate: pipelineJobs.reduce((s, j) => s + (j.tokens_cache_create ?? 0), 0),
    jobCount: pipelineJobs.length,
  } : null

  return (
    <div data-job-detail-surface className="flex flex-col h-full max-w-5xl mx-auto w-full">
      {/* Header */}
      <div className="px-4 py-4 border-b border-border space-y-3">
        {/* Breadcrumb */}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Link to="/" className="hover:text-foreground transition-colors flex items-center gap-1">
            <Home className="w-3 h-3" />
            {t('detail.breadcrumbDashboard')}
          </Link>
          <ChevronRight className="w-3 h-3" />
          <span className="text-foreground font-mono">{t('detail.breadcrumbJob', { id: id?.slice(0, 8) })}</span>
        </div>

        {/* Ticket identity card — premium header when the job references tickets */}
        {hasTicketHeader && (
          <JobTicketHeader
            tickets={job.tickets ?? []}
            onTicketClick={openTicketDetail}
          />
        )}

        {/* Job info */}
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Badge variant={statusInfo.variant}>{t(statusInfo.labelKey)}</Badge>
                  </div>
                </TooltipTrigger>
                <TooltipContent>{t(statusInfo.tooltipKey)}</TooltipContent>
              </Tooltip>
              <code
                className={cn(
                  'font-mono text-foreground/90 truncate',
                  hasTicketHeader ? 'text-xs text-muted-foreground' : 'text-sm',
                )}
              >
                {formatCommandForProvider(job.command, activeProvider)}
              </code>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
              <span>
                {job.started_at
                  ? t('detail.startedAgo', { timeAgo: formatDistanceToNow(new Date(job.started_at), { addSuffix: true, locale: getDateFnsLocale() }) })
                  : t('detail.queuedWaiting')}
              </span>
              {job.model && <span className="text-muted-foreground/40">{job.model}</span>}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {job.hasTelemetry && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7"
                    onClick={handleExportDiagnostic}
                    aria-label={t('detail.exportDiagnosticAria')}
                  >
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    {t('detail.exportDiagnostic')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('detail.exportDiagnosticTooltip')}
                </TooltipContent>
              </Tooltip>
            )}
            {isFinished && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleRerun}
                    className="h-7"
                  >
                    <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
                    {t('detail.reExecute')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('detail.reExecuteTooltip')}
                </TooltipContent>
              </Tooltip>
            )}
            {isRunning && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCancel}
                    className="h-7 border-destructive/30 text-destructive hover:bg-destructive/10"
                  >
                    {isInteractive ? t('detail.cancelInteractive') : t('detail.cancelJob')}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {t('detail.cancelJobTooltip')}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>

        {/* Pipeline progress */}
        <PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />
      </div>

      {/* Status panel — running, completed, or failed */}
      {(job.status === 'running' ||
        job.status === 'completed' ||
        job.status === 'failed') && (
        <JobStatusPanel
          job={job}
          events={events}
          defaultOpen={job.status === 'completed' || job.status === 'running'}
          pipelineTotals={pipelineTotals ?? undefined}
          phases={phases}
          phaseDefinitions={phaseDefinitions}
        />
      )}

      {/* Log viewer — loop jobs get the step-grouped explorer */}
      <div className="flex-1 overflow-hidden relative">
        {isLoopJob ? (
          <LoopStepExplorer events={events} jobStatus={job.status} variant="page" />
        ) : (
          <LogViewer events={events} />
        )}
      </div>

      {/* Interactive in-job agent composer — send more prompts to the resident
          agent (queued server-side), see live turn totals, and settle per the
          session's mode (Finalize for ultracode, quiet wrap-up for auto). */}
      {isInteractiveRunning && (
        <InteractiveJobComposer
          jobId={job.id}
          settleMode={job.interactiveSettleMode}
          initialAcceptingTurns={job.interactiveAcceptingTurns}
          kind={job.command.startsWith('loop:') ? 'loop-step' : 'job'}
          variant="page"
          /* No onFinalized: the page's own job.finalized WS branch refetches. */
        />
      )}
    </div>
  )
}
