import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Check, CircleHelp, Copy, FilePenLine, Gauge, OctagonAlert, Play, RotateCcw, ScrollText, TimerOff, Unplug, Wrench, XCircle, type LucideIcon,
} from 'lucide-react'
import { Button } from '../../../components/ui/button'
import { cn } from '../../../lib/utils'
import {
  availableRemedies, headlineKey, humanizePhase, whyKey,
  type FailureDiagnosis, type RemedyHandlers, type RemedyId,
} from '../lib/failure-diagnosis'

type Tone = 'failed' | 'caution' | 'neutral'

/** Kind → icon and lamp (failures are tomato, things the host can unblock are amber, an unknown cause claims no lamp). */
const KIND_LOOK: Record<FailureDiagnosis['kind'], { icon: LucideIcon; tone: Tone }> = {
  tests_failed: { icon: XCircle, tone: 'failed' },
  provider_limit: { icon: Gauge, tone: 'caution' },
  environment: { icon: Wrench, tone: 'caution' },
  blocked: { icon: OctagonAlert, tone: 'caution' },
  timeout: { icon: TimerOff, tone: 'caution' },
  tool_inactivity: { icon: TimerOff, tone: 'caution' },
  crash: { icon: Unplug, tone: 'failed' },
  unknown: { icon: CircleHelp, tone: 'neutral' },
}

const TONE_CLASS: Record<Tone, { box: string; icon: string }> = {
  failed: { box: 'border-destructive/40 bg-destructive/5', icon: 'text-destructive' },
  caution: { box: 'border-accent-warning/40 bg-accent-warning/5', icon: 'text-accent-warning' },
  neutral: { box: 'border-border/60 bg-card/40', icon: 'text-muted-foreground' },
}

const REMEDY_ICON: Record<RemedyId, LucideIcon> = {
  resume: Play,
  retry: RotateCcw,
  'edit-spec': FilePenLine,
  'fix-environment': Wrench,
  'open-logs': ScrollText,
}

/** The headline and the "why" line as plain words, shared by the card and the inbox row. */
export function useDiagnosisText(diagnosis: FailureDiagnosis): { headline: string; why: string | null; phaseName(id: string): string } {
  const { t } = useTranslation('recovery')
  const { t: tRuntime } = useTranslation('agentRuntime')
  // Core's step ids are role names (`reviewer`, `fixer`); anything else is made readable.
  const phaseName = (id: string): string => tRuntime(`roles.${id}`, { defaultValue: humanizePhase(id) ?? id })
  const head = headlineKey(diagnosis, diagnosis.phase ? phaseName(diagnosis.phase) : null)
  const why = whyKey(diagnosis)
  return { headline: t(head.key, head.params), why: why ? t(why.key, why.params) : null, phaseName }
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

export interface FailureDiagnosisCardProps {
  diagnosis: FailureDiagnosis
  /** What this surface can really run. A remedy without a handler is not offered. */
  handlers: RemedyHandlers
  /** Raw tail of the log, shown only when the cause is unknown. */
  logTail?: readonly string[]
  className?: string
}

/**
 * The diagnosis card at the top of a failed or blocked run: what failed in
 * plain words, why when it is known, and up to three ranked remedies that map
 * to actions the app already has. An unknown cause says so and shows the raw
 * log tail instead of guessing.
 */
export function FailureDiagnosisCard({ diagnosis, handlers, logTail = [], className }: FailureDiagnosisCardProps) {
  const { t } = useTranslation('recovery')
  const headingId = useId()
  const [envOpen, setEnvOpen] = useState(false)
  const { headline, why, phaseName } = useDiagnosisText(diagnosis)
  const look = KIND_LOOK[diagnosis.kind]
  const tone = TONE_CLASS[look.tone]
  const Icon = look.icon
  const remedies = availableRemedies(diagnosis, handlers)
  const unknown = diagnosis.kind === 'unknown'
  const label = (id: RemedyId): string => {
    if (id === 'resume') return diagnosis.resumablePhase ? t('remedy.resumeFrom', { phase: phaseName(diagnosis.resumablePhase) }) : t('remedy.resume')
    return t(`remedy.${id === 'edit-spec' ? 'editSpec' : id === 'fix-environment' ? 'fixEnvironment' : id === 'open-logs' ? 'openLogs' : id}`)
  }
  return (
    <section
      role="region"
      aria-labelledby={headingId}
      data-testid="failure-diagnosis-card"
      data-kind={diagnosis.kind}
      data-confidence={diagnosis.confidence}
      className={cn('space-y-2.5 rounded-card border px-3.5 py-3', tone.box, className)}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone.icon)} aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p id={headingId} className="text-strong text-foreground" data-testid="failure-headline">{headline}</p>
          {unknown && <p className="text-body text-muted-foreground">{t('why.unknown')}</p>}
          {why && <p className="text-body text-muted-foreground" data-testid="failure-why">{why}</p>}
          {diagnosis.detail && !unknown && diagnosis.kind !== 'environment' && <p className="text-caption text-muted-foreground" data-testid="failure-detail">{diagnosis.detail}</p>}
        </div>
      </div>

      {unknown && logTail.length > 0 && (
        <details open className="rounded-control border border-border/50 bg-background/40 px-3 py-2">
          <summary className="cursor-pointer text-caption font-medium text-muted-foreground">{t('logTail.title')}</summary>
          <pre data-testid="failure-log-tail" className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-caption leading-relaxed text-foreground">{logTail.join('\n')}</pre>
        </details>
      )}

      {envOpen && diagnosis.kind === 'environment' && <EnvironmentPanel diagnosis={diagnosis} />}

      {remedies.length > 0 && (
        <div role="group" aria-label={t('remedies.label')} className="flex flex-wrap items-center gap-1.5">
          {remedies.map((id, index) => {
            const handler = handlers[id]
            const RemedyIcon = REMEDY_ICON[id]
            const busy = !!handler?.busy
            const isEnv = id === 'fix-environment'
            return (
              <Button
                key={id}
                type="button"
                size="sm"
                variant={index === 0 ? 'default' : 'outline'}
                data-testid={`failure-remedy-${id}`}
                data-primary={index === 0 ? '' : undefined}
                disabled={busy || handler?.disabled}
                aria-busy={busy || undefined}
                aria-expanded={isEnv ? envOpen : undefined}
                onClick={() => (isEnv ? setEnvOpen((open) => !open) : handler?.run())}
              >
                <RemedyIcon className="mr-1 h-3 w-3" aria-hidden />
                {label(id)}
              </Button>
            )
          })}
        </div>
      )}
    </section>
  )
}
