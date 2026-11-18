import { useTranslation } from 'react-i18next'
import { Gauge, RefreshCw, Sparkles } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { Skeleton } from '../../../components/ui/skeleton'
import { RailTrack } from '../../../components/brand/RailTrack'
import { cn } from '../../../lib/utils'
import { stepAction, useFailureAnalysis, type AnalysisAction, type AnalysisActionKind, type AnalysisCategory, type FailureAnalysisController } from '../hooks/useFailureAnalysis'
import type { RemedyHandler } from '../lib/failure-diagnosis'

export interface FailureAnalysisPanelProps {
  projectId?: string
  jobId: string
  /** Ask for an analysis on open when none is saved. Off when the provider is
   *  known to be out of quota: the call would hit the same limit. */
  auto: boolean
  /** What the deterministic card already says (headline, recorded error):
   *  an AI headline that only repeats it is left out. */
  known?: ReadonlyArray<string | null | undefined>
  /** A reading the surface already owns (shared with the diagnosis card); the panel then asks nothing itself. */
  controller?: FailureAnalysisController
  /** What this surface can really run; a next step that names one becomes its button, anything else stays advice. */
  actions?: Partial<Record<AnalysisActionKind, RemedyHandler>>
}

const normalise = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const significant = (value: string) => normalise(value).split(' ').filter(word => word.length > 3)

/** True when the AI headline adds nothing to what the card already says:
 *  the same sentence, one inside the other, or mostly the same words. */
export function repeatsKnown(headline: string, known: ReadonlyArray<string | null | undefined>): boolean {
  const head = normalise(headline)
  if (!head) return true
  const texts = known.filter((text): text is string => !!text && !!normalise(text))
  if (texts.some(text => { const other = normalise(text); return other === head || other.includes(head) || head.includes(other) })) return true
  const words = significant(headline)
  if (words.length === 0) return false
  const pool = new Set(texts.flatMap(significant))
  return words.filter(word => pool.has(word)).length / words.length >= 0.7
}

/**
 * The AI reading of why a failed run stopped, led by the cause and what to do;
 * the log lines it rests on (verbatim, checked by the server) stay one click
 * away. Shown beside the app's own diagnosis, labelled as an AI analysis.
 */
export function FailureAnalysisPanel({ projectId, jobId, auto, known = [], controller, actions = {} }: FailureAnalysisPanelProps) {
  const { t, i18n } = useTranslation('recovery')
  const own = useFailureAnalysis(projectId, jobId, i18n.language, { auto, enabled: !controller })
  const { state, run } = controller ?? own
  if (state.status === 'loading') {
    return (
      <div data-testid="failure-analysis" data-state="loading" className="space-y-2 rounded-card border border-border px-3.5 py-3">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    )
  }
  if (state.status === 'idle' || state.status === 'error') {
    return (
      <section data-testid="failure-analysis" data-state={state.status} className="flex flex-wrap items-center gap-2 rounded-card border border-dashed border-border px-3.5 py-2.5 text-body">
        <Sparkles className="h-4 w-4 shrink-0 text-accent-primary" aria-hidden />
        <p className="min-w-0 flex-1 text-muted-foreground">
          {state.status === 'error' ? (state.detail === 'interrupted' ? t('analysis.interrupted') : t('analysis.failed', { detail: state.detail ?? t('analysis.noDetail') })) : t('analysis.offer')}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void run()} data-testid="failure-analysis-run">
          <Sparkles className="mr-1 h-3 w-3" aria-hidden />
          {state.status === 'error' ? t('analysis.retry') : t('analysis.run')}
        </Button>
      </section>
    )
  }
  if (state.status === 'running') {
    return (
      <section data-testid="failure-analysis" data-state="running" role="status" className="space-y-2 rounded-card border border-border px-3.5 py-3 text-body text-muted-foreground">
        <span aria-hidden className="block w-24"><RailTrack running /></span>
        <p>{t('analysis.running')}</p>
      </section>
    )
  }

  const { analysis, provider, model, stale } = state
  const quota = analysis.category === 'provider_limit'
  const showHeadline = !repeatsKnown(analysis.headline, [...known, analysis.cause])
  return (
    <section
      data-testid="failure-analysis"
      data-state="ready"
      data-category={analysis.category}
      aria-label={t('analysis.title')}
      className={cn('space-y-2.5 rounded-card border px-3.5 py-3', quota ? 'border-accent-warning/40 bg-accent-warning/5' : 'border-border bg-card')}
    >
      <div className="flex items-start gap-2.5">
        {quota ? <Gauge className="mt-0.5 h-4 w-4 shrink-0 text-accent-warning" aria-hidden /> : <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent-primary" aria-hidden />}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
            <span className="font-medium">{t('analysis.title')}</span>
            <span className="rounded-full border border-border px-1.5">{t(`analysis.category.${categoryKey(analysis.category)}`)}</span>
            {analysis.failedStep && <span>{t('analysis.failedStep', { step: analysis.failedStep })}</span>}
          </p>
          {showHeadline && <p className="text-strong text-foreground" data-testid="failure-analysis-headline">{analysis.headline}</p>}
          <p className="text-body text-foreground" data-testid="failure-analysis-cause">{analysis.cause}</p>
        </div>
      </div>
      {analysis.nextSteps.length > 0 && (
        <div className="pl-6.5">
          <p className="mb-1 text-label text-foreground">{t('analysis.nextSteps')}</p>
          <ol className="list-decimal space-y-0.5 pl-5 text-body text-foreground">
            {analysis.nextSteps.map((step, index) => {
              const action = stepAction(analysis, index)
              const handler = action ? actions[action.kind] : undefined
              return (
                <li key={index}>
                  <span>{step}</span>
                  {action && handler && (
                    <Button type="button" size="sm" variant="outline" className="ml-2 h-6 px-2 align-middle" data-testid={`failure-analysis-action-${action.kind}`}
                      disabled={handler.busy || handler.disabled} aria-busy={handler.busy || undefined} onClick={() => handler.run()}>
                      {actionLabel(t, action)}
                    </Button>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      )}
      {analysis.evidence.length > 0 && (
        <details className="pl-6.5">
          <summary className="cursor-pointer text-caption font-medium text-muted-foreground hover:text-foreground">{t('analysis.evidence')}</summary>
          <pre data-testid="failure-analysis-evidence" className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border bg-background px-3 py-2 font-mono text-caption leading-relaxed text-foreground">{analysis.evidence.join('\n')}</pre>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        <span>{t('analysis.by', { model: model ? `${provider}/${model}` : provider })}</span>
        {stale && <span className="text-accent-warning">{t('analysis.stale')}</span>}
        <Button type="button" size="sm" variant="ghost" className="ml-auto h-6 px-2" onClick={() => void run(true)} data-testid="failure-analysis-regenerate">
          <RefreshCw className="mr-1 h-3 w-3" aria-hidden />{t('analysis.regenerate')}
        </Button>
      </div>
    </section>
  )
}

function actionLabel(t: (key: string, params?: Record<string, string>) => string, action: AnalysisAction): string {
  switch (action.kind) {
    case 'continue': return t('remedy.continue')
    case 'continue-to-review': return t('remedy.continueToReview')
    case 'edit-spec': return t('remedy.editSpec')
    case 'change-model': return action.role ? t('analysis.action.changeModelFor', { role: action.role }) : t('analysis.action.changeModel')
  }
}

function categoryKey(category: AnalysisCategory): string {
  return category.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase())
}
