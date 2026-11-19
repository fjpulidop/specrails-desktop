import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { CheckCircle2, Clock } from 'lucide-react'
import { Button } from '../ui/button'
import { RunStateGlyph } from '../ui/run-state/run-state-glyph'
import { cn } from '../../lib/utils'
import { notifyError } from '../../lib/notify-error'
import { announceRunQuestionAnswered, submitRunAnswer, type RunAnswer, type RunQuestion } from './run-question'

export interface RunQuestionCardProps {
  question: RunQuestion
  projectId: string
  /** The run's job / loop-run id. */
  runId: string
  /** "Implement #12": which run asks (omitted where the surface already names it). */
  runLabel?: string | null
  /** The project's name, on surfaces that list several projects. */
  projectName?: string | null
  /** 1: a legacy runtime execution. */
  engine?: 1 | 2
  /** `compact`: inside a row that is already a card (inbox, live board, mission card), so no card chrome of its own; the run window uses the full card. */
  density?: 'compact' | 'full'
  /** After the server accepted the answer. */
  onAnswered?: (answer: RunAnswer) => void
  className?: string
  /** Focuses the first control when it mounts (the run window opened straight to the question). */
  autoFocus?: boolean
}

/** Long questions fold after this many characters; the person can unfold them. */
const FOLD_AT = 420

/**
 * The one question card: who asks, the question, its choices (each with what it
 * means; the recommended one marked), "Other answer…", and what happens next.
 * An approval offers Approve and, when Core allows it, Reject with a reason.
 * Identical on every surface; answers inline and confirms in place.
 */
export function RunQuestionCard({ question, projectId, runId, runLabel, projectName, engine = 2, density = 'full', onAnswered, className, autoFocus }: RunQuestionCardProps) {
  const { t } = useTranslation(['common', 'loops'])
  const [mode, setMode] = useState<'choose' | 'other' | 'reject'>(question.options.length || question.kind === 'approval' ? 'choose' : 'other')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState<string | null>(null)
  const [sent, setSent] = useState<RunAnswer | null>(null)
  const [expanded, setExpanded] = useState(false)
  const firstControl = useRef<HTMLButtonElement | HTMLTextAreaElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const headingId = useId()
  const compact = density === 'compact'

  // A new question (the run asked again) starts from a clean card.
  useEffect(() => {
    setMode(question.options.length || question.kind === 'approval' ? 'choose' : 'other')
    setDraft(''); setSent(null); setExpanded(false)
  }, [question.interruptId, question.text, question.kind, question.options.length])
  useEffect(() => { if (autoFocus) firstControl.current?.focus() }, [autoFocus])
  useEffect(() => { if (mode !== 'choose') textareaRef.current?.focus() }, [mode])

  // What happens next, said once the server took the answer: a choice that ends the run says so.
  function confirmation(answer: RunAnswer): string {
    if (answer.type === 'approve') return t('runQuestion.approved')
    if (answer.type === 'reject') return t('runQuestion.rejected')
    return answer.type === 'option' && question.endsRun.includes(answer.optionId) ? t('runQuestion.sentEnds') : t('runQuestion.sent')
  }

  async function send(answer: RunAnswer, key: string): Promise<void> {
    if (sending || sent) return
    setSending(key)
    try {
      await submitRunAnswer({ projectId, runId, question, answer, engine })
      setSent(answer)
      // The confirmation also survives the surface dropping the answered question.
      toast.success(confirmation(answer))
      announceRunQuestionAnswered({ projectId, runId })
      onAnswered?.(answer)
    } catch (error) {
      notifyError(t('runQuestion.failed'), { detail: error instanceof Error && error.message ? error.message : undefined, retry: () => void send(answer, key) })
    } finally {
      setSending(null)
    }
  }

  if (sent) {
    const words = confirmation(sent)
    return (
      <div role="status" data-testid="run-question-sent" className={cn('flex items-center gap-2 rounded-card border border-accent-success/30 bg-accent-success/5 px-3 py-2 text-body text-foreground', className)}>
        <CheckCircle2 className="h-4 w-4 shrink-0 text-accent-success" aria-hidden />
        {words}
      </div>
    )
  }

  const isApproval = question.kind === 'approval'
  // A machine-wide install reads in the person's language: the tool, the exact command, Install / I'll do it myself.
  const install = question.install
  const installChoice = (id: string): id is 'install' | 'self' => !!install && (id === 'install' || id === 'self')
  // The planner's fixed last choice ("not in this repository") reads in the person's language too.
  const notHere = (id: string): boolean => question.asker === 'planner' && id === 'not-here'
  const labelOf = (option: RunQuestion['options'][number]): string => installChoice(option.id) ? t(`loops:core.machineInstall.${option.id}`) : notHere(option.id) ? t('runQuestion.notHere') : option.label
  const meaningOf = (option: RunQuestion['options'][number]): string | undefined => installChoice(option.id) ? t(`loops:core.machineInstall.${option.id}Meaning`) : notHere(option.id) ? t('runQuestion.notHereMeaning') : option.meaning
  const who = isApproval ? t('runQuestion.approval') : t(`runQuestion.asker.${question.asker}`)
  const fullText = install ? t('loops:core.machineInstall.question', { tool: install.tool }) : question.text
  const folded = !expanded && fullText.length > FOLD_AT
  const text = folded ? `${fullText.slice(0, FOLD_AT).trimEnd()}…` : fullText
  const ending = question.endsRun.map((id) => question.options.find((option) => option.id === id)).filter((option): option is RunQuestion['options'][number] => !!option).map(labelOf)
  const consequences = [
    t('runQuestion.consequence.waits'),
    ...(ending.length ? ending.map((label) => t('runQuestion.consequence.endsRunOption', { label }))
      : question.kind === 'question' && question.mayEndRun ? [t('runQuestion.consequence.mayEnd')] : []),
    ...(isApproval && question.canReject ? [t('runQuestion.consequence.reject')] : []),
    ...(install ? [t('loops:core.machineInstall.once')] : []),
  ]
  const where = [runLabel, projectName].filter((part): part is string => !!part).join(' · ')
  const textEntry = mode !== 'choose'
  const submitText = (): void => {
    const value = draft.trim()
    if (!value) return
    void send(mode === 'reject' ? { type: 'reject', reason: value } : { type: 'text', text: value }, mode)
  }

  return (
    <section
      aria-labelledby={headingId}
      data-testid="run-question-card"
      data-asker={question.asker}
      data-kind={question.kind}
      className={cn('space-y-3', compact ? '' : 'rounded-card border border-accent-primary/30 bg-card p-4', className)}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <header className="flex items-start gap-2">
        <RunStateGlyph state="needs-input" size="sm" className="mt-0.5" />
        <div className="min-w-0">
          <h3 id={headingId} className="text-strong text-foreground">{who}</h3>
          {where && <p className="truncate text-caption text-muted-foreground" data-testid="run-question-where">{where}</p>}
        </div>
      </header>

      <div className="space-y-1.5">
        <p className="whitespace-pre-wrap text-body text-foreground" data-testid="run-question-text">{text}</p>
        {fullText.length > FOLD_AT && (
          <button type="button" className="text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setExpanded((value) => !value)}>
            {expanded ? t('runQuestion.showLess') : t('runQuestion.showMore')}
          </button>
        )}
        {question.why && <p className="text-caption text-muted-foreground">{question.why}</p>}
        {question.detail && (
          <pre data-testid="run-question-detail" className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-control border border-border/60 bg-background px-2.5 py-1.5 font-mono text-caption text-foreground">{question.detail}</pre>
        )}
      </div>

      {!textEntry && question.options.length > 0 && (
        <ul className="space-y-1.5" aria-label={who}>
          {question.options.map((option, index) => {
            const recommended = option.id === question.recommended
            return (
              <li key={option.id}>
                <button
                  type="button"
                  ref={index === 0 ? (node) => { firstControl.current = node } : undefined}
                  data-testid="run-question-option"
                  data-option-id={option.id}
                  data-recommended={recommended || undefined}
                  disabled={!!sending}
                  onClick={() => void send({ type: 'option', optionId: option.id, label: labelOf(option) }, option.id)}
                  className={cn(
                    'flex w-full flex-col items-start gap-0.5 rounded-control border px-3 py-2 text-left transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
                    recommended ? 'border-accent-primary/50 bg-accent-primary/5 hover:bg-accent-primary/10' : 'border-border/60 bg-background hover:bg-accent',
                  )}
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="text-body font-medium text-foreground">{sending === option.id ? t('runQuestion.sending') : labelOf(option)}</span>
                    {recommended && <span className="rounded-pill border border-accent-primary/40 px-1.5 text-caption text-accent-primary">{t('runQuestion.recommended')}</span>}
                  </span>
                  {meaningOf(option) && <span className="text-caption text-muted-foreground">{meaningOf(option)}</span>}
                  {option.detail && <code className="mt-1 block w-full whitespace-pre-wrap break-all font-mono text-caption text-muted-foreground">{option.detail}</code>}
                </button>
              </li>
            )
          })}
        </ul>
      )}

      {!textEntry && isApproval && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" ref={(node) => { firstControl.current = node }} disabled={!!sending} data-testid="run-question-approve" onClick={() => void send({ type: 'approve' }, 'approve')}>
            {sending === 'approve' ? t('runQuestion.sending') : t('runQuestion.approve')}
          </Button>
          {question.canReject && (
            <Button size="sm" variant="outline" disabled={!!sending} data-testid="run-question-reject" onClick={() => setMode('reject')}>
              {t('runQuestion.reject')}
            </Button>
          )}
        </div>
      )}

      {textEntry && (
        <div className="space-y-2">
          <label className="block space-y-1">
            <span className="text-label text-foreground">{mode === 'reject' ? t('runQuestion.rejectLabel') : t('runQuestion.otherLabel')}</span>
            <textarea
              ref={(node) => { textareaRef.current = node; if (!question.options.length && !isApproval) firstControl.current = node }}
              value={draft}
              maxLength={20000}
              rows={compact ? 2 : 3}
              data-testid="run-question-input"
              placeholder={mode === 'reject' ? t('runQuestion.rejectPlaceholder') : t('runQuestion.otherPlaceholder')}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                // Cmd/Ctrl+Enter sends; Enter alone keeps writing (answers are often several lines).
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); submitText() }
              }}
              className="w-full resize-y rounded-control border border-input bg-background px-2.5 py-1.5 text-body text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={mode === 'reject' ? 'destructive' : 'default'} disabled={!draft.trim() || !!sending} data-testid="run-question-send" onClick={submitText}>
              {sending ? t('runQuestion.sending') : mode === 'reject' ? t('runQuestion.reject') : t('runQuestion.answer')}
            </Button>
            {(question.options.length > 0 || isApproval) && (
              <Button size="sm" variant="ghost" disabled={!!sending} onClick={() => { setMode('choose'); setDraft('') }}>
                {t('runQuestion.back')}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* An install is Install or I'll do it myself; any other question also takes the person's own words. */}
      {!textEntry && !isApproval && !install && question.options.length > 0 && (
        <button type="button" data-testid="run-question-other" disabled={!!sending} className="text-caption text-muted-foreground underline-offset-2 hover:text-foreground hover:underline" onClick={() => setMode('other')}>
          {t('runQuestion.other')}
        </button>
      )}

      <ul className="space-y-0.5 border-t border-border/40 pt-2" data-testid="run-question-consequence">
        {consequences.map((line, index) => (
          <li key={line} className="flex items-start gap-1.5 text-caption text-muted-foreground">
            {index === 0 ? <Clock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden /> : <span className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />}
            {line}
          </li>
        ))}
      </ul>
    </section>
  )
}
