import { useEffect, useState, useCallback, useRef } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../lib/api'
import { getDateFnsLocale } from '../lib/i18n'
import { toast } from 'sonner'
import { X, ExternalLink } from 'lucide-react'
import { Badge } from './ui/badge'
import { Button } from './ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from './ui/dialog'
import { PipelineProgress } from './PipelineProgress'
import { LogViewer } from './LogViewer'
import { useMovableResizableModal } from '../hooks/useMovableResizableModal'
import { ResizeGrips } from './ui/ResizeGrips'
import { useWebSocket } from '../hooks/useWebSocket'
import { WS_URL } from '../lib/ws-url'
import type { JobSummary, EventRow, PhaseDefinition } from '../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'

function formatWallClock(startedAt: string, finishedAt: string): string {
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 0) return '—'
  const secs = Math.round(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const s = secs % 60
  if (mins < 60) return `${mins}m ${s}s`
  const hrs = Math.floor(mins / 60)
  const m = mins % 60
  return `${hrs}h ${m}m`
}

type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'running' | 'queued' | 'failed' | 'canceled'

const STATUS_BADGE: Record<string, { variant: BadgeVariant; labelKey: string; tooltipKey: string }> = {
  running: { variant: 'running', labelKey: 'statusLabel.running', tooltipKey: 'statusTooltip.running' },
  completed: { variant: 'success', labelKey: 'statusLabel.completed', tooltipKey: 'statusTooltip.completed' },
  failed: { variant: 'failed', labelKey: 'statusLabel.failed', tooltipKey: 'statusTooltip.failed' },
  canceled: { variant: 'canceled', labelKey: 'statusLabel.canceled', tooltipKey: 'statusTooltip.canceled' },
  queued: { variant: 'queued', labelKey: 'statusLabel.queued', tooltipKey: 'statusTooltip.queued' },
  zombie_terminated: { variant: 'failed', labelKey: 'statusLabel.zombie', tooltipKey: 'statusTooltip.zombie' },
}

interface JobDetailModalProps {
  jobId: string
  onClose: () => void
}

export function JobDetailModal({ jobId, onClose }: JobDetailModalProps) {
  const { t } = useTranslation('jobs')
  const [job, setJob] = useState<JobSummary | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)

  // Fetch initial job data + historical events
  useEffect(() => {
    async function loadJob() {
      try {
        const res = await fetch(`${getApiBase()}/jobs/${jobId}`)
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        if (!res.ok) throw new Error('Failed to fetch job')
        const data = await res.json() as { job: JobSummary; events: EventRow[]; phaseDefinitions?: PhaseDefinition[] }
        setJob(data.job)
        setEvents(data.events)
        if (data.phaseDefinitions) {
          setPhaseDefinitions(data.phaseDefinitions)
          const initPhases: PhaseMap = {}
          for (const def of data.phaseDefinitions) {
            initPhases[def.key] = 'idle'
          }
          setPhases(initPhases)
        }
      } catch {
        setNotFound(true)
      } finally {
        setIsLoading(false)
      }
    }
    loadJob()
  }, [jobId])

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

  // Cleanup rAF on unmount
  useEffect(() => () => { if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current) }, [])

  // Subscribe to live WebSocket updates
  const handleMessage = useCallback((data: unknown) => {
    const msg = data as { type: string } & Record<string, unknown>

    if (msg.type === 'event' && msg.jobId === jobId) {
      const eventRow: EventRow = {
        id: Date.now(),
        job_id: jobId,
        seq: 0,
        event_type: msg.event_type as string,
        source: msg.source as string,
        payload: msg.payload as string,
        timestamp: msg.timestamp as string,
      }
      pendingEventsRef.current.push(eventRow)
      if (!rafIdRef.current) rafIdRef.current = requestAnimationFrame(flushEvents)
    } else if (msg.type === 'log' && msg.processId === jobId && msg.source === 'stderr') {
      const syntheticEvent: EventRow = {
        id: Date.now(),
        job_id: jobId,
        seq: 0,
        event_type: 'log',
        source: 'stderr',
        payload: JSON.stringify({ line: msg.line }),
        timestamp: msg.timestamp as string,
      }
      pendingEventsRef.current.push(syntheticEvent)
      if (!rafIdRef.current) rafIdRef.current = requestAnimationFrame(flushEvents)
    } else if (msg.type === 'phase') {
      const phaseName = msg.phase as string
      const phaseState = msg.state as PhaseState
      setPhases((prev) => ({ ...prev, [phaseName]: phaseState }))
    } else if (msg.type === 'queue') {
      const jobs = msg.jobs as Array<{ id: string; status: string }> | undefined
      const matchingJob = jobs?.find((j) => j.id === jobId)
      if (matchingJob && job) {
        setJob((prev) => prev ? { ...prev, status: matchingJob.status as JobSummary['status'] } : prev)
      }
    }
  }, [jobId, job, flushEvents])

  useWebSocket(WS_URL, handleMessage)

  // Close on Escape
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  async function handleCancel() {
    try {
      const res = await fetch(`${getApiBase()}/jobs/${jobId}`, { method: 'DELETE' })
      if (res.ok) {
        toast.success(t('modal.toast.cancelSignalSent'), { description: t('modal.toast.cancelSignalSentDescription') })
      } else {
        const data = await res.json() as { error?: string }
        toast.error(t('modal.toast.cancelFailed'), { description: data.error })
      }
    } catch {
      toast.error(t('modal.toast.networkError'))
    }
  }

  const statusInfo = job ? (STATUS_BADGE[job.status] ?? STATUS_BADGE.queued) : STATUS_BADGE.queued
  const isRunning = job?.status === 'running'

  const { panelRef, panelStyle, headerHandleProps, resizeHandles, isFloating, guardBackdrop } = useMovableResizableModal()

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={guardBackdrop(onClose)}
      />

      {/* Panel */}
      <div
        ref={panelRef}
        className="relative w-full m-3 rounded-xl glass-card border border-border/30 flex flex-col animate-in fade-in zoom-in-95 duration-200 overflow-hidden"
        style={panelStyle}
      >
        {/* Header */}
        <div
          {...headerHandleProps}
          className={`flex items-center justify-between px-4 py-3 border-b border-border/30${isFloating ? ' cursor-grab active:cursor-grabbing' : ''}`}
        >
          <div className="flex items-center gap-3 min-w-0">
            {job && (
              <>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div>
                      <Badge variant={statusInfo.variant}>{t(statusInfo.labelKey)}</Badge>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>{t(statusInfo.tooltipKey)}</TooltipContent>
                </Tooltip>
                <code className="text-xs font-mono text-foreground/80 truncate">{job.command}</code>
                <span className="text-[10px] text-muted-foreground">
                  {formatDistanceToNow(new Date(job.started_at), { addSuffix: true, locale: getDateFnsLocale() })}
                </span>
                {job.total_cost_usd != null && job.total_cost_usd > 0 && (
                  <span className="text-[10px] text-muted-foreground">${job.total_cost_usd.toFixed(4)}</span>
                )}
                {job.finished_at && (
                  <span className="text-[10px] text-muted-foreground">{formatWallClock(job.started_at, job.finished_at)}</span>
                )}
              </>
            )}
            {isLoading && <span className="text-xs text-muted-foreground">{t('common:states.loading')}</span>}
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {/* Pipeline progress inline */}
            {phaseDefinitions.length > 0 && (
              <div className="mr-3">
                <PipelineProgress phases={phases} phaseDefinitions={phaseDefinitions} />
              </div>
            )}

            {isRunning && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowCancelConfirm(true)}
                className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {t('common:actions.cancel')}
              </Button>
            )}

            <Tooltip>
              <TooltipTrigger asChild>
                <a
                  href={`/jobs/${jobId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface/50 transition-colors"
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </TooltipTrigger>
              <TooltipContent>{t('modal.openInNewTab')}</TooltipContent>
            </Tooltip>

            <button
              onClick={onClose}
              className="h-7 w-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-surface/50 transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-hidden relative">
          {notFound ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-muted-foreground">{t('modal.notFound')}</p>
            </div>
          ) : (
            <LogViewer events={events} isLoading={isLoading} />
          )}
        </div>
      </div>

      <ResizeGrips handles={resizeHandles} />

      {/* Cancel confirmation dialog */}
      <Dialog open={showCancelConfirm} onOpenChange={setShowCancelConfirm}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('modal.cancelConfirmTitle')}</DialogTitle>
            <DialogDescription>
              {t('modal.cancelConfirmDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" size="sm" onClick={() => setShowCancelConfirm(false)}>
              {t('modal.keepRunning')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => { setShowCancelConfirm(false); handleCancel() }}
            >
              {t('modal.cancelJob')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
