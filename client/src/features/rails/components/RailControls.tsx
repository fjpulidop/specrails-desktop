import { Play, Square, AlertTriangle, ScrollText } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from '../../../components/ui/button'

export type RailMode = 'implement' | 'freestyle' | 'loop'
export type RailStatus = 'idle' | 'running' | 'failed'

interface RailControlsProps {
  mode: RailMode
  status: RailStatus
  activeJobId?: string
  ticketCount: number
  /** When true, show Freestyle. It bypasses the OpenSpec pipeline and lets the
   *  selected capable provider implement the spec autonomously. */
  freestyleAvailable?: boolean
  /** When true, show the "Loop" segment (runs a published global loop against
   *  the rail's specs). Gated by FEATURE_LOOPS_SECTION at the call site. */
  loopAvailable?: boolean
  onModeChange: (mode: RailMode) => void
  onToggle: () => void
  /** When set, Play is disabled and this sentence explains why (e.g. the
   *  project's review WIP limit is reached). Stop is never blocked. */
  launchBlockedReason?: string | null
}

export function RailControls({ status, activeJobId, ticketCount, onToggle, launchBlockedReason }: RailControlsProps) {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const blocked = status !== 'running' && Boolean(launchBlockedReason)
  const canPlay = ticketCount > 0 && !blocked
  return (
    <div className="flex items-center gap-1.5">
      {/* View Log button — visible only while running */}
      {status === 'running' && activeJobId && (
        <Button
          size="sm"
          variant="ghost"
          className="group h-6 px-2 gap-1 rounded-md border border-accent-info/20 bg-accent-info/5 text-[11px] font-semibold text-accent-info transition-colors duration-150 hover:border-accent-info/50 hover:bg-accent-info/15 hover:text-accent-info"
          onClick={() => navigate(`/jobs/${activeJobId}`)}
          title={t('railControls.viewJobLog')}
        >
          <ScrollText className="w-3 h-3" />
          <span>{t('railControls.log')}</span>
        </Button>
      )}

      {/* The rail's Loop picker (factory + custom loops) lives in RailRow and
          replaces the old mode segmented control — the chosen Loop derives the
          legacy `mode`. RailControls keeps Log / Play. (The old per-rail
          "Interactive" toggle is gone: Freestyle jobs are interactive by
          default whenever the feature is enabled.) */}

      {/* Play / Stop / Failed toggle. A disabled button shows no tooltip in
          every webview, so a blocked Play carries its reason on a wrapper. */}
      <span className="inline-flex" title={blocked ? launchBlockedReason ?? undefined : undefined} data-testid={blocked ? 'rail-play-blocked' : undefined}>
      <Button
        size="sm"
        variant="ghost"
        className={`h-7 w-7 p-0 rounded-full transition-colors duration-150 ${
          status === 'running'
            ? 'text-destructive hover:text-destructive hover:bg-destructive/10'
            : blocked
              ? 'text-muted-foreground cursor-not-allowed'
            : status === 'failed'
              ? 'text-accent-warning hover:text-accent-success hover:bg-accent-success/10'
              : canPlay
                ? 'text-accent-success hover:text-accent-success hover:bg-accent-success/10'
                : 'text-muted-foreground cursor-not-allowed'
        }`}
        onClick={onToggle}
        disabled={!canPlay && status !== 'running'}
        aria-label={blocked ? launchBlockedReason ?? undefined : undefined}
        title={
          status === 'running' ? t('railControls.stop') :
          blocked ? launchBlockedReason ?? undefined :
          status === 'failed' ? t('railControls.failedRetry') :
          canPlay ? t('railControls.play') : t('railControls.addSpecsFirst')
        }
      >
        {status === 'running' ? (
          <Square className="w-3.5 h-3.5 fill-current" />
        ) : status === 'failed' ? (
          <AlertTriangle className="w-3.5 h-3.5" />
        ) : (
          <Play className="w-3.5 h-3.5 fill-current" />
        )}
      </Button>
      </span>
    </div>
  )
}
