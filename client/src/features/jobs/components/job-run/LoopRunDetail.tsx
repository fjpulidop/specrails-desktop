import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { EventRow } from '../../../../types'
import { LoopStepExplorer } from '../../../loops/components/loop-log/LoopStepExplorer'
import { NarratedProgress } from '../../../loops/components/loop-log/NarratedProgress'
import { FEATURE_NARRATED_PROGRESS } from '../../../../lib/feature-flags'
import { LogViewer } from '../LogViewer'
import type { RunDetailNavigation } from './RunDetailTabs'

type Mode = 'steps' | 'narrated' | 'log'

/**
 * A loop run's "Log detail" tab: the step trail and the step-grouped log by
 * default, with the story and the raw log one click away. A step picked in the
 * graph tab opens here.
 */
export function LoopRunDetail({ events, jobStatus, isLoading, projectId, variant, navigation, onOpenRun, settled, elapsedMs }: {
  events: EventRow[]
  jobStatus: string
  isLoading?: boolean
  projectId?: string
  variant: 'page' | 'glass'
  navigation: RunDetailNavigation
  onOpenRun?(runId: string): void
  settled: boolean
  elapsedMs: number | null
}) {
  const { t } = useTranslation('narration')
  const [mode, setMode] = useState<Mode>('steps')
  const focus = navigation.stepFocus
  useEffect(() => { if (focus) setMode('steps') }, [focus?.seq])
  const modes: Mode[] = FEATURE_NARRATED_PROGRESS ? ['steps', 'narrated', 'log'] : ['steps', 'log']
  const label = (value: Mode) => t(value === 'steps' ? 'modeSteps' : value === 'narrated' ? 'modeNarrated' : 'modeLog')

  const switcher = (
    <div className="flex shrink-0 items-center gap-1" role="group">
      {modes.map(value => (
        <button
          key={value}
          type="button"
          onClick={() => setMode(value)}
          aria-pressed={mode === value}
          data-testid={`loop-detail-mode-${value}`}
          className={`inline-flex h-6 items-center rounded-md px-2 text-caption font-medium transition-colors ${
            mode === value ? 'bg-accent-primary/15 text-accent-primary' : 'text-muted-foreground hover:bg-surface/60'
          }`}
        >
          {label(value)}
        </button>
      ))}
    </div>
  )

  // Steps: the switcher shares the filter bar. The other views keep a slim row.
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="loop-run-detail">
      {mode !== 'steps' && <div className="shrink-0 border-b border-border/40 px-3 py-1">{switcher}</div>}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {mode === 'steps' && (
          <LoopStepExplorer events={events} jobStatus={jobStatus} isLoading={isLoading} variant={variant} projectId={projectId} onOpenRun={onOpenRun} view="detail" focusStep={focus} toolbarLeading={switcher} />
        )}
        {mode === 'narrated' && <NarratedProgress events={events} settled={settled} elapsedMs={elapsedMs} variant={variant} />}
        {mode === 'log' && <LogViewer events={events} isLoading={isLoading} projectId={projectId} />}
      </div>
    </div>
  )
}
