import { Activity, useId, useState, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { openProjectSettings } from '../../../../lib/app-settings-events'
import { ChartNoAxesColumn } from 'lucide-react'
import { Popover } from '../../../../components/ui/popover'
import type { EventRow, JobSummary } from '../../../../types'
import { FailureDiagnosisCard, useDiagnosisText } from '../../../recovery/components/FailureDiagnosisCard'
import { FailureAnalysisPanel } from '../../../recovery/components/FailureAnalysisPanel'
import { useFailureAnalysis, type FailureAnalysisController } from '../../../recovery/hooks/useFailureAnalysis'
import { recordedStepError, type FailureDiagnosis, type RemedyHandlers } from '../../../recovery/lib/failure-diagnosis'
import type { FailureFacts } from '../../../recovery/components/FailureDiagnosisCard'
import { loadJobRunLogSection, saveJobRunLogSection, type RunDetailSurface, type RunLogSection } from './job-run-model'
import { runnableOptions, type ClientResolutionHandlers } from '../../../recovery/components/ResolutionOptions'
import type { ResolutionActions } from '../../../recovery/hooks/useContinueRemedies'
import { continueMode, costPerAttempt, isPlainContinue, KEEP_TRYING_ID, readResolutionOptions, visibleOptions, type ChainResolution, type ResolutionOption } from '../../../recovery/lib/resolution'
import { formatUsd } from '../../../../lib/format-usd'

export type RunDetailTab = 'failure' | 'log'
/** The tabs shown: loops expose their two evidence sections directly. */
type RunDetailView = RunDetailTab | RunLogSection
export type { RunLogSection } from './job-run-model'

/** Lets the graph tab open a step's log in the detail tab. */
export interface RunDetailNavigation {
  showStep(key: string): void
  /** The step the detail tab should open; `seq` repeats the same request. */
  stepFocus: { key: string; seq: number } | null
}
type RunDetailContent = ReactNode | ((navigation: RunDetailNavigation) => ReactNode)
const renderContent = (content: RunDetailContent | undefined, navigation: RunDetailNavigation) =>
  typeof content === 'function' ? content(navigation) : content

function payloadOf(event: EventRow): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(event.payload)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch { return null }
}
const numberOr = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null

/** Where and when the run failed, read from its own step records only. */
export function failureFactsFrom(events: readonly EventRow[], job: JobSummary): FailureFacts {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.event_type !== 'loop_step_end') continue
    const end = payloadOf(event)
    if (end?.status !== 'failed') continue
    let start: Record<string, unknown> | null = null
    for (let j = index - 1; j >= 0; j--) {
      if (events[j].event_type !== 'loop_step') continue
      const candidate = payloadOf(events[j])
      if (candidate?.index === end.index) { start = candidate; break }
    }
    const title = typeof start?.title === 'string' ? start.title : null
    const node = typeof end.nodeId === 'string' ? end.nodeId : typeof start?.nodeId === 'string' ? start.nodeId : null
    return {
      step: node ?? title,
      attempt: numberOr(start?.attempt),
      iteration: numberOr(start?.iteration),
      at: event.timestamp || job.finished_at || null,
    }
  }
  return { at: job.finished_at ?? null }
}

/** What a failed run's window can do with the AI analysis' resolution options. */
export interface RunResolution {
  /** The chain's spend and whether it keeps stopping for the same cause. */
  chain: ChainResolution | null
  /** Continue with an option or an instruction; null where this window cannot continue the run. */
  actions: ResolutionActions | null
}

/** The client-side kinds of option, run with what this surface already has. */
function clientResolutionHandlers(handlers: RemedyHandlers): ClientResolutionHandlers {
  return {
    ...(handlers['edit-spec'] ? { 'edit-spec': handlers['edit-spec'] } : {}),
    // A role's model is chosen in the project's agent settings.
    'change-model': { run: () => openProjectSettings('agentRuntime') },
    ...(handlers.retry ? { 'start-over': handlers.retry } : {}),
  }
}

/**
 * The options the window shows and how Continue shows beside them. Never two equivalent buttons:
 * without a repeat Continue is "keep going"; after one, Continue steps aside once real options exist
 * and "keep trying as is" (the analysis' own, or one stated here with the spend per attempt) goes last.
 */
function useResolutionView(analysis: FailureAnalysisController, resolution: RunResolution | undefined, handlers: RemedyHandlers) {
  const { t, i18n } = useTranslation('recovery')
  const options = analysis.state.status === 'ready' ? readResolutionOptions(analysis.state.analysis.options) : []
  const repeated = !!resolution?.chain?.repeated
  const perAttempt = costPerAttempt(resolution?.chain ?? null)
  const keepTrying: ResolutionOption | null = repeated && resolution?.actions ? {
    id: KEEP_TRYING_ID, kind: 'continue-with-guidance', guidance: '', risk: 'high',
    label: t('resolution.keepTrying.label'), does: t('resolution.keepTrying.does'),
    consequence: perAttempt ? t('resolution.keepTrying.consequence', { cost: formatUsd(perAttempt, i18n.language) }) : t('resolution.keepTrying.consequenceNoCost'),
  } : null
  const clientHandlers = clientResolutionHandlers(handlers)
  const shown = options.length ? runnableOptions(visibleOptions(options, repeated, keepTrying), resolution?.actions ?? null, clientHandlers) : []
  const optionsReady = shown.some((option) => !isPlainContinue(option))
  return { hasOptions: options.length > 0, shown, clientHandlers, mode: continueMode(repeated, optionsReady) }
}

/** The AI analysis, told what the deterministic card already says so it does not repeat it. */
function DiagnosisAnalysis({ projectId, jobId, diagnosis, tail, controller, handlers, resolution, view }: { projectId?: string; jobId: string; diagnosis: FailureDiagnosis; tail: readonly string[]; controller?: FailureAnalysisController; handlers: RemedyHandlers; resolution?: RunResolution; view: ReturnType<typeof useResolutionView> }) {
  const { t } = useTranslation('recovery')
  const { headline, phaseName } = useDiagnosisText(diagnosis)
  const recorded = diagnosis.kind === 'unknown' ? recordedStepError(tail) : null
  const shown = recorded ? t('headline.stepFailed', { phase: phaseName(recorded.step) }) : headline
  return (
    <FailureAnalysisPanel
      projectId={projectId}
      jobId={jobId}
      auto={diagnosis.kind !== 'provider_limit'}
      known={[shown, recorded?.reason, diagnosis.detail, diagnosis.blocker?.reason]}
      controller={controller}
      // Continue lives once, as the card's primary button above; the analysis never repeats it.
      continueCarriesPlan={!!handlers.continue}
      actions={{ 'edit-spec': handlers['edit-spec'],
        // A role's model is chosen in the project's agent settings.
        'change-model': { run: () => openProjectSettings('agentRuntime') } }}
      // Options replace the numbered plan; an older analysis (no options) keeps it.
      resolution={view.hasOptions ? { options: view.shown, actions: resolution?.actions ?? null, handlers: view.clientHandlers } : undefined}
    />
  )
}

export interface RunDetailTabsProps {
  job: JobSummary
  events: EventRow[]
  surface: RunDetailSurface
  diagnosis: FailureDiagnosis | null
  showDiagnosis: boolean
  onOpenLogs(): void
  /** Recorded figures, opened from the Details button beside the tabs. */
  detailsContent: ReactNode
  /** The answerable question, shown in the Failure reasons tab. */
  questionContent?: ReactNode
  /** Compact chips beside the tabs (evidence, sent instructions). */
  metaContent?: ReactNode
  /** Docked at the bottom of the log while the run accepts instructions. */
  composer?: ReactNode
  isLoop: boolean
  graphContent?: RunDetailContent
  logContent: RunDetailContent
  pendingQuestion?: boolean
  diagnosisHandlers?: RemedyHandlers
  diagnosisTail?: readonly string[]
  /** A stopped run's Continue card, shown where a failure's diagnosis would be. */
  continuityContent?: ReactNode
  hasDetails?: boolean
  detailsRequest?: number
  statusLead?: ReactNode
  statusTrail?: ReactNode
  /** Project the job belongs to; enables the AI failure analysis. */
  projectId?: string
  /** The chain behind a failed run and how this window continues it with a picked resolution. */
  resolution?: RunResolution
}

export function RunDetailTabs(props: RunDetailTabsProps) {
  return <RunDetailTabsView key={props.job.id} {...props} />
}

function RunDetailTabsView({
  surface, showDiagnosis, diagnosis, pendingQuestion = false,
  diagnosisHandlers = {}, diagnosisTail, continuityContent, detailsContent, questionContent, metaContent, composer, events, hasDetails = true,
  isLoop, graphContent, logContent, detailsRequest = 0, onOpenLogs, statusLead, statusTrail, projectId, job, resolution,
}: RunDetailTabsProps) {
  const { t, i18n } = useTranslation('jobs')
  const id = useId()
  const failureAvailable = showDiagnosis || pendingQuestion || !!continuityContent
  // One AI reading for the card (which leads with it when the app names no cause) and the panel below it.
  const analysisShown = !!(showDiagnosis && diagnosis && job.status === 'failed')
  const analysis = useFailureAnalysis(projectId, job.id, i18n.language, { auto: diagnosis?.kind !== 'provider_limit', enabled: analysisShown })
  const resolutionView = useResolutionView(analysis, analysisShown ? resolution : undefined, diagnosisHandlers)
  const [activeTab, setActiveTab] = useState<RunDetailTab>(showDiagnosis || continuityContent ? 'failure' : 'log')
  const [logSection, setLogSection] = useState<RunLogSection>(() => loadJobRunLogSection(surface))
  const [visited, setVisited] = useState({
    graph: !showDiagnosis && isLoop && logSection === 'graph',
    detail: !showDiagnosis && (!isLoop || logSection === 'detail'),
  })
  const selectedTab = failureAvailable ? activeTab : 'log'
  const selectedSection = isLoop ? logSection : 'detail'

  const explicitLogChoice = useRef(false)
  const observedDiagnosis = useRef(showDiagnosis)
  const observedRequest = useRef(detailsRequest)
  const questionToReveal = useRef(false)
  const failureRoot = useRef<HTMLDivElement>(null)
  const [navigationPending, setNavigationPending] = useState(false)
  const [stepFocus, setStepFocus] = useState<RunDetailNavigation['stepFocus']>(null)
  const openLogs = useRef(onOpenLogs)
  useEffect(() => { openLogs.current = onOpenLogs }, [onOpenLogs])

  // A diagnosis, or a stopped run's Continue card, opens its tab when it arrives (unless the person chose the log).
  const hasContinuity = !!continuityContent
  useEffect(() => {
    const leads = showDiagnosis || hasContinuity
    if (leads && !observedDiagnosis.current && !explicitLogChoice.current) setActiveTab('failure')
    if (leads) observedDiagnosis.current = true
  }, [showDiagnosis, hasContinuity])
  useEffect(() => {
    if (!failureAvailable) setActiveTab('log')
  }, [failureAvailable])
  useEffect(() => {
    if (selectedTab === 'log') setVisited(previous => previous[selectedSection] ? previous : { ...previous, [selectedSection]: true })
  }, [selectedTab, selectedSection])
  useEffect(() => {
    if (detailsRequest === observedRequest.current) return
    observedRequest.current = detailsRequest
    if (!pendingQuestion) return
    setNavigationPending(false)
    questionToReveal.current = true
    setActiveTab('failure')
  }, [detailsRequest, pendingQuestion])
  useEffect(() => {
    if (!questionToReveal.current || selectedTab !== 'failure') return
    questionToReveal.current = false
    failureRoot.current?.querySelector('textarea')?.focus()
  }, [selectedTab, detailsRequest])
  useEffect(() => {
    if (!navigationPending || selectedTab !== 'log') return
    const frame = requestAnimationFrame(() => {
      setNavigationPending(false)
      openLogs.current()
    })
    return () => cancelAnimationFrame(frame)
  }, [navigationPending, selectedTab, selectedSection])

  // The step logs live in the detail section, also for loops.
  function revealLogs() {
    explicitLogChoice.current = true
    setActiveTab('log')
    selectSection('detail')
    setNavigationPending(true)
  }
  const navigation: RunDetailNavigation = {
    stepFocus,
    showStep(key) {
      explicitLogChoice.current = true
      setActiveTab('log')
      selectSection('detail')
      setStepFocus(previous => ({ key, seq: (previous?.seq ?? 0) + 1 }))
    },
  }

  function selectTab(value: RunDetailTab) {
    if (value === 'log') explicitLogChoice.current = true
    setNavigationPending(false)
    setActiveTab(value)
    if (value === 'log') setVisited(previous => ({ ...previous, [selectedSection]: true }))
  }
  function selectSection(value: RunLogSection) {
    setNavigationPending(false)
    setLogSection(value)
    saveJobRunLogSection(surface, value)
    setVisited(previous => ({ ...previous, [value]: true }))
  }
  /** One navigation level: a loop's evidence sections are top-level tabs. */
  function selectView(value: RunDetailView) {
    if (value === 'failure' || value === 'log') { selectTab(value); return }
    explicitLogChoice.current = true
    setNavigationPending(false)
    setActiveTab('log')
    selectSection(value)
  }
  function navigate<T extends string>(event: KeyboardEvent<HTMLButtonElement>, values: T[], current: T, select: (value: T) => void) {
    const index = values.indexOf(current)
    let next: number
    switch (event.key) {
      case 'Home': next = 0; break
      case 'End': next = values.length - 1; break
      case 'ArrowRight': next = (index + 1) % values.length; break
      case 'ArrowLeft': next = (index + values.length - 1) % values.length; break
      default: return
    }
    event.preventDefault()
    select(values[next])
    const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    buttons?.[next]?.focus()
  }
  function renderTab<T extends string>(value: T, label: string, selected: T, values: T[], select: (value: T) => void) {
    return (
      <button
        key={value}
        type="button"
        role="tab"
        id={`${id}-tab-${value}`}
        aria-controls={`${id}-panel-${value}`}
        aria-selected={value === selected}
        tabIndex={value === selected ? 0 : -1}
        onClick={() => select(value)}
        onKeyDown={event => navigate(event, values, value, select)}
        className="rounded-md px-2.5 py-1.5 text-xs text-muted-foreground aria-selected:bg-muted aria-selected:text-foreground"
      >
        {label}
      </button>
    )
  }

  // Recorded figures open on demand, so the evidence below keeps the height.
  const details = hasDetails && (
    <Popover
      side="bottom"
      align="start"
      width={440}
      label={t('runHeader.details')}
      testId="job-run-details-popover"
      trigger={
        <button type="button" aria-label={t('runHeader.details')} title={t('runHeader.details')} className="inline-flex h-7 w-7 items-center justify-center rounded-control text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary aria-expanded:bg-muted aria-expanded:text-foreground">
          <ChartNoAxesColumn className="h-3.5 w-3.5" aria-hidden />
        </button>
      }
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain">{detailsContent}</div>
    </Popover>
  )
  const evidenceTabs: RunDetailView[] = isLoop ? ['graph', 'detail'] : ['log']
  const views: RunDetailView[] = failureAvailable ? ['failure', ...evidenceTabs] : evidenceTabs
  const selectedView: RunDetailView = selectedTab === 'failure' ? 'failure' : isLoop ? selectedSection : 'log'
  const graphVisible = selectedTab === 'log' && selectedSection === 'graph'
  const detailVisible = selectedTab === 'log' && selectedSection === 'detail'

  return (
    <div className="min-h-0 flex-1 flex flex-col overflow-hidden" data-testid="run-detail-tabs">
      {/* One row, one navigation level: a loop's graph and log detail are
          top-level tabs, so the evidence below starts as high as possible. */}
      <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3 py-1 min-w-0" data-testid="run-detail-bar">
        {statusLead && <div className="flex items-center gap-2 shrink-0">{statusLead}</div>}
        <div role="tablist" aria-label={t('runDetail.navigation')} className="flex gap-1">
          {views.map(value => renderTab(value, t(value === 'failure' && continuityContent && !showDiagnosis ? 'runDetail.stopped' : `runDetail.${value}`), selectedView, views, selectView))}
        </div>
        {(metaContent || details) && (
          <div className="flex shrink-0 items-center gap-1.5" data-testid="run-detail-meta">
            {metaContent}
            {details}
          </div>
        )}
        {statusTrail && <div className="flex min-w-0 flex-1 items-center gap-2">{statusTrail}</div>}
      </div>
      {failureAvailable && (
        <Activity mode={selectedTab === 'failure' ? 'visible' : 'hidden'}>
          <div ref={failureRoot} role="tabpanel" id={`${id}-panel-failure`} aria-labelledby={`${id}-tab-failure`} className="min-h-0 flex-1 max-h-full overflow-y-auto overscroll-contain p-3 space-y-3">
            {showDiagnosis && diagnosis && (
              <FailureDiagnosisCard
                diagnosis={diagnosis}
                handlers={{ ...diagnosisHandlers, 'open-logs': { ...diagnosisHandlers['open-logs'], run: revealLogs } }}
                logTail={diagnosisTail}
                facts={failureFactsFrom(events, job)}
                ai={analysisShown ? analysis : undefined}
                continueMode={analysisShown ? resolutionView.mode : 'primary'}
                chain={analysisShown ? resolution?.chain ?? null : null}
              />
            )}
            {showDiagnosis && diagnosis && job.status === 'failed' && (
              <DiagnosisAnalysis projectId={projectId} jobId={job.id} diagnosis={diagnosis} tail={diagnosisTail ?? []} controller={analysis} handlers={diagnosisHandlers} resolution={resolution} view={resolutionView} />
            )}
            {continuityContent}
            {pendingQuestion && questionContent}
          </div>
        </Activity>
      )}
      <Activity mode={selectedTab === 'log' ? 'visible' : 'hidden'}>
        <div
          role={isLoop ? undefined : 'tabpanel'}
          id={isLoop ? undefined : `${id}-panel-log`}
          aria-labelledby={isLoop ? undefined : `${id}-tab-log`}
          className="min-h-0 flex-1 flex flex-col overflow-hidden"
        >
          {isLoop && (visited.graph || graphVisible) && (
            <Activity mode={graphVisible ? 'visible' : 'hidden'}>
              <div
                role="tabpanel"
                id={`${id}-panel-graph`}
                aria-labelledby={`${id}-tab-graph`}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
                data-run-evidence="graph"
                data-active={graphVisible}
              >
                {renderContent(graphContent, navigation)}
              </div>
            </Activity>
          )}
          {(visited.detail || detailVisible) && (
            <Activity mode={detailVisible ? 'visible' : 'hidden'}>
              <div
                role={isLoop ? 'tabpanel' : undefined}
                id={`${id}-panel-detail`}
                aria-labelledby={isLoop ? `${id}-tab-detail` : undefined}
                className="min-h-0 flex-1 flex flex-col overflow-hidden"
                data-run-evidence="detail"
                data-active={detailVisible}
              >
                {renderContent(logContent, navigation)}
              </div>
            </Activity>
          )}
          {composer && <div className="shrink-0 border-t border-border bg-background/60 px-3 py-2" data-testid="run-composer-dock">{composer}</div>}
        </div>
      </Activity>
    </div>
  )
}
