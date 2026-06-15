import { Play, Square, AlertTriangle, ScrollText } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { FEATURE_INTERACTIVE_JOBS } from '../lib/feature-flags'

export type RailMode = 'implement' | 'batch-implement' | 'ultracode'
export type RailStatus = 'idle' | 'running' | 'failed'

interface RailControlsProps {
  mode: RailMode
  status: RailStatus
  activeJobId?: string
  ticketCount: number
  /** When true, show the Claude-only Ultracode segment. Ultracode bypasses
   *  the OpenSpec pipeline and lets Claude implement the spec autonomously. */
  ultracodeAvailable?: boolean
  /** Per-rail "Interactive" toggle state (ultracode only). When checked, the
   *  launched job becomes a persistent chat session with a Finalize button. */
  interactive?: boolean
  /** Whether the interactive toggle should be offered (server feature flag). */
  interactiveAvailable?: boolean
  onModeChange: (mode: RailMode) => void
  onInteractiveChange?: (interactive: boolean) => void
  onToggle: () => void
}

export function RailControls({ mode, status, activeJobId, ticketCount, ultracodeAvailable, interactive, interactiveAvailable, onModeChange, onInteractiveChange, onToggle }: RailControlsProps) {
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

      {/* Mode segmented control */}
      <div className="flex items-center rounded-md border border-border/40 bg-muted/20 overflow-hidden text-[10px]">
        <button
          type="button"
          className={`px-2 py-0.5 transition-colors ${
            mode === 'implement'
              ? 'bg-primary/15 text-primary font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
          }`}
          onClick={() => onModeChange('implement')}
        >
          {t('railControls.implement')}
        </button>
        <div className="w-px h-3 bg-border/40 shrink-0" />
        <button
          type="button"
          className={`px-2 py-0.5 transition-colors ${
            mode === 'batch-implement'
              ? 'bg-primary/15 text-primary font-medium'
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
          }`}
          onClick={() => onModeChange('batch-implement')}
        >
          {t('railControls.batch')}
        </button>
        {ultracodeAvailable && (
          <>
            <div className="w-px h-3 bg-border/40 shrink-0" />
            <button
              type="button"
              className={`px-2 py-0.5 transition-colors ${
                mode === 'ultracode'
                  ? 'bg-accent-highlight/20 text-accent-highlight font-semibold'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/30'
              }`}
              onClick={() => onModeChange('ultracode')}
              title={t('railControls.ultraTitle')}
            >
              {t('railControls.ultra')}
            </button>
          </>
        )}
      </div>

      {/* Interactive toggle — ultracode only, when the feature is on and the
          rail is idle (mode is fixed once a job is running). */}
      {mode === 'ultracode' && ultracodeAvailable && (interactiveAvailable ?? FEATURE_INTERACTIVE_JOBS) && status !== 'running' && (
        <button
          type="button"
          role="switch"
          aria-checked={interactive ? 'true' : 'false'}
          onClick={() => onInteractiveChange?.(!interactive)}
          title={t('railControls.interactiveTitle')}
          className={`px-2 py-0.5 rounded-md border text-[10px] font-semibold transition-colors ${
            interactive
              ? 'border-accent-highlight/50 bg-accent-highlight/20 text-accent-highlight'
              : 'border-border/40 bg-muted/20 text-muted-foreground hover:text-foreground hover:bg-muted/30'
          }`}
        >
          {t('railControls.interactive')}
        </button>
      )}

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
