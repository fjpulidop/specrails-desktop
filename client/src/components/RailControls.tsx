import { Play, Square, AlertTriangle, ScrollText } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'

export type RailMode = 'implement' | 'batch-implement' | 'freestyle' | 'loop'
export type RailStatus = 'idle' | 'running' | 'failed'

interface RailControlsProps {
  mode: RailMode
  status: RailStatus
  activeJobId?: string
  ticketCount: number
  /** When true, show the Claude-only Freestyle segment. Freestyle bypasses
   *  the OpenSpec pipeline and lets Claude implement the spec autonomously. */
  freestyleAvailable?: boolean
  /** When true, show the "Loop" segment (runs a published global loop against
   *  the rail's specs). Gated by FEATURE_LOOPS_SECTION at the call site. */
  loopAvailable?: boolean
  onModeChange: (mode: RailMode) => void
  onToggle: () => void
}

export function RailControls({ status, activeJobId, ticketCount, onToggle }: RailControlsProps) {
  const { t } = useTranslation('dashboard')
  const navigate = useNavigate()
  const canPlay = ticketCount > 0
  return (
    <div className="flex items-center gap-1.5">
      {/* View Log button — visible only while running */}
      {status === 'running' && activeJobId && (
        <Button
          size="sm"
          variant="ghost"
          className="group h-6 px-2 gap-1 rounded-md border border-accent-info/20 bg-accent-info/5 text-[10px] font-semibold text-accent-info transition-all duration-200 hover:-translate-y-px hover:border-accent-info/50 hover:bg-accent-info/15 hover:text-accent-info hover:shadow-[0_0_14px_hsl(191_97%_77%/0.22)] active:translate-y-0 active:scale-[0.98]"
          onClick={() => navigate(`/jobs/${activeJobId}`)}
          title={t('railControls.viewJobLog')}
        >
          <ScrollText className="w-3 h-3 transition-transform duration-200 group-hover:scale-110" />
          <span>{t('railControls.log')}</span>
        </Button>
      )}

      {/* The rail's Loop picker (factory + custom loops) lives in RailRow and
          replaces the old mode segmented control — the chosen Loop derives the
          legacy `mode`. RailControls keeps Log / Play. (The old per-rail
          "Interactive" toggle is gone: Freestyle jobs are interactive by
          default whenever the feature is enabled.) */}

      {/* Play / Stop / Failed toggle */}
      <Button
        size="sm"
        variant="ghost"
        className={`h-5 w-5 p-0 rounded-full transition-all duration-200 ${
          status === 'running'
            ? 'text-red-400 aurora-light:text-destructive hover:text-red-300 aurora-light:hover:text-destructive hover:bg-red-400/10 aurora-light:hover:bg-destructive/10'
            : status === 'failed'
              ? 'text-amber-400 aurora-light:text-accent-warning hover:text-emerald-300 aurora-light:hover:text-accent-success hover:bg-emerald-400/10 aurora-light:hover:bg-accent-success/10'
              : canPlay
                ? 'text-emerald-400 aurora-light:text-accent-success hover:text-emerald-300 aurora-light:hover:text-accent-success hover:bg-emerald-400/10 aurora-light:hover:bg-accent-success/10'
                : 'text-muted-foreground/30 cursor-not-allowed'
        }`}
        onClick={onToggle}
        disabled={!canPlay && status !== 'running'}
        title={
          status === 'running' ? t('railControls.stop') :
          status === 'failed' ? t('railControls.failedRetry') :
          canPlay ? t('railControls.play') : t('railControls.addSpecsFirst')
        }
      >
        {status === 'running' ? (
          <Square className="w-2.5 h-2.5 fill-current" />
        ) : status === 'failed' ? (
          <AlertTriangle className="w-2.5 h-2.5" />
        ) : (
          <Play className="w-2.5 h-2.5 fill-current" />
        )}
      </Button>
    </div>
  )
}
