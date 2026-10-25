import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Film, Loader2, Play, RefreshCw } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import { launchFirstSpec } from '../lib/sample-api'
import type { SampleLaunch, SamplePreset } from '../lib/sample-model'
import type { AssembleStatus } from '../../jobs/hooks/useAssembleProgress'
import { SampleCostStatement } from './SampleCostStatement'

interface RunFirstSpecProps {
  projectId: string
  specId: number | null
  launch: SampleLaunch
  launched: boolean
  workspace: AssembleStatus
  onLaunched: () => void
  onRetryWorkspace: () => void
  onWatchRecording: () => void
  onRecheck: () => Promise<unknown>
}

/**
 * The single "Run the first spec" call to action, with its cost beside it. The
 * provider was validated before this is offered; when none is ready the same
 * place offers the recorded run instead of a run that would fail.
 */
export function RunFirstSpec({ projectId, specId, launch, launched, workspace, onLaunched, onRetryWorkspace, onWatchRecording, onRecheck }: RunFirstSpecProps) {
  const { t } = useTranslation('onboarding')
  const [choice, setChoice] = useState<'main' | 'local'>('main')
  const [state, setState] = useState<'idle' | 'launching' | 'error' | 'over_budget'>('idle')
  const [detail, setDetail] = useState<string | null>(null)
  const [rechecking, setRechecking] = useState(false)

  if (!launch.ready) {
    return (
      <div className="space-y-2" data-testid="sample-fallback">
        <p className="text-body text-muted-foreground">{t(launch.reason === 'not_signed_in' ? 'run.notSignedIn' : 'run.noProvider')}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={onWatchRecording} className="gap-1.5" data-testid="watch-recording">
            <Film className="size-3.5" aria-hidden />{t('run.watchRecording')}
          </Button>
          <Button size="sm" variant="ghost" disabled={rechecking} onClick={() => { setRechecking(true); void onRecheck().finally(() => setRechecking(false)) }} className="gap-1.5" data-testid="recheck-providers">
            <RefreshCw className={cn('size-3.5', rechecking && 'motion-safe:animate-spin')} aria-hidden />{t('run.recheck')}
          </Button>
        </div>
        <p className="text-caption text-muted-foreground">{t('run.recordingNote')}</p>
      </div>
    )
  }

  if (launched) {
    return <p className="text-body text-accent-success" role="status" data-testid="sample-launched">{t('run.started', { low: launch.estimate.minutes[0], high: launch.estimate.minutes[1] })}</p>
  }

  const preset: SamplePreset = choice === 'local' && launch.localPreset ? launch.localPreset : launch.preset
  const blocked = workspace === 'assembling'

  async function run() {
    if (specId === null) return
    setState('launching')
    setDetail(null)
    const outcome = await launchFirstSpec(projectId, specId, preset)
    if (outcome.ok) { setState('idle'); onLaunched(); return }
    setState(outcome.code === 'over_budget' ? 'over_budget' : 'error')
    setDetail(outcome.detail ?? null)
  }

  return (
    <div className="space-y-2.5" data-testid="sample-run">
      {launch.localPreset && (
        <div role="radiogroup" aria-label={t('run.engine')} className="flex flex-wrap gap-1.5">
          {([['main', launch.preset], ['local', launch.localPreset]] as const).map(([key, option]) => (
            <button
              key={key}
              type="button"
              role="radio"
              aria-checked={choice === key}
              onClick={() => setChoice(key)}
              data-testid={`sample-engine-${key}`}
              className={cn(
                'rounded-control border px-2 py-1 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                choice === key ? 'border-accent-primary/60 bg-accent-primary/10 text-foreground' : 'border-border/40 text-muted-foreground hover:text-foreground',
              )}
            >
              {t(key === 'local' ? 'run.engineLocal' : 'run.engineCloud', { provider: option.provider })}
            </button>
          ))}
        </div>
      )}
      <SampleCostStatement preset={preset} estimate={launch.estimate} />
      <Button onClick={() => { void run() }} disabled={state === 'launching' || blocked || specId === null} className="gap-1.5" data-testid="run-first-spec">
        {state === 'launching' ? <Loader2 className="size-3.5 motion-safe:animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />}
        {state === 'launching' ? t('run.launching') : t('run.cta')}
      </Button>
      {blocked && <p className="text-caption text-muted-foreground" role="status">{t('run.preparing')}</p>}
      {workspace === 'failed' && (
        <p className="text-caption text-destructive" role="alert">
          {t('run.workspaceFailed')}{' '}
          <button type="button" className="underline underline-offset-2" onClick={onRetryWorkspace}>{t('run.retryWorkspace')}</button>
        </p>
      )}
      {state === 'over_budget' && <p className="text-caption text-destructive" role="alert" data-testid="sample-run-error">{t('run.overBudget')}</p>}
      {state === 'error' && <p className="text-caption text-destructive" role="alert" data-testid="sample-run-error">{detail ? t('run.failedDetail', { detail }) : t('run.failed')}</p>}
    </div>
  )
}
