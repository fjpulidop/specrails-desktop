import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Compass, Pencil, Plus, X } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { normalizeSpecIntent, openIntentQuestions, type SpecIntent, type SpecIntentQuestion } from '../lib/spec-intent'

/**
 * Intent (intent-mode): what problem the spec solves, the outcome sought, how
 * we will know, who and what it affects, the constraints and the open
 * questions — never the solution. Shown above the description and edited in
 * place. Controlled: the modal owns the value and saves it with the ticket;
 * `null` means the spec has no intent.
 */

interface IntentSectionProps {
  value: SpecIntent | null
  onChange: (next: SpecIntent | null) => void
  disabled?: boolean
}

interface IntentDraft {
  problem: string
  outcome: string
  hypothesis: string
  successSignals: string
  affects: string
  constraints: string
  openQuestions: SpecIntentQuestion[]
}

const lines = (text: string): string[] => text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.trim()).filter(Boolean)

function toDraft(intent: SpecIntent | null): IntentDraft {
  return {
    problem: intent?.problem ?? '',
    outcome: intent?.outcome ?? '',
    hypothesis: intent?.hypothesis ?? '',
    successSignals: (intent?.successSignals ?? []).join('\n'),
    affects: (intent?.affects ?? []).join('\n'),
    constraints: (intent?.constraints ?? []).join('\n'),
    openQuestions: (intent?.openQuestions ?? []).map((item) => ({ ...item })),
  }
}

function fromDraft(draft: IntentDraft): SpecIntent | null {
  return normalizeSpecIntent({
    problem: draft.problem,
    outcome: draft.outcome,
    hypothesis: draft.hypothesis,
    successSignals: lines(draft.successSignals),
    affects: lines(draft.affects),
    constraints: lines(draft.constraints),
    openQuestions: draft.openQuestions,
  })
}

const FIELD_CLASS = 'w-full rounded-lg border border-border bg-input px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground resize-y'

export function IntentSection({ value, onChange, disabled }: IntentSectionProps) {
  const { t } = useTranslation('tickets')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<IntentDraft>(() => toDraft(value))
  const [showErrors, setShowErrors] = useState(false)
  const problemRef = useRef<HTMLTextAreaElement>(null)
  const id = useId()

  useEffect(() => {
    if (!editing) setDraft(toDraft(value))
  }, [value, editing])

  useEffect(() => {
    if (editing) problemRef.current?.focus()
  }, [editing])

  const missingProblem = !draft.problem.trim()
  const missingOutcome = !draft.outcome.trim()
  const blank = missingProblem && missingOutcome && !draft.hypothesis.trim() && !lines(draft.successSignals).length
    && !lines(draft.affects).length && !lines(draft.constraints).length && !draft.openQuestions.some((item) => item.question.trim())

  const finish = () => {
    // An emptied intent clears the field; a partial one must name problem and outcome.
    if (blank) { onChange(null); setEditing(false); setShowErrors(false); return }
    if (missingProblem || missingOutcome) { setShowErrors(true); return }
    onChange(fromDraft(draft))
    setEditing(false)
    setShowErrors(false)
  }

  const cancel = () => { setDraft(toDraft(value)); setEditing(false); setShowErrors(false) }
  const set = (key: keyof Omit<IntentDraft, 'openQuestions'>) => (event: React.ChangeEvent<HTMLTextAreaElement>) =>
    setDraft((current) => ({ ...current, [key]: event.target.value }))
  const setQuestion = (index: number, patch: Partial<SpecIntentQuestion>) =>
    setDraft((current) => ({ ...current, openQuestions: current.openQuestions.map((item, i) => (i === index ? { ...item, ...patch } : item)) }))
  const open = openIntentQuestions(value)

  return (
    <section data-testid="ticket-intent" aria-labelledby={`${id}-heading`}>
      <div className="flex items-center justify-between mb-1.5">
        <span id={`${id}-heading`} className="text-label text-muted-foreground flex items-center gap-1.5">
          <Compass className="w-3 h-3" aria-hidden="true" />
          {t('intent.title')}
          {!editing && open > 0 && (
            <span className="rounded-full bg-accent-info/15 px-1.5 text-caption text-accent-info" data-testid="ticket-intent-open">
              {t('intent.openCount', { count: open })}
            </span>
          )}
        </span>
        {!editing && value && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => setEditing(true)}
            className="text-caption text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1 disabled:opacity-50"
          >
            <Pencil className="w-2.5 h-2.5" />
            {t('common:actions.edit')}
          </button>
        )}
      </div>

      {editing ? (
        <div
          className="space-y-2.5 rounded-lg border border-border/60 bg-muted/10 p-3"
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); finish() } }}
        >
          <p className="text-caption text-muted-foreground">{t('intent.editorHint')}</p>
          <IntentField id={`${id}-problem`} label={t('intent.problem')} error={showErrors && missingProblem ? t('intent.required') : null}>
            <textarea ref={problemRef} id={`${id}-problem`} value={draft.problem} onChange={set('problem')} rows={3}
              placeholder={t('intent.problemPlaceholder')} className={FIELD_CLASS} aria-invalid={showErrors && missingProblem}
              aria-required="true" aria-describedby={showErrors && missingProblem ? `${id}-problem-error` : undefined} />
          </IntentField>
          <IntentField id={`${id}-outcome`} label={t('intent.outcome')} error={showErrors && missingOutcome ? t('intent.required') : null}>
            <textarea id={`${id}-outcome`} value={draft.outcome} onChange={set('outcome')} rows={2}
              placeholder={t('intent.outcomePlaceholder')} className={FIELD_CLASS} aria-invalid={showErrors && missingOutcome}
              aria-required="true" aria-describedby={showErrors && missingOutcome ? `${id}-outcome-error` : undefined} />
          </IntentField>
          <IntentField id={`${id}-hypothesis`} label={t('intent.hypothesis')}>
            <textarea id={`${id}-hypothesis`} value={draft.hypothesis} onChange={set('hypothesis')} rows={2}
              placeholder={t('intent.hypothesisPlaceholder')} className={FIELD_CLASS} />
          </IntentField>
          <IntentField id={`${id}-signals`} label={t('intent.successSignals')} hint={t('intent.onePerLine')}>
            <textarea id={`${id}-signals`} value={draft.successSignals} onChange={set('successSignals')} rows={3}
              placeholder={t('intent.successSignalsPlaceholder')} className={FIELD_CLASS} />
          </IntentField>
          <IntentField id={`${id}-affects`} label={t('intent.affects')} hint={t('intent.onePerLine')}>
            <textarea id={`${id}-affects`} value={draft.affects} onChange={set('affects')} rows={2}
              placeholder={t('intent.affectsPlaceholder')} className={FIELD_CLASS} />
          </IntentField>
          <IntentField id={`${id}-constraints`} label={t('intent.constraints')} hint={t('intent.onePerLine')}>
            <textarea id={`${id}-constraints`} value={draft.constraints} onChange={set('constraints')} rows={2}
              placeholder={t('intent.constraintsPlaceholder')} className={FIELD_CLASS} />
          </IntentField>
          <fieldset className="space-y-1.5">
            <legend className="text-caption font-medium text-foreground">{t('intent.openQuestions')}</legend>
            {draft.openQuestions.map((item, index) => (
              <div key={index} className="grid gap-1 rounded-md border border-border/40 p-2">
                <div className="flex items-center gap-1.5">
                  <input value={item.question} onChange={(event) => setQuestion(index, { question: event.target.value })}
                    aria-label={t('intent.questionLabel', { n: index + 1 })} placeholder={t('intent.questionPlaceholder')}
                    className="min-w-0 flex-1 rounded-md border border-border bg-input px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground" />
                  <button type="button" onClick={() => setDraft((current) => ({ ...current, openQuestions: current.openQuestions.filter((_, i) => i !== index) }))}
                    aria-label={t('intent.removeQuestion', { n: index + 1 })}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50">
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                  </button>
                </div>
                <input value={item.answer ?? ''} onChange={(event) => setQuestion(index, { answer: event.target.value || undefined })}
                  aria-label={t('intent.answerLabel', { n: index + 1 })} placeholder={t('intent.answerPlaceholder')}
                  className="rounded-md border border-border/60 bg-input px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground" />
              </div>
            ))}
            <Button type="button" variant="ghost" size="sm" className="h-6 text-caption"
              onClick={() => setDraft((current) => ({ ...current, openQuestions: [...current.openQuestions, { question: '' }] }))}>
              <Plus className="w-3 h-3" aria-hidden="true" />
              {t('intent.addQuestion')}
            </Button>
          </fieldset>
          <div className="flex items-center gap-1.5">
            <Button variant="ghost" size="sm" className="h-6 text-caption" onClick={finish}>{t('detailModal.doneEditing')}</Button>
            <Button variant="ghost" size="sm" className="h-6 text-caption text-muted-foreground" onClick={cancel}>{t('common:actions.cancel')}</Button>
          </div>
        </div>
      ) : value ? (
        <IntentView intent={value} />
      ) : (
        <button
          type="button"
          disabled={disabled}
          onClick={() => setEditing(true)}
          className="w-full rounded-lg border border-dashed border-border/40 bg-muted/10 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/20 transition-colors text-left disabled:opacity-50"
        >
          {t('intent.add')}
        </button>
      )}
    </section>
  )
}

function IntentField({ id, label, hint, error, children }: { id: string; label: string; hint?: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-caption font-medium text-foreground">
        {label}
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
      </label>
      {children}
      {error && <p id={`${id}-error`} role="alert" className="text-caption text-destructive">{error}</p>}
    </div>
  )
}

/** Read-only intent: problem and outcome first, then the lists that exist. */
export function IntentView({ intent }: { intent: SpecIntent }) {
  const { t } = useTranslation('tickets')
  const list = (title: string, items: string[], testId: string) => items.length > 0 && (
    <div data-testid={testId}>
      <h4 className="text-caption font-medium text-muted-foreground">{title}</h4>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="flex items-start gap-2 text-xs text-foreground">
            <span aria-hidden="true" className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span className="min-w-0 break-words">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
  return (
    <div className="space-y-2.5 rounded-lg border border-border/40 bg-muted/10 px-3 py-2.5">
      <div>
        <h4 className="text-caption font-medium text-muted-foreground">{t('intent.problem')}</h4>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground">{intent.problem}</p>
      </div>
      <div>
        <h4 className="text-caption font-medium text-muted-foreground">{t('intent.outcome')}</h4>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-foreground">{intent.outcome}</p>
        {intent.hypothesis && <p className="mt-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">{intent.hypothesis}</p>}
      </div>
      {list(t('intent.successSignals'), intent.successSignals, 'ticket-intent-signals')}
      {list(t('intent.affects'), intent.affects, 'ticket-intent-affects')}
      {list(t('intent.constraints'), intent.constraints, 'ticket-intent-constraints')}
      {intent.openQuestions.length > 0 && (
        <div data-testid="ticket-intent-questions">
          <h4 className="text-caption font-medium text-muted-foreground">{t('intent.openQuestions')}</h4>
          <ul className="mt-0.5 space-y-1">
            {intent.openQuestions.map((item) => (
              <li key={item.question} className="text-xs text-foreground">
                <span className="break-words">{item.question}</span>
                {item.answer
                  ? <p className="mt-0.5 break-words pl-3 text-muted-foreground">{item.answer}</p>
                  : <span className="ml-1.5 rounded bg-accent-info/10 px-1 text-caption text-accent-info">{t('intent.unanswered')}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
