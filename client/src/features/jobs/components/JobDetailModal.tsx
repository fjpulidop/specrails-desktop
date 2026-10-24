import { modalDialogStyle, modalOverlayStyle } from '../../../lib/modal-safe-area'
import { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { formatDistanceToNow } from 'date-fns'
import { useTranslation } from 'react-i18next'
import { getApiBase } from '../../../lib/api'
import { API_ORIGIN } from '../../../lib/origin'
import { getDateFnsLocale } from '../../../lib/i18n'
import { cn } from '../../../lib/utils'
import { DIALOG_LAYER_CLASS } from '../../../lib/layers'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { cancelJob, cancelKindForJob } from '../lib/cancel-job'
import { Button } from '../../../components/ui/button'
import {
  DIALOG_PANEL_CLASS,
  DIALOG_SCRIM_CLASS,
  DIALOG_SIZE_CLASS,
  DialogCloseButton,
  DialogDescription,
  DialogHeader,
  DialogLayerProvider,
  DialogTitle,
} from '../../../components/ui/dialog'
import { ConfirmDialog } from '../../../components/ui/confirm-dialog'
import { TooltipProvider } from '../../../components/ui/tooltip'
import { JobRunHeader } from './job-run/JobRunHeader'
import { LogViewer } from './LogViewer'
import { LoopStepExplorer } from '../../loops/components/loop-log/LoopStepExplorer'
import { NarratedProgress } from '../../loops/components/loop-log/NarratedProgress'
import { FEATURE_NARRATED_PROGRESS } from '../../../lib/feature-flags'
import { loadJobLogMode, saveJobLogMode, type JobLogMode } from '../lib/job-log-mode'
import { isJobDisplayEvent, jobEventsWithNotice, retainJobEvents, type JobEventBuffer } from '../lib/job-event-buffer'
import { InteractiveJobComposer } from './InteractiveJobComposer'
import { useMovableResizableModal } from '../../../hooks/useMovableResizableModal'
import { ResizeGrips } from '../../../components/ui/ResizeGrips'
import { useWebSocket } from '../../../hooks/useWebSocket'
import { WS_URL } from '../../../lib/ws-url'
import { jobActivityTimestamp, parseJobTimestamp } from '../lib/job-time'
import type { JobSummary, EventRow, PhaseDefinition } from '../../../types'
import type { PhaseMap, PhaseState } from '../hooks/usePipeline'

/** Short, human-readable job id for the title ("#1a2b3c4d"). */
function shortJobId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id
}

/**
 * Human name of the job's command for the modal title: `loop:<id>` → loop
 * run, `/specrails:implement …` → "Implement", anything else → generic.
 */
function jobTitleKind(command: string): { loop: true } | { loop: false; name: string | null } {
  if (command.startsWith('loop:')) return { loop: true }
  const m = /^\/(?:[\w-]+:)?([\w-]+)/.exec(command.trim())
  if (!m) return { loop: false, name: null }
  const words = m[1].replace(/[-_]+/g, ' ').trim()
  return { loop: false, name: words ? words.charAt(0).toUpperCase() + words.slice(1) : null }
}

interface JobDetailModalProps {
  jobId: string
  onClose: () => void
  /** Explicit project scope (agent-chat ref chips — the conversation's pinned
   *  project, which may differ from the active one). Defaults to the active
   *  project via `getApiBase()` — board-mode callers are unchanged. */
  projectId?: string
}

export function JobDetailModal({ jobId: initialJobId, onClose, projectId }: JobDetailModalProps) {
  const [jobId, openFork] = useState(initialJobId)
  useEffect(() => { openFork(initialJobId) }, [initialJobId])
  const { t } = useTranslation('jobs')
  const { t: tNarration } = useTranslation('narration')
  // Lazy so the no-explicit-projectId path keeps getApiBase()'s call-time
  // resolution (it throws when no project is active — never during render).
  const apiBase = useCallback(
    () => (projectId ? `${API_ORIGIN}/api/projects/${projectId}` : getApiBase()),
    [projectId],
  )
  // Log-surface altitude, shared per project with the routed Job Detail page so
  // the two views never disagree about which one the user prefers.
  const [narrationMode, setNarrationModeState] = useState<JobLogMode>(loadJobLogMode)
  const setNarrationMode = useCallback((mode: JobLogMode) => {
    setNarrationModeState(mode)
    saveJobLogMode(mode)
  }, [])
  const [job, setJob] = useState<JobSummary | null>(null)
  const [eventBuffer, setEventBuffer] = useState<JobEventBuffer>(() => retainJobEvents([]))
  const events = useMemo(() => jobEventsWithNotice(eventBuffer, t('logViewer.retainedTail')), [eventBuffer, t])
  const [phaseDefinitions, setPhaseDefinitions] = useState<PhaseDefinition[]>([])
  const [phases, setPhases] = useState<PhaseMap>({})
  const [isLoading, setIsLoading] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [showCancelConfirm, setShowCancelConfirm] = useState(false)
  const [isCanceling, setIsCanceling] = useState(false)

  // Fetch initial job data + historical events
  useEffect(() => {
    let cancelled = false
    pendingEventsRef.current = { events: [], omitted: false }
    if (rafIdRef.current) cancelAnimationFrame(rafIdRef.current)
    rafIdRef.current = null
    setEventBuffer(retainJobEvents([]))
    setJob(null)
    setIsLoading(true)
    setNotFound(false)
    async function loadJob() {
      try {
        const res = await fetch(`${apiBase()}/jobs/${jobId}`)
        if (cancelled) return
        if (res.status === 404) {
          setNotFound(true)
          return
        }
        if (!res.ok) throw new Error('Failed to fetch job')
        const data = await res.json() as { job: JobSummary; events: EventRow[]; phaseDefinitions?: PhaseDefinition[] }
        if (cancelled) return
        setJob(data.job)
        setEventBuffer(retainJobEvents(data.events))
        if (data.phaseDefinitions) {
          setPhaseDefinitions(data.phaseDefinitions)
          const initPhases: PhaseMap = {}
          for (const def of data.phaseDefinitions) {
            initPhases[def.key] = 'idle'
          }
          setPhases(initPhases)
        }
      } catch {
        if (!cancelled) setNotFound(true)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }
    loadJob()
    return () => { cancelled = true }
  }, [jobId, apiBase])

  // Tolerant job-row refetch (interactive settle / status flips): only replaces
  // the job — a transient failure never blanks the already-rendered modal.
  const refetchJob = useCallback(() => {
    fetch(`${apiBase()}/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { job: JobSummary } | null) => {
        if (data?.job) setJob(data.job)
      })
      .catch(() => {})
  }, [jobId, apiBase])

  // ── Batched event accumulation (flush via rAF → max ~60 updates/sec) ────
  const pendingEventsRef = useRef<JobEventBuffer>({ events: [], omitted: false })
  const rafIdRef = useRef<number | null>(null)

  const flushEvents = useCallback(() => {
    rafIdRef.current = null
    const batch = pendingEventsRef.current
    if (batch.events.length === 0) return
    pendingEventsRef.current = { events: [], omitted: false }
    setEventBuffer((prev) => retainJobEvents([...prev.events, ...batch.events], prev.omitted || batch.omitted))
  }, [])

  // Keep a hidden modal's pending queue bounded without evicting step markers.
  const enqueuePending = useCallback((event: EventRow) => {
    if (!isJobDisplayEvent(event)) return
    const pending = pendingEventsRef.current
    pending.events.push(event)
    if (pending.events.length > 10000) pendingEventsRef.current = retainJobEvents(pending.events, pending.omitted)
    if (!rafIdRef.current) rafIdRef.current = requestAnimationFrame(flushEvents)
  }, [flushEvents])

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
      enqueuePending(eventRow)
    } else if (msg.type === 'log' && msg.processId === jobId) {
      // Append BOTH stdout and stderr live log frames — matching JobDetailPage's
      // handler. The old stderr-only filter froze live stdout in mission mode
      // (loop-run lines, which stream as `log` frames, never grew the modal).
      const syntheticEvent: EventRow = {
        id: Date.now(),
        job_id: jobId,
        seq: 0,
        event_type: 'log',
        source: msg.source as string,
        payload: JSON.stringify({
          line: msg.line,
          ...(typeof msg.attemptId === 'string' && msg.attemptId.trim() && msg.attemptId.length <= 256 ? { attemptId: msg.attemptId } : {}),
        }),
        timestamp: msg.timestamp as string,
      }
      enqueuePending(syntheticEvent)
    } else if (
      (msg.type === 'job.finalized' && msg.jobId === jobId)
      || (msg.type === 'runtime.continuation' && msg.jobId === jobId)
      || (msg.type === 'job.interactive' && msg.jobId === jobId)
      || ((msg.type === 'loop.run_paused' || msg.type === 'loop.run_resumed') && msg.loopRunId === jobId)
    ) {
      // The interactive session settled — refetch the authoritative row so the
      // header flips to the terminal status and the composer unmounts.
      refetchJob()
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
  }, [jobId, job, enqueuePending, refetchJob])

  useWebSocket(WS_URL, handleMessage)

  // Cancel idiom: loop runs → "Stop", interactive sessions → "Discard" (the
  // same relabel JobDetailPage uses), everything else → "Cancel". ALL kinds
  // go through the shared manager-aware helper (POST /jobs/:id/cancel — the server
  // dispatches to LoopRunManager or QueueManager by owner).
  const cancelKind = job ? cancelKindForJob(job) : 'job'
  const isLoopRun = cancelKind === 'loop-run'

  async function handleCancel() {
    setIsCanceling(true)
    try {
      const outcome = await cancelJob({ projectId: projectId ?? null, jobId, kind: cancelKind })
      if (outcome.ok) {
        toast.success(
          isLoopRun ? t('modal.toast.stopSignalSent') : t('modal.toast.cancelSignalSent'),
          { description: isLoopRun ? t('modal.toast.stopSignalSentDescription') : t('modal.toast.cancelSignalSentDescription') },
        )
        // Reconcile immediately — the WS `job.finalized` refetch still applies
        // when the run settles later, but don't depend on it exclusively.
        refetchJob()
      } else {
        // Surface EVERY failure with detail (the quota incident hid a failing
        // request behind a generic toast — never mask what the server said).
        toast.error(t('modal.toast.cancelFailed'), { description: outcome.error })
      }
    } finally {
      setIsCanceling(false)
    }
  }

  const isRunning = job?.status === 'running'
  const activityTime = job ? parseJobTimestamp(jobActivityTimestamp(job)) : null

  const { panelRef, panelStyle, headerHandleProps, resizeHandles, isFloating, guardBackdrop } = useMovableResizableModal({
    persistKey: 'specrails.modal.job-detail',
  })

  // Focus return: this controlled dialog has no Radix `DialogTrigger`, so
  // remember what was focused when it opened (a ref chip, a board row) and
  // refocus it on close.
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const setPanelNode = useCallback((node: HTMLDivElement | null) => {
    panelRef(node)
    if (!node) return
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !node.contains(active)) {
      returnFocusRef.current = active
    }
  }, [panelRef])

  // Human title ("Implement job · #1a2b3c4d"); the raw command is the mono
  // subtitle. While loading, the id is already known — never a bare spinner.
  const shortId = shortJobId(jobId)
  const titleKind = job ? jobTitleKind(job.command) : null
  const title = titleKind?.loop
    ? t('modal.titleLoop', { id: shortId })
    : titleKind?.name
      ? t('modal.title', { kind: titleKind.name, id: shortId })
      : t('modal.titleGeneric', { id: shortId })

  return (
    // Radix dialog on the `entity` layer (65): above the floating agent panel
    // (60/61), below the minimized-chats dock (75) and capture surfaces (80).
    // The Portal escapes the floating AgentChatPanel, whose backdrop-filter /
    // transform would otherwise be the containing block for the fixed panel.
    <DialogPrimitive.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          style={modalOverlayStyle()}
          className={cn(DIALOG_SCRIM_CLASS, DIALOG_LAYER_CLASS.entity)}
        />
        <DialogPrimitive.Content
          ref={setPanelNode}
          data-testid="job-detail-modal"
          data-dialog-size="fullscreen"
          data-dialog-layer="entity"
          {...(notFound && !job ? { 'aria-describedby': undefined } : {})}
          // Bespoke geometry: the fullscreen size token, movable by the header
          // and resizable from inset grips (persisted per surface).
          className={cn(DIALOG_PANEL_CLASS, DIALOG_LAYER_CLASS.entity, DIALOG_SIZE_CLASS.fullscreen)}
          style={{ ...modalDialogStyle(92), ...panelStyle }}
          onCloseAutoFocus={(e) => {
            const target = returnFocusRef.current
            returnFocusRef.current = null
            if (target?.isConnected) { e.preventDefault(); target.focus() }
          }}
          // Dismiss the inline cancel confirmation first, then the modal.
          onEscapeKeyDown={(e) => {
            if (showCancelConfirm) { e.preventDefault(); setShowCancelConfirm(false) }
          }}
          // Ignore the outside press that ends a move/resize drag.
          onPointerDownOutside={(e) => {
            let allowed = false
            guardBackdrop(() => { allowed = true })()
            if (!allowed) e.preventDefault()
          }}
        >
          {/* Own TooltipProvider: this modal mounts from trees WITHOUT one (the
              Agent-Mode surface bypasses ProjectLayout) — without it Radix
              throws and blanks the whole app on open. */}
          <TooltipProvider delayDuration={400}>
          <DialogLayerProvider layer="entity">
            <DialogHeader
              {...headerHandleProps}
              className={isFloating ? 'cursor-grab active:cursor-grabbing' : undefined}
              actions={<DialogCloseButton className="-mr-1.5 -mt-1" />}
            >
              <DialogTitle className="truncate">{title}</DialogTitle>
              {job ? (
                <DialogDescription className="flex min-w-0 items-baseline gap-2">
                  <code className="min-w-0 truncate font-mono text-xs text-foreground/80">{job.command}</code>
                  <span className="shrink-0 text-xs">
                    {activityTime
                      ? formatDistanceToNow(activityTime, { addSuffix: true, locale: getDateFnsLocale() })
                      : '—'}
                  </span>
                </DialogDescription>
              ) : isLoading ? (
                <DialogDescription>{t('common:states.loading')}</DialogDescription>
              ) : null}
            </DialogHeader>

            {/* The ONE run header shared with the board's Job Detail page. */}
            {job && (
              <JobRunHeader
                onOpenRun={openFork}
                job={job}
                events={events}
                phases={phases}
                phaseDefinitions={phaseDefinitions}
                projectId={projectId}
                variant="glass"
                actions={isRunning ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowCancelConfirm(true)}
                    disabled={isCanceling}
                    className="h-7 text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    {isCanceling && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" aria-hidden />}
                    {isLoopRun
                      ? t('dashboard:railControls.stop')
                      : cancelKind === 'interactive'
                        ? t('common:actions.discard')
                        : t('common:actions.cancel')}
                  </Button>
                ) : null}
              />
            )}

            {eventBuffer.omitted && (
              <p role="status" className="shrink-0 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
                {t('logViewer.retainedTail')}
              </p>
            )}

            {/* Content — the log surfaces own their scrolling (virtualized),
                so this region clips instead of being a DialogBody. */}
            <div className="min-h-0 flex-1 overflow-hidden relative">
              {notFound ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm text-muted-foreground">{t('modal.notFound')}</p>
                </div>
              ) : FEATURE_NARRATED_PROGRESS && job ? (
                <div className="flex h-full min-h-0 flex-col">
                  <div className="flex items-center gap-1 border-b border-border/40 px-3 py-1.5">
                    {(['narrated', 'log'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        data-chip=""
                        onClick={() => setNarrationMode(mode)}
                        aria-pressed={narrationMode === mode}
                        data-testid={`modal-narration-mode-${mode}`}
                        className={`inline-flex h-5 items-center rounded-md px-2 text-caption font-medium transition-colors ${
                          narrationMode === mode
                            ? 'bg-accent-primary/15 text-accent-primary'
                            : 'text-muted-foreground hover:bg-surface/60'
                        }`}
                      >
                        {tNarration(mode === 'narrated' ? 'modeNarrated' : 'modeLog')}
                      </button>
                    ))}
                  </div>
                  <div className="min-h-0 flex-1 overflow-hidden">
                    {narrationMode === 'narrated' ? (
                      <NarratedProgress
                        events={events}
                        settled={job.status !== 'running' && job.status !== 'queued'}
                        elapsedMs={job.duration_ms ?? null}
                        variant="glass"
                      />
                    ) : job.command.startsWith('loop:') ? (
                      <LoopStepExplorer
                        events={events}
                        jobStatus={job.status}
                        isLoading={isLoading}
                        variant="glass"
                        projectId={projectId}
                        onOpenRun={openFork}
                      />
                    ) : (
                      <LogViewer events={events} isLoading={isLoading} projectId={projectId} />
                    )}
                  </div>
                </div>
              ) : job?.command.startsWith('loop:') ? (
                <LoopStepExplorer
                  events={events}
                  jobStatus={job.status}
                  isLoading={isLoading}
                  variant="glass"
                  projectId={projectId}
                  onOpenRun={openFork}
                />
              ) : (
                <LogViewer events={events} isLoading={isLoading} projectId={projectId} />
              )}
            </div>

            {/* Interactive in-job agent composer — the SAME control the board's Job
                Detail page mounts, so a mission-mode user steers the running job
                without leaving the workspace. */}
            {!!job?.interactive && job.status === 'running' && (
              <InteractiveJobComposer
                jobId={jobId}
                projectId={projectId}
                settleMode={job.interactiveSettleMode}
                initialAcceptingTurns={job.interactiveAcceptingTurns}
                pendingInterrupts={job.pendingInterrupts}
                kind={job.command.startsWith('loop:') ? 'loop-step' : 'job'}
                variant="glass"
                onFinalized={refetchJob}
              />
            )}

            {/* Cancel confirmation — a nested ConfirmDialog. Inside this entity
                modal it climbs to the `stacked` layer (70) automatically, so it
                always paints above the panel. */}
            <ConfirmDialog
              open={showCancelConfirm}
              onOpenChange={setShowCancelConfirm}
              testId="job-cancel-confirm"
              title={isLoopRun ? t('modal.stopRunConfirmTitle') : t('modal.cancelConfirmTitle')}
              description={isLoopRun ? t('modal.stopRunConfirmDescription') : t('modal.cancelConfirmDescription')}
              cancelLabel={t('modal.keepRunning')}
              confirmLabel={isLoopRun
                ? t('modal.stopRun')
                : cancelKind === 'interactive'
                  ? t('common:actions.discard')
                  : t('modal.cancelJob')}
              onConfirm={() => { setShowCancelConfirm(false); void handleCancel() }}
            />
          </DialogLayerProvider>
          </TooltipProvider>
          <ResizeGrips handles={resizeHandles} placement="inset" />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
