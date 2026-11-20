import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, TriangleAlert } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { RunQuestionOption } from '../../../components/run-question/RunQuestionOption'
import { cn } from '../../../lib/utils'
import type { RemedyHandler } from '../lib/failure-diagnosis'
import { continuesOnServer, KEEP_TRYING_ID, type ResolutionKind, type ResolutionOption } from '../lib/resolution'
import type { ResolutionActions } from '../hooks/useContinueRemedies'

/** The surface's own way to run the options that do not continue the run on the server. */
export type ClientResolutionHandlers = Partial<Record<Extract<ResolutionKind, 'edit-spec' | 'change-model' | 'start-over'>, RemedyHandler>>

export interface ResolutionOptionsProps {
  options: readonly ResolutionOption[]
  /** Continue with an option or an instruction; null where this surface cannot continue the run. */
  actions: ResolutionActions | null
  handlers?: ClientResolutionHandlers
  className?: string
}

const RISK_CLASS: Record<NonNullable<ResolutionOption['risk']>, string> = {
  low: 'border-accent-success/40 text-accent-success',
  medium: 'border-accent-warning/40 text-accent-warning',
  high: 'border-destructive/40 text-destructive',
}

const MAX_INSTRUCTION = 4000

/** Which options this surface can run: a Continue needs the run's actions, the rest their handler. */
export function runnableOptions(options: readonly ResolutionOption[], actions: ResolutionActions | null, handlers: ClientResolutionHandlers = {}): ResolutionOption[] {
  return options.filter((option) => (continuesOnServer(option.kind) ? !!actions : !!handlers[option.kind as keyof ClientResolutionHandlers]))
}

/**
 * The ways to resolve a failed run, picked with one click: each says what it
 * does and what may happen, the recommended one marked, with "Other
 * instruction…" for the person's own words. Same look as a run question.
 */
export function ResolutionOptions({ options, actions, handlers = {}, className }: ResolutionOptionsProps) {
  const { t } = useTranslation('recovery')
  const { t: tCommon } = useTranslation('common')
  const [mode, setMode] = useState<'choose' | 'other'>('choose')
  const [draft, setDraft] = useState('')
  const [chosen, setChosen] = useState<string | null>(null)
  const shown = runnableOptions(options, actions, handlers)
  if (shown.length === 0 && !actions) return null
  const busy = actions?.busy ?? null
  if (actions?.done && chosen) {
    return (
      <div role="status" data-testid="resolution-sent" className={cn('flex items-center gap-2 rounded-card border border-accent-success/30 bg-accent-success/5 px-3 py-2 text-body text-foreground', className)}>
        <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-success" aria-hidden />
        {chosen}
      </div>
    )
  }
  const pick = (option: ResolutionOption) => {
    if (continuesOnServer(option.kind)) {
      if (!actions) return
      setChosen(t('remedyResult.continuingWith', { label: option.label }))
      if (option.id === KEEP_TRYING_ID) actions.keepGoing(option.label)
      else actions.choose(option.id, option.label)
      return
    }
    handlers[option.kind as keyof ClientResolutionHandlers]?.run()
  }
  const submit = () => {
    const value = draft.trim()
    if (!value || !actions) return
    setChosen(t('remedyResult.continuingWithInstruction'))
    actions.instruct(value)
  }
  return (
    <section data-testid="resolution-options" aria-label={t('resolution.title')} className={cn('space-y-2', className)}>
      <div>
        <p className="text-label text-foreground">{t('resolution.title')}</p>
        <p className="text-caption text-muted-foreground">{t('resolution.intro')}</p>
      </div>
      {mode === 'choose' && (
        <ul className="space-y-1.5">
          {shown.map((option) => {
            const handler = continuesOnServer(option.kind) ? null : handlers[option.kind as keyof ClientResolutionHandlers]
            return (
              <li key={option.id}>
                <RunQuestionOption
                  testId="resolution-option"
                  optionId={option.id}
                  recommended={!!option.recommended}
                  recommendedLabel={t('resolution.recommended')}
                  label={busy === option.id || (busy === 'keep-going' && option.id === KEEP_TRYING_ID) ? t('resolution.sending') : option.label}
                  meaning={option.does}
                  badge={option.risk ? <span data-testid="resolution-risk" className={cn('rounded-pill border px-1.5 text-caption', RISK_CLASS[option.risk])}>{t(`resolution.risk.${option.risk}`)}</span> : null}
                  extra={(
                    <span className="flex items-start gap-1 text-caption text-muted-foreground" data-testid="resolution-consequence">
                      <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
                      <span><span className="font-medium">{t('resolution.whatMayHappen')}</span> {option.consequence}</span>
                    </span>
                  )}
                  disabled={!!busy || !!actions?.done || !!handler?.disabled || !!handler?.busy}
                  onClick={() => pick(option)}
                />
              </li>
            )
          })}
        </ul>
      )}
      {actions && mode === 'choose' && (
        <button type="button" data-testid="resolution-other" disabled={!!busy || actions.done} className="text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setMode('other')}>
          {t('resolution.other')}
        </button>
      )}
      {actions && mode === 'other' && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-label text-foreground">{t('resolution.otherLabel')}</span>
            <textarea
              autoFocus
              value={draft}
              maxLength={MAX_INSTRUCTION}
              rows={3}
              data-testid="resolution-input"
              placeholder={t('resolution.otherPlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submit() } }}
              className="w-full resize-y rounded-control border border-input bg-background px-2.5 py-1.5 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={!draft.trim() || !!busy} data-testid="resolution-send" onClick={submit}>
              {busy === 'instruction' ? t('resolution.sending') : t('resolution.send')}
            </Button>
            {shown.length > 0 && (
              <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => { setMode('choose'); setDraft('') }}>{tCommon('runQuestion.back')}</Button>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
