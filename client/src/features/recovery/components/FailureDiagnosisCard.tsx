import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Cable, Check, CircleHelp, ClipboardCheck, CloudOff, Copy, FilePenLine, Gauge, ListChecks, OctagonAlert, Play, RotateCcw, ScrollText, Sparkles, TimerOff, Unplug, Wrench, XCircle, type LucideIcon } from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { OverflowActions } from '../../../components/ui/overflow-actions'
import { EnvironmentPlanOffer } from './EnvironmentPlanOffer'
import { cn } from '../../../lib/utils'
import { formatResetTime } from '../../provider-quota/lib/format-reset'
import { modelLabel } from '../../../lib/model-label'
import type { FailureAnalysisState } from '../hooks/useFailureAnalysis'
import {
  availableRemedies, consequenceKey, headlineKey, humanizePhase, offersStartOver, recordedStepError, whyKey,
  type FailureDiagnosis, type RemedyHandler, type RemedyHandlers, type RemedyId,
} from '../lib/failure-diagnosis'

type Tone = 'failed' | 'caution' | 'neutral'

/** Kind → icon and lamp (failures are tomato, things the host can unblock are amber, an unknown cause claims no lamp). */
const KIND_LOOK: Record<FailureDiagnosis['kind'], { icon: LucideIcon; tone: Tone }> = {
  tests_failed: { icon: XCircle, tone: 'failed' },
  provider_limit: { icon: Gauge, tone: 'caution' },
  provider_unavailable: { icon: CloudOff, tone: 'caution' },
  environment: { icon: Wrench, tone: 'caution' },
  port_in_use: { icon: Cable, tone: 'caution' },
  blocked: { icon: OctagonAlert, tone: 'caution' },
  timeout: { icon: TimerOff, tone: 'caution' },
  tool_inactivity: { icon: TimerOff, tone: 'caution' },
  crash: { icon: Unplug, tone: 'failed' },
  incomplete_tasks: { icon: ListChecks, tone: 'caution' },
  spec_invalid: { icon: FilePenLine, tone: 'failed' },
  workflow_protocol: { icon: ListChecks, tone: 'caution' },
  unknown: { icon: CircleHelp, tone: 'neutral' },
}

const TONE_CLASS: Record<Tone, { box: string; icon: string }> = {
  failed: { box: 'border-destructive/40 bg-destructive/5', icon: 'text-destructive' },
  caution: { box: 'border-accent-warning/40 bg-accent-warning/5', icon: 'text-accent-warning' },
  neutral: { box: 'border-border/60 bg-card/40', icon: 'text-muted-foreground' },
}

const REMEDY_ICON: Record<RemedyId, LucideIcon> = {
  continue: Play,
  retry: RotateCcw,
  'edit-spec': FilePenLine,
  'fix-environment': Wrench,
  'open-logs': ScrollText,
  'continue-to-review': ClipboardCheck,
}

/** One remedy as the person sees it: a button and, under it, what it does to their work. */
export interface RemedyView {
  id: string
  label: string
  icon: LucideIcon
  consequence: string
  handler: RemedyHandler
  primary: boolean
  expanded?: boolean
  onClick?: () => void
}

/**
 * The remedies of a failed or stopped run: each button with its one-line
 * consequence under it, and "Start over" apart in a menu with its warning
 * (it does not carry this attempt's work over).
 */
export function RemedyActions({ remedies, startOver, lead }: { remedies: readonly RemedyView[]; startOver?: RemedyHandler | null; lead?: ReactNode }) {
  const { t } = useTranslation('recovery')
  if (remedies.length === 0 && !startOver && !lead) return null
  return (
    <div role="group" aria-label={t('remedies.label')} className="flex flex-wrap items-start gap-x-3 gap-y-2" data-testid="failure-remedies">
      {lead}
      {remedies.map((remedy) => {
        const Icon = remedy.icon
        const busy = !!remedy.handler.busy
        const consequenceId = `remedy-consequence-${remedy.id}`
        return (
          <div key={remedy.id} className="flex max-w-[17rem] flex-col items-start gap-1">
            <Button
              type="button"
              size="sm"
              variant={remedy.primary ? 'default' : 'outline'}
              data-testid={`failure-remedy-${remedy.id}`}
              data-primary={remedy.primary ? '' : undefined}
              disabled={busy || remedy.handler.disabled}
              aria-busy={busy || undefined}
              aria-expanded={remedy.expanded}
              aria-describedby={consequenceId}
              onClick={() => (remedy.onClick ? remedy.onClick() : remedy.handler.run())}
            >
              <Icon className="mr-1 h-3 w-3" aria-hidden />
              {remedy.label}
            </Button>
            <span id={consequenceId} className="text-caption text-muted-foreground" data-testid={`failure-remedy-consequence-${remedy.id}`}>{remedy.consequence}</span>
          </div>
        )
      })}
      {startOver && (
        <OverflowActions
          label={t('remedies.more')}
          testId="failure-remedy-more"
          className="mt-0.5"
          items={[{ id: 'start-over', testId: 'failure-remedy-retry', label: t('remedy.retry'), hint: t('consequence.retry'), icon: <RotateCcw className="h-3 w-3" />, onSelect: () => startOver.run(), disabled: startOver.busy || startOver.disabled }]}
        />
      )}
    </div>
  )
}

/** `fix-environment` → `fixEnvironment`: the remedy's i18n key. */
const remedyKey = (id: RemedyId): string => id.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())

/** The headline and the "why" line as plain words, shared by the card and the inbox row. */
export function useDiagnosisText(diagnosis: FailureDiagnosis): { headline: string; why: string | null; phaseName(id: string): string } {
  const { t, i18n } = useTranslation('recovery')
  const { t: tRuntime } = useTranslation('agentRuntime')
  // Core's step ids are role names (`reviewer`, `fixer`); anything else is made readable.
  const phaseName = (id: string): string => tRuntime(`roles.${id}`, { defaultValue: humanizePhase(id) ?? id })
  const head = headlineKey(diagnosis, diagnosis.phase ? phaseName(diagnosis.phase) : null)
  const why = whyKey(diagnosis)
  const whyParams = why && typeof why.params.resetsAt === 'string' ? { ...why.params, time: formatResetTime(why.params.resetsAt, i18n.language) }
    // A model slug (`haiku`) reads as its product name.
    : why && typeof why.params.model === 'string' ? { ...why.params, model: modelLabel(why.params.model).text || why.params.model }
      : why?.params
  const headParams = typeof head.params.role === 'string' ? { ...head.params, role: phaseName(head.params.role) } : head.params
  return { headline: t(head.key, headParams), why: why ? t(why.key, whyParams) : null, phaseName }
}

function EnvironmentPanel({ diagnosis }: { diagnosis: FailureDiagnosis }) {
  const { t } = useTranslation('recovery')
  const [copied, setCopied] = useState(false)
  const blocker = diagnosis.blocker
  const command = blocker ? [blocker.command, ...blocker.args].filter(Boolean).join(' ') : ''
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard unavailable: the command stays visible */ }
  }
  return (
    <div data-testid="failure-environment" className="space-y-1.5 rounded-control border border-border/50 bg-background/40 px-3 py-2 text-body">
      {blocker ? (
        <>
          <p className="text-foreground">{blocker.reason}</p>
          {command && (
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-caption font-semibold text-muted-foreground">{t('environment.command')}</span>
                <button
                  type="button"
                  onClick={() => void copy()}
                  aria-label={t('environment.copy')}
                  title={t('environment.copy')}
                  className="cursor-pointer rounded-control p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary/50"
                >
                  {copied ? <Check className="h-3 w-3 text-accent-success" aria-hidden /> : <Copy className="h-3 w-3" aria-hidden />}
                </button>
                {copied && <span role="status" className="text-caption text-accent-success">{t('environment.copied')}</span>}
              </div>
              <pre className="mt-0.5 whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-foreground">{command}{blocker.cwd ? `  # ${t('environment.inDirectory', { cwd: blocker.cwd })}` : ''}</pre>
            </div>
          )}
          <p><span className="font-medium">{t('environment.requiredAction')}:</span> {blocker.requiredAction}</p>
        </>
      ) : (
        <p className="text-foreground">{diagnosis.detail ?? t('environment.generic')}</p>
      )}
      <p className="text-caption text-muted-foreground">{t('environment.then')}</p>
    </div>
  )
}

/** What is known about where the run failed; anything unknown stays out. */
export interface FailureFacts {
  step?: string | null
  attempt?: number | null
  iteration?: number | null
  /** ISO timestamp of the failure. */
  at?: string | null
}

function FactsRow({ facts, step }: { facts: FailureFacts; step: string | null }) {
  const { t, i18n } = useTranslation('recovery')
  const at = facts.at ? new Date(facts.at) : null
  const time = at && !Number.isNaN(at.getTime())
    ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'short', timeStyle: 'medium' }).format(at)
    : null
  const items: Array<[string, string]> = []
  if (step) items.push([t('facts.step'), step])
  if (facts.attempt != null) items.push([t('facts.attempt'), String(facts.attempt)])
  if (facts.iteration != null) items.push([t('facts.iteration'), String(facts.iteration)])
  if (time) items.push([t('facts.time'), time])
  if (items.length === 0) return null
  return (
    <dl data-testid="failure-facts" aria-label={t('facts.label')} className="flex flex-wrap gap-x-4 gap-y-1 text-caption">
      {items.map(([term, value]) => (
        <div key={term} className="flex items-baseline gap-1.5">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="text-foreground num">{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export interface FailureDiagnosisCardProps {
  diagnosis: FailureDiagnosis
  /** What this surface can really run. A remedy without a handler is not offered. */
  handlers: RemedyHandlers
  /** Raw tail of the log, shown only when the cause is unknown. */
  logTail?: readonly string[]
  /** Where and when the run failed, from the run's own records. */
  facts?: FailureFacts
  /** The AI reading of the same run. When the app's own records name no cause, the card leads
   *  with the AI's (labelled as such) or offers to ask for one, instead of an unexplained unknown. */
  ai?: { state: FailureAnalysisState; run(): void }
  className?: string
}

/**
 * The diagnosis card at the top of a failed or blocked run: what failed in
 * plain words, why when it is known, and up to three ranked remedies that map
 * to actions the app already has. An unknown cause says so and shows the raw
 * log tail instead of guessing.
 */
export function FailureDiagnosisCard({ diagnosis, handlers, logTail = [], facts, ai, className }: FailureDiagnosisCardProps) {
  const { t } = useTranslation('recovery')
  const headingId = useId()
  const [envOpen, setEnvOpen] = useState(false)
  const { headline, why, phaseName } = useDiagnosisText(diagnosis)
  const remedies = availableRemedies(diagnosis, handlers)
  // An unknown cause with the runtime's own record of the failed step is not
  // a mystery: say which step failed and the runtime's words for why.
  const recorded = diagnosis.kind === 'unknown' ? recordedStepError(logTail) : null
  const unknown = diagnosis.kind === 'unknown' && !recorded
  const aiReady = unknown && ai?.state.status === 'ready' ? ai.state.analysis : null
  const aiBusy = unknown && !aiReady && (ai?.state.status === 'running' || ai?.state.status === 'loading')
  // A recorded step failure is a failure, whatever the classifier could not name.
  const look = recorded ? { icon: XCircle, tone: 'failed' as Tone } : KIND_LOOK[diagnosis.kind]
  const tone = TONE_CLASS[look.tone]
  const Icon = look.icon
  const factStep = recorded ? phaseName(recorded.step) : facts?.step ? phaseName(facts.step) : diagnosis.phase ? phaseName(diagnosis.phase) : null
  const label = (id: RemedyId): string => {
    if (id === 'continue') return diagnosis.resumablePhase ? t('remedy.continueFrom', { phase: phaseName(diagnosis.resumablePhase) }) : t('remedy.continue')
    return t(`remedy.${remedyKey(id)}`)
  }
  const analyzeLeads = unknown && !aiReady && !!ai
  const views: RemedyView[] = remedies.map((id, index) => {
    const handler = handlers[id] ?? { run: () => {} }
    return {
      id, label: label(id), icon: REMEDY_ICON[id], consequence: t(consequenceKey(id, diagnosis)), handler,
      primary: index === 0 && !analyzeLeads,
      ...(id === 'fix-environment' ? { expanded: envOpen, onClick: () => setEnvOpen((open) => !open) } : {}),
    }
  })
  const startOver = offersStartOver(diagnosis, handlers) ? handlers.retry! : null
  return (
    <section
      role="region"
      aria-labelledby={headingId}
      data-testid="failure-diagnosis-card"
      data-kind={diagnosis.kind}
      data-confidence={diagnosis.confidence}
      data-tone={look.tone}
      className={cn('space-y-2.5 rounded-card border px-3.5 py-3', tone.box, className)}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone.icon)} aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          {aiReady && (
            <p className="inline-flex items-center gap-1 text-caption font-medium text-accent-primary" data-testid="failure-ai-label">
              <Sparkles className="h-3 w-3" aria-hidden />{t('ai.label')}
            </p>
          )}
          <p id={headingId} className="text-strong text-foreground" data-testid="failure-headline">{recorded ? t('headline.stepFailed', { phase: phaseName(recorded.step) }) : aiReady ? aiReady.headline : headline}</p>
          {recorded && <p className="text-body text-foreground break-words" data-testid="failure-recorded-error">{recorded.reason}</p>}
          {aiReady && <p className="text-body text-foreground break-words" data-testid="failure-ai-cause">{aiReady.cause}</p>}
          {aiBusy && <p role="status" className="text-body text-muted-foreground" data-testid="failure-ai-running">{t('ai.running')}</p>}
          {unknown && !aiReady && !aiBusy && <p className="text-body text-muted-foreground" data-testid="failure-unknown-why">{t('why.unknown')}</p>}
          {why && <p className="text-body text-muted-foreground" data-testid="failure-why">{why}</p>}
          {diagnosis.detail && diagnosis.kind !== 'unknown' && diagnosis.kind !== 'environment' && <p className="text-caption text-muted-foreground" data-testid="failure-detail">{diagnosis.detail}</p>}
          {facts && <div className="pt-1"><FactsRow facts={facts} step={factStep} /></div>}
        </div>
      </div>

      {diagnosis.kind === 'unknown' && logTail.length > 0 && (
        <details open={unknown || !!recorded} className="rounded-control border border-border/50 bg-background/40 px-3 py-2">
          <summary className="cursor-pointer text-caption font-medium text-muted-foreground">{t('logTail.title')}</summary>
          <pre data-testid="failure-log-tail" className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-foreground">{logTail.join('\n')}</pre>
        </details>
      )}

      {diagnosis.kind === 'incomplete_tasks' && diagnosis.incompleteTasks && diagnosis.incompleteTasks.length > 0 && (
        <div data-testid="failure-incomplete-tasks" className="rounded-control border border-border/50 bg-background/40 px-3 py-2">
          <p className="text-caption font-semibold text-muted-foreground">{t('incomplete.title')}</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-body text-foreground">
            {diagnosis.incompleteTasks.map((task) => <li key={task} className="break-words">{task}</li>)}
          </ul>
        </div>
      )}

      {envOpen && diagnosis.kind === 'environment' && <EnvironmentPanel diagnosis={diagnosis} />}

      {/* A remedy the host can apply itself (a venv for a pinned Python), where the cause can be the interpreter. */}
      {(diagnosis.kind === 'environment' || diagnosis.kind === 'tests_failed') && <EnvironmentPlanOffer />}

      <RemedyActions
        remedies={views}
        startOver={startOver}
        lead={analyzeLeads ? (
          <div className="flex max-w-[17rem] flex-col items-start gap-1">
            <Button type="button" size="sm" variant="default" data-testid="failure-remedy-analyze" data-primary="" disabled={aiBusy} aria-busy={aiBusy || undefined} onClick={() => ai!.run()}>
              <Sparkles className="mr-1 h-3 w-3" aria-hidden />
              {t('analysis.run')}
            </Button>
            <span className="text-caption text-muted-foreground">{t('consequence.analyze')}</span>
          </div>
        ) : null}
      />
    </section>
  )
}
