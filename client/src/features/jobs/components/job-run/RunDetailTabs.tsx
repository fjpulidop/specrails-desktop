import { Activity, useId, useState, useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import type { EventRow, JobSummary } from '../../../../types'
import { FailureDiagnosisCard } from '../../../recovery/components/FailureDiagnosisCard'
import type { FailureDiagnosis, RemedyHandlers } from '../../../recovery/lib/failure-diagnosis'
import { loadJobRunDetailsOpen, saveJobRunDetailsOpen, loadJobRunLogSection, saveJobRunLogSection, type RunDetailSurface, type RunLogSection } from './job-run-model'

export type RunDetailTab = 'failure' | 'log'
export type { RunLogSection } from './job-run-model'

export interface RunDetailTabsProps {
  job: JobSummary
  events: EventRow[]
  surface: RunDetailSurface
  diagnosis: FailureDiagnosis | null
  showDiagnosis: boolean
  onOpenLogs(): void
  detailsContent: ReactNode
  isLoop: boolean
  graphContent?: ReactNode
  logContent: ReactNode
  pendingQuestion?: boolean
  diagnosisHandlers?: RemedyHandlers
  diagnosisTail?: readonly string[]
  hasDetails?: boolean
  detailsRequest?: number
}

export function RunDetailTabs(props: RunDetailTabsProps) {
  return <RunDetailTabsView key={props.job.id} {...props} />
}

function RunDetailTabsView({
  surface, showDiagnosis, diagnosis, pendingQuestion = false,
  diagnosisHandlers = {}, diagnosisTail, detailsContent, hasDetails = true,
  isLoop, graphContent, logContent, detailsRequest = 0, onOpenLogs,
}: RunDetailTabsProps) {
  const { t } = useTranslation('jobs')
  const id = useId()
  const failureAvailable = showDiagnosis || pendingQuestion
  const [activeTab, setActiveTab] = useState<RunDetailTab>(showDiagnosis ? 'failure' : 'log')
  const [logSection, setLogSection] = useState<RunLogSection>(() => loadJobRunLogSection(surface))
  const [detailsOpen, setDetailsOpen] = useState(() => loadJobRunDetailsOpen(surface))
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
  const detailsRoot = useRef<HTMLDivElement>(null)
  const [navigationPending, setNavigationPending] = useState(false)
  const openLogs = useRef(onOpenLogs)
  useEffect(() => { openLogs.current = onOpenLogs }, [onOpenLogs])

  useEffect(() => {
    if (showDiagnosis && !observedDiagnosis.current && !explicitLogChoice.current) setActiveTab('failure')
    if (showDiagnosis) observedDiagnosis.current = true
  }, [showDiagnosis])
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
    setDetailsOpen(true)
    saveJobRunDetailsOpen(surface, true)
  }, [detailsRequest, pendingQuestion, surface])
  useEffect(() => {
    if (!questionToReveal.current || selectedTab !== 'failure' || !detailsOpen) return
    questionToReveal.current = false
    detailsRoot.current?.querySelector('textarea')?.focus()
  }, [selectedTab, detailsOpen, detailsRequest])
  useEffect(() => {
    if (!navigationPending || selectedTab !== 'log') return
    const frame = requestAnimationFrame(() => {
      setNavigationPending(false)
      openLogs.current()
    })
    return () => cancelAnimationFrame(frame)
  }, [navigationPending, selectedTab, selectedSection])

  function revealLogs() {
    explicitLogChoice.current = true
    setActiveTab('log')
    selectSection(isLoop ? 'graph' : 'detail')
    setNavigationPending(true)
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
        className="rounded-md px-3 py-2 text-xs text-muted-foreground aria-selected:bg-muted aria-selected:text-foreground"
      >
        {label}
      </button>
    )
  }

  function toggleDetails() {
    setDetailsOpen(!detailsOpen)
    saveJobRunDetailsOpen(surface, !detailsOpen)
  }

  const details = hasDetails && (
    <div ref={detailsRoot} className={failureAvailable ? 'shrink-0' : 'min-h-0 shrink-0 max-h-[40%] overflow-y-auto overscroll-contain'}>
      <button type="button" aria-expanded={detailsOpen} onClick={toggleDetails} className="inline-flex items-center gap-1 px-3 py-2 text-xs text-muted-foreground">
        {t('runHeader.details')}
        <ChevronDown className="h-3.5 w-3.5" aria-hidden />
      </button>
      {detailsOpen && detailsContent}
    </div>
  )
  const topTabs: RunDetailTab[] = failureAvailable ? ['failure', 'log'] : ['log']
  const sections: RunLogSection[] = ['graph', 'detail']
  const graphVisible = selectedTab === 'log' && selectedSection === 'graph'
  const detailVisible = selectedTab === 'log' && selectedSection === 'detail'

  return (
    <div className="min-h-0 flex-1 flex flex-col overflow-hidden" data-testid="run-detail-tabs">
      <div role="tablist" aria-label={t('runDetail.navigation')} className="shrink-0 flex gap-1 border-b border-border px-3">
        {topTabs.map(value => renderTab(value, t(`runDetail.${value}`), selectedTab, topTabs, selectTab))}
      </div>
      {failureAvailable && (
        <Activity mode={selectedTab === 'failure' ? 'visible' : 'hidden'}>
          <div role="tabpanel" id={`${id}-panel-failure`} aria-labelledby={`${id}-tab-failure`} className="min-h-0 flex-1 max-h-full overflow-y-auto overscroll-contain p-3 space-y-3">
            {showDiagnosis && diagnosis && (
              <FailureDiagnosisCard
                diagnosis={diagnosis}
                handlers={{ ...diagnosisHandlers, 'open-logs': { ...diagnosisHandlers['open-logs'], run: revealLogs } }}
                logTail={diagnosisTail}
              />
            )}
            {details}
          </div>
        </Activity>
      )}
      <Activity mode={selectedTab === 'log' ? 'visible' : 'hidden'}>
        <div role="tabpanel" id={`${id}-panel-log`} aria-labelledby={`${id}-tab-log`} className="min-h-0 flex-1 flex flex-col overflow-hidden">
          {!failureAvailable && details}
          {isLoop && (
            <div role="tablist" aria-label={t('runDetail.sections')} className="shrink-0 flex gap-1 px-3 py-1">
              {sections.map(value => renderTab(value, t(`runDetail.${value}`), selectedSection, sections, selectSection))}
            </div>
          )}
          {isLoop && (visited.graph || graphVisible) && (
            <Activity mode={graphVisible ? 'visible' : 'hidden'}>
              <div
                role="tabpanel"
                id={`${id}-panel-graph`}
                aria-labelledby={`${id}-tab-graph`}
                className="min-h-0 flex-1 flex flex-col overflow-hidden"
                data-run-evidence="graph"
                data-active={graphVisible}
              >
                {graphContent}
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
                {logContent}
              </div>
            </Activity>
          )}
        </div>
      </Activity>
    </div>
  )
}
